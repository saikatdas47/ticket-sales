import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export const freeSeatsSql = `
  SELECT s.id, s.event_id, s.label, s.price_cents
  FROM seats s
  WHERE s.event_id = ? AND s.id > ?
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.seat_id = s.id)
  ORDER BY s.id
  LIMIT ?`;

export function openDatabase(path = process.env.DB_PATH || './data/tickets.db') {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return db;
}

export function addIndex(db) {
  db.exec('CREATE INDEX IF NOT EXISTS seats_event_id_id ON seats(event_id, id)');
}

export function seedDatabase(db) {
  const event = db.prepare('INSERT INTO events(id, name, starts_at) VALUES (?, ?, ?)');
  const seat = db.prepare('INSERT INTO seats(id, event_id, label, price_cents) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT COUNT(*) AS count FROM events').get().count !== 0) {
      throw new Error('Seed requires an empty database; existing data will not be overwritten');
    }
    for (let e = 1; e <= 5; e++) {
      event.run(e, `Event ${e}`, `2027-01-0${e}T18:00:00Z`);
      for (let n = 1; n <= 2000; n++) seat.run((e - 1) * 2000 + n, e, `Seat ${n}`, 2500);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
