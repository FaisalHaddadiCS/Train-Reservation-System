class ScheduleUnavailableError extends Error {
    constructor(message, status = 503) {
        super(message);
        this.status = status;
    }
}

function isConnectionFailure(error, status = 0) {
    if ([408, 502, 503, 504].includes(status)) return true;
    if (status !== 0) return false;
    return error?.name === 'ConnectionError' || error?.name === 'AbortError' || error?.name === 'TimeoutError' ||
        /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|aborted/i.test(error?.message || '');
}

function createTrainScheduleService({ fetchTrains, now = Date.now, timeoutMs = 5000, cacheTtlMs = 300000 }) {
    let snapshot = null;
    let pending = null;

    async function load() {
        const controller = new AbortController();
        let timer;
        try {
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    const error = new Error('Database request timed out.');
                    error.name = 'TimeoutError';
                    reject(error);
                }, timeoutMs);
            });
            const result = await Promise.race([
                Promise.resolve().then(() => fetchTrains(controller.signal)), timeout
            ]);
            if (result.error) {
                if (!isConnectionFailure(result.error, result.status)) {
                    throw new ScheduleUnavailableError('Unable to load schedules. Please contact support.', 500);
                }
                throw Object.assign(new Error('Database connection unavailable.'), { name: 'ConnectionError', cause: result.error });
            }
            if (!Array.isArray(result.data)) {
                throw new ScheduleUnavailableError('Invalid schedule response. Please contact support.', 500);
            }
            snapshot = { trains: structuredClone(result.data), updatedAt: now() };
            return {
                trains: structuredClone(snapshot.trains), source: 'live',
                bookingAllowed: true, lastUpdated: new Date(snapshot.updatedAt).toISOString()
            };
        } catch (error) {
            if (!isConnectionFailure(error)) throw error;
            if (snapshot && now() - snapshot.updatedAt < cacheTtlMs) {
                return {
                    trains: structuredClone(snapshot.trains), source: 'cache',
                    bookingAllowed: false, lastUpdated: new Date(snapshot.updatedAt).toISOString(),
                    message: 'Connection unavailable. Showing the last saved schedule for browsing only. Seats and prices may have changed. Booking is temporarily unavailable.'
                };
            }
            throw new ScheduleUnavailableError('Schedules are temporarily unavailable. Please try again later.');
        } finally {
            clearTimeout(timer);
        }
    }

    async function getTrainSchedulesWithFallback() {
        if (!pending) pending = load().finally(() => { pending = null; });
        return structuredClone(await pending);
    }

    return { getTrainSchedulesWithFallback };
}

module.exports = { createTrainScheduleService, ScheduleUnavailableError };
