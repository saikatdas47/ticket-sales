CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  starts_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seats (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  label TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
  UNIQUE(event_id, label)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  seat_id INTEGER NOT NULL UNIQUE REFERENCES seats(id),
  customer_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
