const express = require('express');
const path = require('path');
const { randomBytes, randomInt, createHash, timingSafeEqual } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { createTrainScheduleService } = require('./train-schedules');

const supabaseUrl = process.env.SUPABASE_URL || 'https://gmjpifzyghtosnktcebn.supabase.co';
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_RvYf7D1dSsi4R8YLowcjqA_Q7EpGo8O';
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const safeAccount = account => {
    const { password, ...safe } = account;
    return safe;
};
const equalPassword = (a, b) => timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest()
);

function createApp({ supabaseClient, databaseClient, scheduleService } = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '3mb' }));
    app.use('/api', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });
    const publicDb = supabaseClient || createClient(supabaseUrl, publishableKey, options);
    const db = databaseClient || (process.env.SUPABASE_SERVER_KEY
        ? createClient(supabaseUrl, process.env.SUPABASE_SERVER_KEY, options) : null);
    const schedules = scheduleService || createTrainScheduleService({
        fetchTrains: signal => publicDb.from('trains').select('*').order('trainID').abortSignal(signal)
    });
    const sessions = new Map();
    const attempts = new Map();
    const ttl = 8 * 60 * 60 * 1000;
    const cleanup = setInterval(() => {
        const now = Date.now();
        for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
        for (const [key, attempt] of attempts) if (attempt.until <= now) attempts.delete(key);
    }, 60000);
    cleanup.unref();
    app.locals.dispose = () => clearInterval(cleanup);

    function check(result) {
        if (result.error) {
            const error = result.error;
            if (error.code === 'PGRST202') throw fail('Run database/002-simple-app.sql in Supabase SQL Editor first.', 503);
            if (error.code === '23505') throw fail('Username, email or passenger ID already exists.', 409);
            if (error.code === '23503') throw fail('This record is linked to other records and cannot be removed.', 409);
            if (error.code === 'P0001') throw fail(error.message, 409);
            if (['23514', '23502', '22P02', '22007', '22008'].includes(error.code)) throw fail('Invalid field values.');
            console.error('Database operation failed:', error.code || 'network');
            throw fail('Database operation failed. Check the server configuration and connection.', 503);
        }
        return result.data;
    }
    function requireDb(req, res, next) {
        if (!db) return next(fail('Set SUPABASE_SERVER_KEY securely in the server environment to enable accounts and bookings.', 503));
        next();
    }
    function loginLimit(req, res, next) {
        const key = req.ip;
        let entry = attempts.get(key);
        if (!entry || entry.until <= Date.now()) {
            entry = { count: 0, until: Date.now() + 15 * 60 * 1000 };
            attempts.set(key, entry);
        }
        if (++entry.count > 20) return next(fail('Too many attempts. Try again in 15 minutes.', 429));
        next();
    }
    async function authenticate(req, res, next) {
        const token = req.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        const session = sessions.get(token);
        if (!session || session.expires <= Date.now()) {
            if (token) sessions.delete(token);
            throw fail('Please sign in again.', 401);
        }
        const account = check(await db.from(session.table).select('*').eq('id', session.id).maybeSingle());
        if (!account) { sessions.delete(token); throw fail('Account no longer exists.', 401); }
        req.account = safeAccount(account);
        req.role = session.table === 'passenger_users' ? 'passenger' : account.role.toLowerCase();
        req.token = token;
        req.sessionTable = session.table;
        next();
    }
    const allow = (...roles) => (req, res, next) => {
        if (!roles.includes(req.role)) return next(fail('You do not have permission for this operation.', 403));
        next();
    };
    const invalidate = (table, id) => {
        for (const [token, session] of sessions) if (session.table === table && session.id === id) sessions.delete(token);
    };
    function text(value, label, max = 100) {
        if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail('Invalid ' + label + '.');
        return value.trim();
    }
    function credentials(body) {
        const username = text(body.username, 'username', 50).toLowerCase();
        if (!/^[a-z0-9_.-]{3,50}$/.test(username)) throw fail('Username must be 3–50 letters, numbers, dots, underscores or hyphens.');
        const email = text(body.email, 'email', 255).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Invalid email.');
        return { username, email };
    }
    function password(value) {
        if (typeof value !== 'string' || value.length < 6 || value.length > 255) throw fail('Password must be 6–255 characters.');
        return value;
    }

    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
    app.get('/api/trains', async (req, res) => {
        try { res.json(await schedules.getTrainSchedulesWithFallback()); }
        catch (error) {
            res.status(error.status || 500).json({ trains: [], source: 'unavailable', bookingAllowed: false, lastUpdated: null, message: error.message });
        }
    });
    app.post('/api/login', requireDb, loginLimit, async (req, res) => {
        const username = text(req.body.username, 'username', 50).toLowerCase();
        const supplied = typeof req.body.password === 'string' ? req.body.password : '';
        const table = req.body.portal === 'passenger' ? 'passenger_users' : 'staff_users';
        const account = check(await db.from(table).select('*').eq('username', username).maybeSingle());
        if (!account || !equalPassword(supplied, account.password)) throw fail('Invalid username or password.', 401);
        const role = table === 'passenger_users' ? 'passenger' : account.role.toLowerCase();
        const token = randomBytes(32).toString('hex');
        sessions.set(token, { table, id: account.id, expires: Date.now() + ttl });
        res.json({ token, role, account: safeAccount(account), mustChangePassword: supplied === '111111' });
    });
    app.post('/api/passenger_users', requireDb, loginLimit, async (req, res) => {
        const { username, email } = credentials(req.body);
        const passengerID = text(req.body.passengerID, 'passenger ID', 20);
        if (!/^[a-zA-Z0-9_-]+$/.test(passengerID)) throw fail('Invalid passenger ID.');
        check(await db.rpc('app_register_passenger', {
            p_username: username, p_email: email, p_password: password(req.body.password),
            p_passenger_id: passengerID, p_name: text(req.body.name, 'name'),
            p_contact: text(req.body.contactNumber, 'contact number', 20)
        }));
        res.status(201).json({ message: 'Passenger account created. Please sign in.' });
    });
    app.get('/api/passenger_users', (req, res) => res.status(410).json({ message: 'Use POST /api/login. Account passwords are not available through the API.' }));
    app.use('/api', requireDb, authenticate);
    app.post('/api/logout', (req, res) => {
        sessions.delete(req.token);
        res.json({ message: 'Signed out.' });
    });
    app.patch('/api/staff/update-password', async (req, res) => {
        check(await db.from(req.sessionTable).update({ password: password(req.body.newPassword) }).eq('id', req.account.id));
        invalidate(req.sessionTable, req.account.id);
        res.json({ message: 'Password changed. Please sign in again.' });
    });
    app.post('/api/book', async (req, res) => {
        const count = req.body.numberOfTickets;
        if (!Number.isInteger(count) || count < 1 || count > 20) throw fail('Number of tickets must be an integer between 1 and 20.');
        const schedule = await schedules.getTrainSchedulesWithFallback();
        if (!schedule.bookingAllowed) throw fail('Booking is temporarily unavailable. Refresh schedules and try again later.', 503);
        const passengerID = req.role === 'passenger' ? req.account.passengerID : text(req.body.passengerID, 'passenger ID', 20);
        const result = check(await db.rpc('app_book', {
            p_train_id: text(req.body.trainID, 'train ID', 10), p_passenger_id: passengerID,
            p_name: req.role === 'passenger' ? req.account.name : text(req.body.name, 'name'),
            p_contact: req.role === 'passenger' ? req.account.contactNumber : text(req.body.contactNumber, 'contact number', 20),
            p_payment: req.body.paymentMethod, p_count: count
        }));
        res.json({ message: 'Booking created. Payment is pending.', ticketNumbers: result, ticketNumber: result[0], count: result.length });
    });
    app.get('/api/tickets', async (req, res) => {
        let query = db.from('tickets').select('*, trains(*), passengers(name)').order('bookingDate', { ascending: false });
        if (req.role === 'passenger') query = query.eq('passengerID', req.account.passengerID);
        const tickets = check(await query);
        res.json(tickets.map(t => ({ ...t, trains: undefined, passengers: undefined,
            trainName: t.trains.trainName, departureStation: t.trains.departureStation,
            arrivalStation: t.trains.arrivalStation, departureDate: t.trains.departureDate,
            price: t.bookedPrice, passengerName: t.passengers.name
        })));
    });
    app.delete('/api/tickets/:id', allow('staff', 'admin'), async (req, res) => {
        check(await db.rpc('app_cancel_ticket', { p_ticket_id: req.params.id }));
        res.json({ message: 'Booking cancelled.' });
    });
    app.patch('/api/tickets/:id/reject', allow('staff', 'admin'), async (req, res) => {
        check(await db.rpc('app_cancel_ticket', { p_ticket_id: req.params.id }));
        res.json({ message: 'Payment rejected and seat released.' });
    });
    app.patch('/api/tickets/:id/confirm', allow('staff', 'admin'), async (req, res) => {
        const data = check(await db.from('tickets').update({ status: 'Confirmed' }).eq('ticketNumber', req.params.id).eq('status', 'Pending').select('ticketNumber'));
        if (!data.length) throw fail('Ticket is missing or is not pending.', 409);
        res.json({ message: 'Payment confirmed.' });
    });
    app.patch('/api/tickets/:id/upload', allow('passenger'), async (req, res) => {
        const receipt = req.body.receiptPath;
        if (typeof receipt !== 'string' || receipt.length > 2800000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(receipt)) throw fail('Upload a PNG, JPEG or WebP image up to 2 MB.');
        const data = check(await db.from('tickets').update({ receiptPath: receipt }).eq('ticketNumber', req.params.id).eq('passengerID', req.account.passengerID).eq('status', 'Pending').select('ticketNumber'));
        if (!data.length) throw fail('No pending ticket found for your account.', 404);
        res.json({ message: 'Receipt uploaded.' });
    });
    app.patch('/api/trains/:id', allow('admin'), async (req, res) => {
        const b = req.body;
        if (!Number.isFinite(b.price) || b.price < 0 || !Number.isInteger(b.totalCapacity) || b.totalCapacity < 1 || b.totalCapacity > 100000) throw fail('Invalid price or capacity.');
        if (!['On Time', 'Delayed', 'Cancelled'].includes(b.status) || !/^\d{4}-\d{2}-\d{2}$/.test(b.departureDate || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.departureTime || '')) throw fail('Invalid status, date or time.');
        check(await db.rpc('app_update_train', {
            p_train_id: req.params.id, p_price: b.price, p_status: b.status,
            p_date: b.departureDate, p_time: b.departureTime, p_capacity: b.totalCapacity
        }));
        res.json({ message: 'Train updated.' });
    });
    app.post('/api/trains', allow('admin'), async (req, res) => {
        const departureStation = text(req.body.departureStation, 'departure station');
        const arrivalStation = text(req.body.arrivalStation, 'arrival station');
        const price = Number(req.body.price);
        if (req.body.price === '' || !Number.isFinite(price) || price < 0 || departureStation === arrivalStation) throw fail('Invalid route or price.');
        const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        check(await db.from('trains').insert({
            trainID: 'TR-' + randomInt(1000000, 10000000),
            trainName: `${departureStation} to ${arrivalStation}`.slice(0, 100),
            departureStation, arrivalStation, departureDate: tomorrow,
            departuretime: '10:00', price, totalCapacity: 50, availableSeats: 50, status: 'On Time'
        }));
        res.status(201).json({ message: 'Route created.' });
    });
    app.get('/api/staff', allow('admin'), async (req, res) => {
        res.json(check(await db.from('staff_users').select('id, username, email, role').order('username')));
    });
    app.post('/api/staff', allow('admin'), async (req, res) => {
        const fields = credentials(req.body);
        const temporaryPassword = randomBytes(9).toString('base64url');
        check(await db.from('staff_users').insert({ ...fields, password: temporaryPassword, role: 'Staff' }));
        res.status(201).json({ message: 'Staff account created.', temporaryPassword });
    });
    app.delete('/api/staff/:username', allow('admin'), async (req, res) => {
        const data = check(await db.from('staff_users').delete().eq('username', req.params.username).eq('role', 'Staff').select('id'));
        if (!data.length) throw fail('Staff account not found. Admin accounts cannot be deleted here.', 404);
        data.forEach(row => invalidate('staff_users', row.id));
        res.json({ message: 'Staff access removed.' });
    });
    app.get('/api/reports', allow('admin'), async (req, res) => {
        const trains = check(await db.from('trains').select('*'));
        const tickets = check(await db.from('tickets').select('trainID, status, bookedPrice'));
        const totalRevenue = tickets.filter(t => t.status === 'Confirmed').reduce((sum, t) => sum + Number(t.bookedPrice), 0);
        res.json({ totalRevenue, occupancyData: trains.map(t => ({
            trainID: t.trainID, trainName: t.trainName, totalCapacity: t.totalCapacity,
            bookedSeats: t.totalCapacity - t.availableSeats,
            occupancyRate: ((t.totalCapacity - t.availableSeats) / t.totalCapacity * 100).toFixed(1)
        })) });
    });
    app.get('/api/admin/passengers', allow('admin'), async (req, res) => {
        res.json(check(await db.from('passenger_users').select('passengerID, name, username, email, contactNumber')));
    });
    app.delete('/api/admin/passengers/:id', allow('admin'), async (req, res) => {
        const data = check(await db.from('passenger_users').delete().eq('passengerID', req.params.id).select('id'));
        if (!data.length) throw fail('Passenger account not found.', 404);
        data.forEach(row => invalidate('passenger_users', row.id));
        res.json({ message: 'Login account removed. Historical passenger and ticket records are retained.' });
    });
    app.use('/api', (req, res) => res.status(404).json({ message: 'API route not found.' }));
    app.use((error, req, res, next) => {
        const status = error.status || 500;
        const message = status < 500 || status === 503 ? error.message : 'Unexpected server error.';
        res.status(status).json({ message, error: message });
    });
    return app;
}

if (require.main === module) {
    const port = Number(process.env.PORT) || 3000;
    createApp().listen(port, () => console.log(`Server running on port ${port}`));
}

module.exports = { createApp };
