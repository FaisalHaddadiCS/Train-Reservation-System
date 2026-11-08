# Running the simple login version

This version uses the project's existing username/password tables. Login compares the submitted password on the server. It does not return stored passwords or download all accounts into the browser. Password values are still stored as text as requested for this classroom prototype; use test credentials only. This is not a production credential design.

## Database

Use the five-table schema last created in Supabase (`trains`, `passengers`, `passenger_users`, `staff_users`, `tickets`). Run `database/002-simple-app.sql` once in SQL Editor. This additive script does not reset tables or remove records. It can be repeated. It adds historical ticket prices and server-only functions for registration, booking, cancellation and route editing. Public train reading remains available; account tables stay private.

All tickets start as `Pending`, including the card option. This app does not process card payments. A staff member confirms payment; uploading an image alone does not confirm it. Cancellation marks a ticket cancelled and releases its seat once. Capacity edits preserve current reservations. Deleting a passenger login retains the passenger and historical bookings.

## Server environment

Node.js 24.5+ is required for the startup proxy flag (the prepared environment has Node.js 24.22.1). From the existing checkout:

```bash
npm ci --cache /workspace/.npm --no-audit --no-fund
cp .env.example .env
```

If `.env` already exists, edit it rather than overwrite it. Set `SUPABASE_SERVER_KEY` securely to the Supabase project secret key (or legacy `service_role` key). The publishable key alone cannot read protected account tables or create bookings. Never put the server key in `index.html`, source control, screenshots, or chat. `.env` is ignored; the server loads it on startup. A securely injected environment variable also works and takes precedence over `.env`.

In managed cloud settings, add a secret variable named `SUPABASE_SERVER_KEY`, scoped to `gmjpifzyghtosnktcebn.supabase.co`. Permit this hostname in outbound network settings. Keep other existing domains. Saving environment settings and restarting the app are separate operations.

```bash
npm start
```

The service uses port 3000 by default, or `PORT` if supplied. Public schedules work without the server key when network access is available. Account operations return an explicit configuration error while the server key is absent. Session tokens are held in browser memory and expire after eight hours. Refreshing the page or restarting the server requires signing in again.

## First administrator

There are no hardcoded `admin/admin123` or `staff/staff123` accounts. In Supabase Table Editor, insert one row into `staff_users`:

- Leave `id` automatic.
- Choose your own `email`, lowercase `username` (3–50 letters/numbers/dots/underscores/hyphens), and test `password` (6–255 characters).
- Set `role` to `Admin` exactly.

Sign in through Staff / Admin with that username/password. The stored database role determines access. Administrators can create staff accounts, and the app returns a random temporary password once. Staff can change their own password using Change Password. No automatic reset email is configured; the interface states this explicitly. Reset a lost password through trusted project administration.

## Validation

`npm test` covers server login, session invalidation, role restrictions, passenger ownership, registration validation, receipt ownership, booking requests, rate limits and the existing schedule-fallback tests. Database responses in these tests are simulated; this does not establish live Supabase connectivity. These tests do not count as the assignment's 200 live requests.

For an actual smoke check after configuration: load schedules, register a test passenger, sign in, book a ticket, and verify its pending status. Using a test staff account, confirm the payment, cancel the ticket twice and verify only one seat is restored. Use a disposable test train; these operations change database records. A full 200-request reliability experiment is a later task.
