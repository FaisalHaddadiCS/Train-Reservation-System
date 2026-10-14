const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrainScheduleService } = require('../train-schedules');
const { createApp } = require('../server');
const { once } = require('node:events');

const train = { trainID: 'TR-01', availableSeats: 2, price: 150 };
const live = () => ({ data: [train], error: null, status: 200 });
const offline = () => ({ data: null, error: { message: 'TypeError: fetch failed' }, status: 0 });

function fixture() {
    let clock = 1000000;
    let response = live;
    const service = createTrainScheduleService({ now: () => clock, fetchTrains: () => response() });
    return { service, respond: value => { response = value; }, advance: ms => { clock += ms; } };
}

test('fresh schedules allow booking and record retrieval time', async () => {
    const f = fixture();
    const result = await f.service.getTrainSchedulesWithFallback();
    assert.equal(result.source, 'live');
    assert.equal(result.bookingAllowed, true);
    assert.equal(result.lastUpdated, new Date(1000000).toISOString());
    assert.deepEqual(result.trains, [train]);
});

test('connection failure returns last snapshot without allowing booking', async () => {
    const f = fixture();
    const original = await f.service.getTrainSchedulesWithFallback();
    original.trains[0].availableSeats = 999;
    f.advance(1000);
    f.respond(offline);
    const result = await f.service.getTrainSchedulesWithFallback();
    assert.equal(result.source, 'cache');
    assert.equal(result.bookingAllowed, false);
    assert.equal(result.trains[0].availableSeats, 2);
    assert.equal(result.lastUpdated, original.lastUpdated);
});

test('outage before any successful read returns 503', async () => {
    const f = fixture(); f.respond(offline);
    await assert.rejects(f.service.getTrainSchedulesWithFallback(), { status: 503 });
});

test('cache expires at five minutes and failed reads do not refresh it', async () => {
    const f = fixture(); await f.service.getTrainSchedulesWithFallback(); f.respond(offline);
    f.advance(299999);
    assert.equal((await f.service.getTrainSchedulesWithFallback()).source, 'cache');
    f.advance(1);
    await assert.rejects(f.service.getTrainSchedulesWithFallback(), { status: 503 });
});

test('recovery replaces old snapshot and permits booking', async () => {
    const f = fixture(); await f.service.getTrainSchedulesWithFallback(); f.respond(offline);
    await f.service.getTrainSchedulesWithFallback();
    f.advance(1000);
    f.respond(() => ({ data: [{ ...train, availableSeats: 1 }], error: null, status: 200 }));
    const recovered = await f.service.getTrainSchedulesWithFallback();
    assert.equal(recovered.source, 'live'); assert.equal(recovered.bookingAllowed, true);
    f.respond(offline);
    assert.equal((await f.service.getTrainSchedulesWithFallback()).trains[0].availableSeats, 1);
});

test('permission and schema errors are not masked by cache', async () => {
    const f = fixture(); await f.service.getTrainSchedulesWithFallback();
    for (const status of [401, 403, 400]) {
        f.respond(() => ({ data: null, error: { message: 'Permission or schema error' }, status }));
        await assert.rejects(f.service.getTrainSchedulesWithFallback(), { status: 500 });
    }
});

test('service outage response can use cache even without fetch-failed message', async () => {
    const f = fixture(); await f.service.getTrainSchedulesWithFallback();
    f.respond(() => ({ data: null, error: { message: 'Service Unavailable' }, status: 503 }));
    assert.equal((await f.service.getTrainSchedulesWithFallback()).source, 'cache');
});

test('a stalled query times out and its signal is aborted', async () => {
    let signal;
    const service = createTrainScheduleService({ timeoutMs: 15, fetchTrains: s => { signal = s; return new Promise(() => {}); } });
    await assert.rejects(service.getTrainSchedulesWithFallback(), { status: 503 });
    assert.equal(signal.aborted, true);
});

test('a timed-out response cannot later replace the last good snapshot', async () => {
    let resolveQuery;
    let mode = 'live';
    const service = createTrainScheduleService({ timeoutMs: 15, fetchTrains: () => mode === 'live' ? live() : mode === 'hang' ? new Promise(r => { resolveQuery = r; }) : offline() });
    await service.getTrainSchedulesWithFallback(); mode = 'hang';
    assert.equal((await service.getTrainSchedulesWithFallback()).source, 'cache');
    resolveQuery({ data: [{ ...train, availableSeats: 999 }], error: null, status: 200 });
    mode = 'offline';
    assert.equal((await service.getTrainSchedulesWithFallback()).trains[0].availableSeats, 2);
});

test('successful empty schedules are valid and invalid data is not cached', async () => {
    const f = fixture(); f.respond(() => ({ data: [], error: null }));
    assert.deepEqual((await f.service.getTrainSchedulesWithFallback()).trains, []);
    f.respond(() => ({ data: null, error: null }));
    await assert.rejects(f.service.getTrainSchedulesWithFallback(), { status: 500 });
});

async function serve(t, app) {
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP flow: live, cached outage, blocked booking, and recovery', async t => {
    const f = fixture();
    let writes = 0;
    const base = await serve(t, createApp({ scheduleService: f.service, supabaseClient: { from() { writes++; throw Error('Unexpected database write'); } } }));
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Train Booking \| Portal/);
    const first = await fetch(base + '/api/trains');
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal((await first.json()).source, 'live');
    f.respond(offline);
    const stale = await fetch(base + '/api/trains');
    assert.equal(stale.status, 200);
    assert.equal((await stale.json()).bookingAllowed, false);
    const book = await fetch(base + '/api/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trainID: 'TR-01' }) });
    assert.equal(book.status, 503); assert.equal(writes, 0);
    f.respond(live);
    assert.equal((await (await fetch(base + '/api/trains')).json()).bookingAllowed, true);
});

test('HTTP outage without snapshot returns 503 and prevents database writes', async t => {
    const f = fixture(); f.respond(offline);
    const base = await serve(t, createApp({ scheduleService: f.service, supabaseClient: { from() { throw Error('Unexpected write'); } } }));
    const response = await fetch(base + '/api/trains');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).source, 'unavailable');
    const booking = await fetch(base + '/api/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(booking.status, 503);
});

test('live booking still issues a ticket and reduces seats', async t => {
    const f = fixture();
    const writes = [];
    const database = {
        from(table) {
            if (table === 'passengers') return { upsert: async value => { writes.push({ table, value }); return { error: null }; } };
            if (table === 'tickets') return { insert(value) { writes.push({ table, value }); return { select: async () => ({ data: [{ ticketNumber: 42 }], error: null }) }; } };
            if (table === 'trains') return { update(value) { return { eq: async (column, id) => { writes.push({ table, value, column, id }); return { error: null }; } }; } };
            throw Error('Unexpected table');
        }
    };
    const base = await serve(t, createApp({ scheduleService: f.service, supabaseClient: database }));
    const response = await fetch(base + '/api/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trainID: 'TR-01', passengerID: 'TEST', name: 'Test', contactNumber: '000', numberOfTickets: 1, paymentMethod: 'Cash at Station' }) });
    assert.equal(response.status, 200);
    const ticket = await response.json();
    assert.deepEqual(ticket.ticketNumbers, [42]);
    assert.equal(writes[1].value[0].status, 'Pending');
    assert.equal(writes[2].value.availableSeats, 1);
});
