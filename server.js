const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { createTrainScheduleService } = require('./train-schedules');

function createApp({ supabaseClient, scheduleService } = {}) {
const app = express();
app.use(cors());
app.use(express.json());

const supabaseUrl = 'https://gmjpifzyghtosnktcebn.supabase.co';
const supabaseKey = 'sb_publishable_RvYf7D1dSsi4R8YLowcjqA_Q7EpGo8O';
const supabase = supabaseClient || createClient(supabaseUrl, supabaseKey);
const schedules = scheduleService || createTrainScheduleService({
    fetchTrains: signal => supabase.from('trains').select('*').order('trainID').abortSignal(signal)
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/trains', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        res.json(await schedules.getTrainSchedulesWithFallback());
    } catch (error) {
        res.status(error.status || 500).json({
            trains: [], source: 'unavailable', bookingAllowed: false,
            lastUpdated: null, message: error.message
        });
    }
});

app.patch('/api/trains/:id', async (req, res) => {
    const { status, price, departureDate, departureTime, totalCapacity, availableSeats } = req.body;
    const updates = {};
    if (status !== undefined) updates.status = status;
    if (price !== undefined) updates.price = parseFloat(price);
    if (departureDate !== undefined) updates.departureDate = departureDate;
    if (departureTime !== undefined) updates.departuretime = departureTime;
    if (totalCapacity !== undefined) updates.totalCapacity = parseInt(totalCapacity);
    if (availableSeats !== undefined) updates.availableSeats = parseInt(availableSeats);

    console.log(`PATCH /api/trains/${req.params.id} →`, updates);

    const { data, error } = await supabase.from('trains').update(updates).eq('trainID', req.params.id).select();
    if (error) {
        console.error('Supabase error:', error);
        return res.status(500).json({ error: error.message, details: error.details, hint: error.hint });
    }
    if (!data || data.length === 0) {
        return res.status(404).json({ error: `No train found with trainID = ${req.params.id}` });
    }
    console.log('Updated:', data);
    res.json({ message: 'Train updated successfully.', data });
});

app.post('/api/book', async (req, res) => {
    const { trainID, passengerID, name, contactNumber, paymentMethod, numberOfTickets } = req.body;
    const count = parseInt(numberOfTickets) || 1;

    let schedule;
    try {
        schedule = await schedules.getTrainSchedulesWithFallback();
    } catch (error) {
        return res.status(error.status || 503).json({ message: error.message });
    }
    if (!schedule.bookingAllowed) {
        return res.status(503).json({ message: 'Booking is temporarily unavailable. Please refresh the schedules and try again later.' });
    }
    const train = schedule.trains.find(train => train.trainID === trainID);
    if (!train) return res.status(400).json({ message: 'Train not found.' });
    if (train.availableSeats < count) return res.status(400).json({ message: `Only ${train.availableSeats} seat(s) available. Requested: ${count}.` });

    const ticketStatus = paymentMethod === 'Cash at Station' ? 'Pending' : 'Confirmed';

    await supabase.from('passengers').upsert({ passengerID, name, contactNumber });

    // Insert all tickets in one batch
    const ticketsToInsert = Array.from({ length: count }, () => ({
        passengerID, trainID, paymentMethod, status: ticketStatus
    }));
    const { data: insertedTickets } = await supabase.from('tickets').insert(ticketsToInsert).select();

    await supabase.from('trains').update({ availableSeats: train.availableSeats - count }).eq('trainID', trainID);

    const ticketNumbers = insertedTickets.map(t => t.ticketNumber);
    const message = count > 1
        ? `${count} tickets booked successfully!`
        : 'Booking successful!';

    res.json({ message, ticketNumbers, ticketNumber: ticketNumbers[0], count });
});

app.patch('/api/tickets/:id/confirm', async (req, res) => {
    const { error } = await supabase.from('tickets').update({ status: 'Confirmed' }).eq('ticketNumber', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Payment confirmed and ticket activated.' });
});

app.get('/api/tickets', async (req, res) => {
    const { data: tickets } = await supabase.from('tickets').select('*').order('bookingDate', { ascending: false });
    const { data: trains } = await supabase.from('trains').select('*');
    const { data: passengers } = await supabase.from('passengers').select('*');

    const result = (tickets || []).map(t => {
        const train = (trains || []).find(tr => tr.trainID === t.trainID) || {};
        const pass = (passengers || []).find(p => p.passengerID === t.passengerID) || {};
       return {
            ticketNumber: t.ticketNumber,
            trainID: t.trainID,
            passengerID: t.passengerID,
            status: t.status,
            paymentMethod: t.paymentMethod || 'Credit Card',
            receiptPath: t.receiptPath, // <--- هذا السطر اللي كان ناقص!
            bookingDate: t.bookingDate,
            trainName: train.trainName || 'Unknown',
            departureStation: train.departureStation || 'N/A',
            arrivalStation: train.arrivalStation || 'N/A',
            departureDate: train.departureDate || 'N/A',
            price: train.price || 0,
            passengerName: pass.name || 'Unknown'
        };
    });
    res.json(result);
});

app.delete('/api/tickets/:id', async (req, res) => {
    const ticketId = req.params.id;
    const { data: ticket } = await supabase.from('tickets').select('trainID').eq('ticketNumber', ticketId).single();
    if (ticket) {
        const { error: delError } = await supabase.from('tickets').delete().eq('ticketNumber', ticketId);
        if (!delError) {
            const { data: train } = await supabase.from('trains').select('availableSeats').eq('trainID', ticket.trainID).single();
            if (train) await supabase.from('trains').update({ availableSeats: train.availableSeats + 1 }).eq('trainID', ticket.trainID);
            return res.json({ message: 'Booking cancelled.' });
        }
    }
    res.status(500).json({ error: 'Failed to delete.' });
});

app.get('/api/passenger_users', async (req, res) => {
    const { data } = await supabase.from('passenger_users').select('*');
    res.json(data || []);
});

app.post('/api/passenger_users', async (req, res) => {
    const { username, email, password, passengerID, name, contactNumber } = req.body;
    const { error } = await supabase.from('passenger_users').insert([{ username, email, password, passengerID, name, contactNumber }]);
    if (error) return res.status(400).json({ message: 'Error: Username or ID exists.' });
    await supabase.from('passengers').upsert({ passengerID, name, contactNumber });
    res.json({ message: 'Passenger account created successfully' });
});

app.get('/api/staff', async (req, res) => {
    const { data } = await supabase.from('staff_users').select('*');
    res.json(data || []);
});

// ✅ Route واحدة نظيفة لإنشاء موظف جديد (بكلمة مرور افتراضية 111111)
app.post('/api/staff', async (req, res) => {
    const { username, email } = req.body;
    const { error } = await supabase.from('staff_users').insert([{
        username,
        email,
        password: '111111'
    }]);
    if (error) {
        console.log("DB Error:", error);
        return res.status(400).json({ message: 'Username or Email already exists.' });
    }
    res.json({ message: 'Staff created successfully.' });
});

app.post('/api/trains', async (req, res) => {
    const { departureStation, arrivalStation, price } = req.body;
    
    // 1. توليد ID فريد
    const newId = 'TR-' + Math.floor(Math.random() * 900 + 100);
    
    // 2. تحديد تاريخ غد تلقائياً
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];

    const { error } = await supabase.from('trains').insert([{
        trainID: newId,
        trainName: `${departureStation} to ${arrivalStation} Express`,
        departureStation: departureStation,
        arrivalStation: arrivalStation,
        departureDate: dateStr,
        departuretime: '10:00',
        price: parseFloat(price),
        totalCapacity: 50,
        availableSeats: 50,
        status: 'On Time'
    }]);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Success' });
});
app.delete('/api/staff/:username', async (req, res) => {
    await supabase.from('staff_users').delete().eq('username', req.params.username);
    res.json({ message: 'Staff deleted' });
});

// تحديث كلمة مرور الموظف
app.patch('/api/staff/update-password', async (req, res) => {
    const { username, newPassword } = req.body;
    const { error } = await supabase.from('staff_users').update({ password: newPassword }).eq('username', username);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Password updated successfully.' });
});

app.get('/api/reports', async (req, res) => {
    const { data: trains } = await supabase.from('trains').select('*');
    const { data: tickets } = await supabase.from('tickets').select('*');
    let totalRevenue = 0;
    let occupancyData = [];

    if (trains && tickets) {
        tickets.forEach(ticket => {
            if (ticket.status === 'Confirmed') {
                const train = trains.find(t => t.trainID === ticket.trainID);
                if (train) totalRevenue += Number(train.price);
            }
        });
        occupancyData = trains.map(t => {
            const bookedSeats = t.totalCapacity - t.availableSeats;
            const occupancyRate = t.totalCapacity > 0 ? ((bookedSeats / t.totalCapacity) * 100).toFixed(1) : 0;
            return { trainID: t.trainID, trainName: t.trainName || 'Unknown', totalCapacity: t.totalCapacity, bookedSeats, occupancyRate };
        });
    }
    res.json({ totalRevenue, occupancyData });
});

// جلب بيانات المسافرين للأدمن (بدون الباسورد)
app.get('/api/admin/passengers', async (req, res) => {
    const { data, error } = await supabase.from('passenger_users').select('passengerID, name, username, email, contactNumber');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});
app.delete('/api/admin/passengers/:id', async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase.from('passenger_users').delete().eq('passengerID', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Passenger account deleted successfully.' });
});
// مسار رفع الإيصال (تخزين الرابط)
app.patch('/api/tickets/:id/upload', async (req, res) => {
    const { receiptPath } = req.body;
    await supabase.from('tickets').update({ receiptPath: receiptPath }).eq('ticketNumber', req.params.id);
    res.json({ message: 'Uploaded' });
});

// مسار الرفض (إلغاء التذكرة أو تغيير الحالة)
app.patch('/api/tickets/:id/reject', async (req, res) => {
    await supabase.from('tickets').update({ status: 'Cancelled' }).eq('ticketNumber', req.params.id);
    res.json({ message: 'Rejected' });
});
return app;
}

if (require.main === module) {
    const PORT = 3000;
    createApp().listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
}

module.exports = { createApp };
