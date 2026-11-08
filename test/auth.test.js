const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../server');
const { databaseFixture, login } = require('../test-support/database.cjs');

async function fixture(t) {
    const data = databaseFixture();
    const app = createApp({ databaseClient: data.database, scheduleService: {
        getTrainSchedulesWithFallback: async () => ({ trains: [], source: 'live', bookingAllowed: true })
    } });
    const server = app.listen(0, '127.0.0.1');
    t.after(() => { app.locals.dispose(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    await once(server, 'listening');
    return { ...data, base: `http://127.0.0.1:${server.address().port}` };
}

const post = (base, path, body, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});

test('login compares credentials on the server and does not return passwords', async t => {
    const f = await fixture(t);
    const response = await post(f.base, '/api/login', { username: 'RIDER', password: 'test-pass', portal: 'passenger' });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.account.password, undefined);
    assert.equal(data.role, 'passenger');
    assert.match(data.token, /^[a-f0-9]{64}$/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('invalid passwords and the removed hardcoded admin login are rejected', async t => {
    const f = await fixture(t);
    for (const body of [
        { username: 'rider', password: 'wrong', portal: 'passenger' },
        { username: 'admin', password: 'admin123', portal: 'staff_portal' }
    ]) assert.equal((await post(f.base, '/api/login', body)).status, 401);
});

test('unauthenticated mutations and fake bearer tokens are rejected', async t => {
    const f = await fixture(t);
    assert.equal((await post(f.base, '/api/book', {})).status, 401);
    assert.equal((await post(f.base, '/api/trains', {}, { Authorization: 'Bearer ' + 'f'.repeat(64) })).status, 401);
    assert.equal(f.calls.some(call => call.rpc), false);
});

test('passengers cannot use admin or employee endpoints', async t => {
    const f = await fixture(t);
    const headers = await login(f.base);
    for (const path of ['/api/staff', '/api/reports', '/api/admin/passengers']) {
        assert.equal((await fetch(f.base + path, { headers })).status, 403);
    }
    assert.equal((await fetch(f.base + '/api/tickets/1/confirm', { method: 'PATCH', headers })).status, 403);
    assert.equal((await post(f.base, '/api/trains', {}, headers)).status, 403);
});

test('server derives employee role from the database, not the requested role', async t => {
    const f = await fixture(t);
    const headers = await login(f.base, 'worker', 'staff-pass', 'staff_portal');
    assert.equal((await fetch(f.base + '/api/staff', { headers })).status, 403);
    assert.equal((await fetch(f.base + '/api/tickets/1/confirm', { method: 'PATCH', headers })).status, 200);
});

test('passenger tickets are filtered by session identity and show the booked price', async t => {
    const f = await fixture(t);
    const headers = await login(f.base);
    const data = await (await fetch(f.base + '/api/tickets', { headers })).json();
    assert.equal(data.length, 1);
    assert.equal(data[0].passengerID, 'P1');
    assert.equal(data[0].price, 150);
});

test('invalid ticket counts never call the booking operation', async t => {
    const f = await fixture(t);
    const headers = await login(f.base);
    for (const count of [0, -1, 1.5, 21, '1', null]) {
        assert.equal((await post(f.base, '/api/book', { numberOfTickets: count }, headers)).status, 400);
    }
    assert.equal(f.calls.some(call => call.rpc), false);
});

test('signup uses one database operation and validates inputs', async t => {
    const f = await fixture(t);
    const body = { username: 'new-rider', password: 'new-pass', email: 'rider@example.test', passengerID: 'NEW1', name: 'New Rider', contactNumber: '0500000000' };
    assert.equal((await post(f.base, '/api/passenger_users', body)).status, 201);
    assert.equal(f.calls.filter(call => call.rpc === 'app_register_passenger').length, 1);
    assert.equal((await post(f.base, '/api/passenger_users', { ...body, username: "x');alert(1)" })).status, 400);
    assert.equal((await fetch(f.base + '/api/passenger_users')).status, 410);
});

test('password change targets the signed-in account and invalidates existing sessions', async t => {
    const f = await fixture(t);
    const headers = await login(f.base);
    const second = await login(f.base);
    const response = await fetch(f.base + '/api/staff/update-password', {
        method: 'PATCH', headers, body: JSON.stringify({ username: 'other', newPassword: 'changed-pass' })
    });
    assert.equal(response.status, 200);
    assert.equal(f.tables.passenger_users[0].password, 'changed-pass');
    assert.equal(f.tables.passenger_users[1].password, 'other-pass');
    assert.equal((await fetch(f.base + '/api/tickets', { headers: second })).status, 401);
});

test('logout and deleted employee accounts cannot reuse sessions', async t => {
    const f = await fixture(t);
    const headers = await login(f.base);
    assert.equal((await post(f.base, '/api/logout', {}, headers)).status, 200);
    assert.equal((await fetch(f.base + '/api/tickets', { headers })).status, 401);
    const worker = await login(f.base, 'worker', 'staff-pass', 'staff_portal');
    const admin = await login(f.base, 'manager', 'admin-pass', 'staff_portal');
    assert.equal((await fetch(f.base + '/api/staff/worker', { method: 'DELETE', headers: admin })).status, 200);
    assert.equal((await fetch(f.base + '/api/tickets', { headers: worker })).status, 401);
});

test('receipt writes are limited to owned pending tickets', async t => {
    const f = await fixture(t);
    const headers = await login(f.base);
    const body = JSON.stringify({ receiptPath: 'data:image/png;base64,aGVsbG8=' });
    assert.equal((await fetch(f.base + '/api/tickets/2/upload', { method: 'PATCH', headers, body })).status, 404);
    assert.equal((await fetch(f.base + '/api/tickets/1/upload', { method: 'PATCH', headers, body })).status, 200);
    const bad = JSON.stringify({ receiptPath: 'data:image/svg+xml;base64,aGVsbG8=' });
    assert.equal((await fetch(f.base + '/api/tickets/1/upload', { method: 'PATCH', headers, body: bad })).status, 400);
});

test('admin staff listings do not expose passwords', async t => {
    const f = await fixture(t);
    const headers = await login(f.base, 'manager', 'admin-pass', 'staff_portal');
    const data = await (await fetch(f.base + '/api/staff', { headers })).json();
    assert.equal(data.length, 2);
    assert.ok(data.every(account => !Object.hasOwn(account, 'password')));
    assert.equal((await fetch(f.base + '/api/staff/manager', { method: 'DELETE', headers })).status, 404);
});

test('login rate limit blocks repeated credential attempts', async t => {
    const f = await fixture(t);
    for (let i = 0; i < 20; i++) assert.equal((await post(f.base, '/api/login', { username: 'rider', password: 'wrong' })).status, 401);
    assert.equal((await post(f.base, '/api/login', { username: 'rider', password: 'wrong' })).status, 429);
});

test('missing database functions produce an actionable failure without success', async t => {
    const f = await fixture(t);
    f.database.rpc = async () => ({ error: { code: 'PGRST202' }, data: null });
    const headers = await login(f.base);
    const response = await post(f.base, '/api/book', { trainID: 'TR-01', numberOfTickets: 1, paymentMethod: 'Cash at Station' }, headers);
    assert.equal(response.status, 503);
    assert.match((await response.json()).message, /002-simple-app.sql/);
});
