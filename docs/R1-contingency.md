# R1: Database connection failure contingency

The implemented contingency is temporary, read-only access to the last successfully retrieved public train schedule during database connectivity failure. It does not create offline bookings or claim that cached seats or prices are current.

## Function and integration

`createTrainScheduleService()` in `train-schedules.js` exposes `getTrainSchedulesWithFallback()`. `server.js` uses it for `GET /api/trains` and checks a fresh schedule before processing `POST /api/book`. The frontend uses the returned status to display a notice, show the last update time, and disable booking and cached schedule edit controls. Refresh buttons allow the user to check for recovery.

- Database read timeout: 5 seconds, with an abort signal.
- Snapshot lifetime: 5 minutes from the successful read. Failed reads do not extend it.
- Snapshot storage: server memory; it is lost on restart.
- Successful empty arrays are valid schedules, not connectivity failures.
- Connectivity failures and HTTP 408/502/503/504 can trigger fallback.
- Permission, schema, malformed data and other unexpected errors are not masked with cached schedules.
- Concurrent schedule reads share one pending database request.
- Responses use `Cache-Control: no-store` to avoid browser/proxy reuse of stale booking status.

## API response

`GET /api/trains` now returns an object instead of the previous array. Both existing frontend consumers have been updated.

```json
{
  "trains": [],
  "source": "live",
  "bookingAllowed": true,
  "lastUpdated": "2026-10-14T12:00:00.000Z"
}
```

During a connectivity failure, a valid snapshot returns HTTP 200 with `source: "cache"`, `bookingAllowed: false`, the original `lastUpdated`, and an explanatory `message`. A missing or expired snapshot returns HTTP 503, `source: "unavailable"`, an empty array, and a service-unavailability message. Non-connectivity errors return HTTP 500 without a cached response.

`POST /api/book` rejects fallback data with HTTP 503 before issuing database writes. On recovery a successful database read replaces the snapshot and permits booking again. This check does not make the subsequent booking writes atomic; concurrency and failures during a partially completed booking remain separate R2 work.

## Run and validate

From `/workspace/Train-Reservation-System`:

```bash
npm test
NODE_USE_ENV_PROXY=1 npm start
```

Node.js 24+ is required by the cloud proxy startup command. No additional packages are required for the tests. They use Node's built-in test runner, HTTP requests to an ephemeral local server, injected database responses, and the actual frontend functions in a simulated DOM.

The tests cover live reads; read-only fallback; missing and expired snapshots; recovery; timeout and cancellation; late-response protection; permission and schema errors; invalid data; blocked booking without writes; a successful simulated booking; UI notices; and disabled selection/submission and cached admin edit actions. The tests do not connect to Supabase or change external records. The simulated DOM tests are not a full browser compatibility test.

For a live demonstration, first retrieve schedules successfully, then reproduce a database connectivity failure in a controlled test environment and refresh the schedule. Verify the warning, original last-update time and disabled booking. Restore connectivity and refresh again. Without an initial successful read the intended result is HTTP 503, not a fabricated schedule. Avoid changing production network settings or database records merely to demonstrate the contingency.

## Suggested report evidence

Include the function name and location, timeout and expiry decisions, the preventive/contingency distinction, and test results. Describe tests with injected failures as simulations. Claim live Supabase validation only after a successful real request. The proposed owner remains the Backend and Database Developer, supported by the Frontend Developer and Tester; replace roles with actual team member names.
