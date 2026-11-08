function databaseFixture() {
    const tables = {
        passenger_users: [
            { id: 1, username: 'rider', password: 'test-pass', passengerID: 'P1', name: 'Rider', contactNumber: '0500000000', email: 'rider@example.test' },
            { id: 2, username: 'other', password: 'other-pass', passengerID: 'P2', name: 'Other', contactNumber: '0500000001', email: 'other@example.test' }
        ],
        staff_users: [
            { id: 1, username: 'manager', password: 'admin-pass', role: 'Admin', email: 'admin@example.test' },
            { id: 2, username: 'worker', password: 'staff-pass', role: 'Staff', email: 'staff@example.test' }
        ],
        tickets: [
            { ticketNumber: 1, passengerID: 'P1', trainID: 'TR-01', status: 'Pending', bookedPrice: 150, trains: { trainName: 'Express', price: 200 }, passengers: { name: 'Rider' } },
            { ticketNumber: 2, passengerID: 'P2', trainID: 'TR-01', status: 'Pending', bookedPrice: 150, trains: { trainName: 'Express', price: 200 }, passengers: { name: 'Other' } }
        ],
        trains: [{ trainID: 'TR-01', availableSeats: 2, totalCapacity: 4, price: 200 }]
    };
    const calls = [];
    const database = {
        from(table) {
            let fields = '*', operation = 'select', patch, single = false;
            const filters = [];
            const query = {
                select(value = '*') { fields = value; return query; },
                eq(key, value) { filters.push([key, value]); return query; },
                order() { return query; },
                maybeSingle() { single = true; return query; },
                update(value) { operation = 'update'; patch = value; return query; },
                insert(value) { operation = 'insert'; patch = value; return query; },
                delete() { operation = 'delete'; return query; },
                then(resolve, reject) {
                    return Promise.resolve().then(() => {
                        calls.push({ table, operation, fields, filters: [...filters], patch });
                        const rows = tables[table] || [];
                        let found = rows.filter(row => filters.every(([key, value]) => String(row[key]) === String(value)));
                        if (operation === 'insert') {
                            const row = { id: rows.length + 1, ...patch }; rows.push(row); found = [row];
                        }
                        if (operation === 'update') found.forEach(row => Object.assign(row, patch));
                        if (operation === 'delete') tables[table] = rows.filter(row => !found.includes(row));
                        const data = found.map(row => fields === '*' || fields.includes('trains(') ? { ...row } : Object.fromEntries(fields.split(',').map(key => [key.trim(), row[key.trim()]])));
                        return { data: single ? data[0] || null : data, error: null };
                    }).then(resolve, reject);
                }
            };
            return query;
        },
        async rpc(name, args) {
            calls.push({ rpc: name, args });
            if (name === 'app_book') return { data: [42], error: null };
            return { data: null, error: null };
        }
    };
    return { database, tables, calls };
}

async function login(base, username = 'rider', password = 'test-pass', portal = 'passenger') {
    const response = await fetch(base + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, portal })
    });
    if (!response.ok) throw Error('Fixture login failed: ' + response.status);
    const data = await response.json();
    return { Authorization: 'Bearer ' + data.token, 'Content-Type': 'application/json' };
}

module.exports = { databaseFixture, login };
