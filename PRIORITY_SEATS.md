# Exclusive senior and PWD seats

Seats 1–4 are for seniors, 5–8 for PWDs, and 9+ are regular seats.
These eight seats are part of total capacity; an empty exclusive seat is not occupied.
Approved account verification is required for online exclusive-seat bookings.
Each account may hold one exclusive seat per trip across all active bookings.
Companions use regular seats. Existing reservations are retained.

Pickup passengers do not need approved online verification. The active, assigned
conductor chooses a category and confirms checking the physical ID. The booking
stores `priority_category`, `priority_verified_by`, and `priority_verified_at`.
The append-only `pickup_seat_verifications` table retains the confirmation history.
This does not update online verification or change fare discounts. A new exclusive
seat assignment requires fresh ID confirmation; unchanged seats can be retained.

## Release order

1. Apply `priority_seats_migration.sql` in the existing Supabase project's SQL
   editor or through its normal migration connection. It is transactional and
   rerunnable. It preserves existing bookings and adds database validation,
   per-bus transaction locking, and audit storage. Do not enable this release
   without the database guard: API validation alone cannot prevent racing requests.
2. Deploy `backendbus` with its existing Supabase service-role configuration.
   Run `npm ci` and the existing start command. No new production credentials are
   required. The package's new PostgreSQL runtime is a dev-only test dependency.
3. Build and deploy `clientside_bustracking`, `employee`, and `admin_bustracking`
   to their existing hosts, all pointing to the updated backend API.
4. Test an approved senior booking seat 1 plus a regular companion, a PWD booking
   seat 5, and a regular account being unable to select either category. Verify
   another booking cannot reserve a second exclusive seat for the same trip.
5. Test an unverified pickup account: the assigned conductor checks its physical ID,
   confirms its category, assigns a matching seat, and sees the saved confirmation.
   Verify a driver/unassigned conductor cannot assign it, regular seats need no ID
   confirmation, and no online discount approval is created by the pickup action.
6. Run a two-connection PostgreSQL concurrency smoke test in staging before a
   multi-instance rollout. The local SQL tests exercise duplicate submissions but
   their PGlite runtime serializes connections, so they do not simulate production
   lock contention. No live payment should be taken for these tests.

If deployment must be rolled back, roll the apps/backend back together and retain
the migration and audit records. Old clients may receive clear eligibility errors
for exclusive seats, which is preferable to allowing invalid reservations.

## API compatibility

`GET /api/buses/:busId/booked-seats?date=...&tripId=...` retains `bookedSeats` and
adds `seats` (number, category, occupied, selectable, reason),
`availableByCategory`, `eligibleCategory`, `otherPrioritySeat`, and
`seatBookingEnabled`. A valid bearer token makes eligibility account-specific.
For conductor previews, add `pickupBookingId`; this requires the assigned
conductor's token. Physical category selection is confirmed on assignment.

`PUT /api/employee/booking/:id/seat-assignment` accepts `passenger_category`
(`senior_citizen` or `pwd`) and `physical_id_confirmed: true` when adding an
exclusive seat. Audit identity/time are derived by the server. Checkout, pickup
creation, employee booking retrieval, and pickup seat assignment require a valid
bearer session and reject mismatched request identities.

Legacy bookings without a trip use bus plus Asia/Manila travel date. New seat
allocations are blocked for buses with fewer than eight seats, while existing
bookings and standing behavior are preserved. New/changed capacities require
at least eight seats. All apps must be deployed with the database migration.

## Verification performed locally

Run `npm test` for pricing, password recovery, seat eligibility, endpoint
authorization, conductor assignment, and isolated PostgreSQL migration tests.
Tests use fixtures and mocked payment creation; they do not charge passengers.
The SQL suite tests migration reapplication, legacy seats, ID audit history,
category changes, duplicate allocations, cancellation, Manila day boundaries,
and minimum capacity. Run `npm run build` in all three frontend projects.

Read-only production audit before this change: 6 buses, none below 8 seats;
6 active bookings, including 3 using seats 1–8. No production booking was changed.
Live migration/deployment require access to the existing SQL/deployment environment;
local implementation and tests do not constitute a live rollout.
