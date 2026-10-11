# Ticket sales: data model, indexed queries, and safe reservations

A Node.js HTTP service backed by SQLite. It models five events and 10,000 seats, lists available seats with cursor pagination, and prevents concurrent buyers from reserving the same seat. No external packages are needed.

## Run from an empty checkout

Use Node.js 22.13 or newer, then:

```sh
npm run seed
npm start
```

The default URL is `http://localhost:3001`. `PORT` changes the port and `DB_PATH` changes the persistent database file (default `./data/tickets.db`). Seeding creates **5 events and 10,000 seats, 2,000 per event**. It refuses to overwrite an existing populated database. Database files and secrets are ignored by Git.

```sh
curl 'http://localhost:3001/events/1/seats?limit=100'
curl 'http://localhost:3001/events/1/seats?limit=100&after=100'
curl -i -H 'Content-Type: application/json' \
  -d '{"customerName":"Alice"}' http://localhost:3001/seats/1/reserve
```

## Schema and relationships

See `schema.sql` for the executable schema.

| Table | Columns and constraints | Relationship |
| --- | --- | --- |
| events | id primary key, name, starts_at | One event has many seats |
| seats | id primary key, event_id foreign key, label, price_cents; unique(event_id, label) | Every seat belongs to an event |
| orders | id primary key, seat_id unique foreign key, customer_name, created_at | Each order reserves one seat; each seat has at most one order |

SQLite foreign keys are explicitly enabled on every connection. Prices use integer cents and timestamps use UTC strings. A seat is free when no order references it. There is no duplicated availability flag to keep synchronized. This brief models one-seat orders; carts, payments, cancellations, and temporary holds are outside its scope.

## API and errors

| Endpoint | Success | Failure |
| --- | --- | --- |
| GET /events/:eventId/seats | 200 with items and nextCursor | 400 for invalid parameters, 404 for a missing event |
| POST /seats/:seatId/reserve | 201 with the stored order | 400 for invalid input, 404 for a missing seat, 409 for an occupied seat |
| GET /health | 200 with `{ "ok": true }` | — |

The list includes free seats only, ordered by seat ID. `limit` defaults to 100 and must be 1–100. `after` defaults to 0 and must be a nonnegative integer. Pass the returned `nextCursor` as `after`; a null cursor means the end of the current result. Reservations made between pages may remove seats from later pages, so pagination is not a historical snapshot.

The reservation JSON body requires `customerName`, a nonempty string of at most 100 characters. Bodies are limited to 16 KiB. Malformed JSON and invalid inputs return 400 with the relevant field, for example:

```json
{"error":"validation","fields":{"customerName":"must be a nonempty string of at most 100 characters"}}
```

Unexpected failures return a generic 500 with a diagnostic ID rather than leaking database details. No accounts or payment processing are implemented; names are demo input, not verified identities.

## The query and the added index

```sql
SELECT s.id, s.event_id, s.label, s.price_cents
FROM seats s
WHERE s.event_id = ? AND s.id > ?
  AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.seat_id = s.id)
ORDER BY s.id
LIMIT ?;
```

The service requests one extra row to decide whether another page exists. The UNIQUE constraint on `orders.seat_id` provides the index used by the availability lookup. The added index is:

```sql
CREATE INDEX seats_event_id_id ON seats(event_id, id);
```

Actual `EXPLAIN QUERY PLAN` output on 10,000 seats for event 5, cursor 0, limit 101, **before** adding this index:

```text
SEARCH s USING INDEX sqlite_autoindex_seats_1 (event_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH o USING COVERING INDEX sqlite_autoindex_orders_1 (seat_id=?)
USE TEMP B-TREE FOR ORDER BY
```

**After**:

```text
SEARCH s USING INDEX seats_event_id_id (event_id=? AND id>?)
CORRELATED SCALAR SUBQUERY 1
SEARCH o USING COVERING INDEX sqlite_autoindex_orders_1 (seat_id=?)
```

The original unique index on `(event_id, label)` already narrows by event but does not provide seat-ID order. The new index also supports the cursor range and removes the temporary sort. The SQL subquery runs inside the database using an index; it is not an application N+1 sequence of HTTP/database round trips.

## Measured response time

Run `npm run measure`. It creates an isolated temporary database, seeds 10,000 seats, records both plans, adds the index, starts two separate HTTP server processes sharing that database, measures the list endpoint, demonstrates a reservation race, then cleans up.

Measured on 2026-10-11 with Node.js v25.3.0, over loopback HTTP, event 5, 100 returned seats, after 20 warmup requests:

| Measurement | Result |
| --- | --- |
| Measured requests | 200 |
| Median | 0.365 ms |
| 95th percentile | 0.535 ms |
| Maximum | **1.645 ms** |

Each timing covers the HTTP request through complete JSON response parsing, with no response cache. The measurement uses an initially unreserved dataset and sequential requests. These local results establish the under-200-ms requirement in this environment; public network latency, heavy concurrent load, and mostly sold-out events require separate measurements. `verification.json` contains the actual results. The measurement command fails if any measured response reaches 200 ms or the race creates more than one order.

## Concurrent reservation demonstration: commands and actual output

With a freshly seeded database, start two processes in separate terminals from this repository. Both use the same default SQLite file:

```sh
PORT=3001 npm start
```

```sh
PORT=3002 npm start
```

Then launch the following **two commands together** in one shell (the ampersands send them concurrently):

```sh
curl -sS -w '\nHTTP %{http_code}\n' -H 'Content-Type: application/json' -d '{"customerName":"Alice"}' http://localhost:3001/seats/1/reserve > race-alice.txt &
curl -sS -w '\nHTTP %{http_code}\n' -H 'Content-Type: application/json' -d '{"customerName":"Bob"}' http://localhost:3002/seats/1/reserve > race-bob.txt &
wait
cat race-alice.txt race-bob.txt
```

Actual output from the run on 2026-10-11:

```text
{"order":{"id":1,"seat_id":1,"customer_name":"Alice","created_at":"2026-10-11T07:51:47.259Z"}}
HTTP 201
{"error":"conflict","message":"seat is already reserved"}
HTTP 409
```

Either buyer may win. The second request must get 409; neither request can create a second order for that seat. Use a fresh seat ID on a repeat demonstration because seat 1 is now reserved. The captured response files are included.

The atomic statement enforcing this is:

```sql
INSERT INTO orders(seat_id, customer_name, created_at)
VALUES (?, ?, ?)
ON CONFLICT(seat_id) DO NOTHING
RETURNING *;
```

The UNIQUE constraint is checked by SQLite as part of the write, across processes. A preliminary seat lookup checks existence only; it does not decide availability. One insert returns the new order, and the losing insert returns no row, which becomes 409. There is no check-then-write race. SQLite WAL and a five-second busy timeout accommodate short write contention. A timeout under sustained overload may still produce an internal error, but cannot produce a duplicate reservation.

## Tests and deployment

`npm test` checks the seed count, both foreign keys, validation, missing resources, pagination, exclusion of sold seats, and **20 reservation races between separate server processes**, asserting one 201, one 409, and exactly one database order for each seat. Test data is isolated and removed afterward.

For hosting, run the seed once and start the service on a Node.js host with persistent writable storage. Set `DB_PATH` to that storage and `PORT` as required by the provider. Instances must share this SQLite file on one machine; independent files on separate hosts cannot coordinate reservations. Add HTTPS at the hosting boundary. Do not commit the runtime database, credentials, or `.env`.

The course lesson URL could not be retrieved by the browsing tool. Implementation follows the supplied brief; the lesson remains to be read in the signed-in course session. This repository does not include public hosting or a platform submission status.
