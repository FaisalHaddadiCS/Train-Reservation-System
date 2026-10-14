const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');

function ui() {
    const elements = new Map();
    const getElementById = id => {
        if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', value: 'TR-01', style: {}, disabled: false });
        return elements.get(id);
    };
    let response = { trains: [{ trainID: 'TR-01', trainName: 'Test Train', availableSeats: 2, price: 150 }], source: 'live', bookingAllowed: true, lastUpdated: '2026-10-14T12:00:00Z' };
    let requests = 0;
    const modals = [];
    const context = vm.createContext({
        document: { getElementById, querySelectorAll: () => [] }, window: {},
        AbortSignal, TypeError, console,
        fetch: async () => { requests++; return { ok: response.source !== 'unavailable', json: async () => structuredClone(response) }; },
        showSmartModal: (...args) => modals.push(args)
    });
    const block = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));
    vm.runInContext("const API_URL = '/api'; const currentRole = 'admin';\n" +
        block('        let bookingAllowed = false;', '        function openEditModal') +
        block('        async function loadBookingTrains()', '        function filterTrains') +
        block('        function selectTrainForBooking(id)', '        function updateTicketPriceSummary') +
        block('        async function bookTicket(event)', '        async function loadTickets'), context);
    return { context, getElementById, modals, respond: value => { response = value; }, requests: () => requests, live: response };
}

test('booking UI disables stale selection and submission, then recovers', async () => {
    const f = ui();
    await vm.runInContext('loadBookingTrains()', f.context);
    assert.equal(f.getElementById('booking-submit').disabled, false);
    assert.match(f.getElementById('train-selection-list').innerHTML, /onclick="selectTrainForBooking/);
    f.respond({ ...f.live, source: 'cache', bookingAllowed: false, message: 'Browsing only.' });
    await vm.runInContext('loadBookingTrains()', f.context);
    assert.equal(f.getElementById('booking-submit').disabled, true);
    assert.equal(f.getElementById('trainID').value, '');
    assert.match(f.getElementById('booking-status').textContent, /Last updated:/);
    assert.doesNotMatch(f.getElementById('train-selection-list').innerHTML, /onclick="selectTrainForBooking/);
    assert.match(f.getElementById('train-selection-list').innerHTML, /disabled/);
    vm.runInContext("selectTrainForBooking('TR-01')", f.context);
    assert.equal(f.getElementById('trainID').value, '');
    const requests = f.requests();
    await vm.runInContext('bookTicket({ preventDefault() {} })', f.context);
    assert.equal(f.requests(), requests);
    assert.equal(f.modals[0][1], 'Booking Unavailable');
    f.respond(f.live);
    await vm.runInContext('loadBookingTrains()', f.context);
    assert.equal(f.getElementById('booking-submit').disabled, false);
    assert.match(f.getElementById('train-selection-list').innerHTML, /onclick="selectTrainForBooking/);
});

test('outage without cache clears schedule rows and shows service message', async () => {
    const f = ui();
    f.respond({ trains: [], source: 'unavailable', bookingAllowed: false, message: 'Temporarily unavailable.' });
    await vm.runInContext('loadSchedules()', f.context);
    assert.equal(f.getElementById('schedule-status').textContent, 'Temporarily unavailable.');
    assert.match(f.getElementById('scheduleList').innerHTML, /No schedules to display/);
    assert.equal(f.getElementById('booking-submit').disabled, true);
});

test('admin edit actions are hidden while displaying cached schedules', async () => {
    const f = ui();
    await vm.runInContext('loadSchedules()', f.context);
    assert.match(f.getElementById('scheduleList').innerHTML, /openEditModal/);
    f.respond({ ...f.live, source: 'cache', bookingAllowed: false, message: 'Browsing only.' });
    await vm.runInContext('loadSchedules()', f.context);
    assert.doesNotMatch(f.getElementById('scheduleList').innerHTML, /openEditModal/);
});
