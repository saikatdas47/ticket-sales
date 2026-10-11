import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase, seedDatabase, addIndex, freeSeatsSql } from './database.js';
import { startProcess, stopProcess } from './processes.js';

const directory = mkdtempSync(join(tmpdir(), 'ticket-measure-'));
const path = join(directory, 'tickets.db');
const services = [];
try {
  const db = openDatabase(path);
  seedDatabase(db);
  const counts = {
    events: db.prepare('SELECT count(*) AS n FROM events').get().n,
    seats: db.prepare('SELECT count(*) AS n FROM seats').get().n
  };
  const before = db.prepare('EXPLAIN QUERY PLAN ' + freeSeatsSql).all(5, 0, 101).map(row => row.detail);
  addIndex(db);
  const after = db.prepare('EXPLAIN QUERY PLAN ' + freeSeatsSql).all(5, 0, 101).map(row => row.detail);
  db.close();
  services.push(await startProcess(path));
  services.push(await startProcess(path));
  const endpoint = services[0].base + '/events/5/seats?limit=100';
  const timings = [];
  for (let i = 0; i < 220; i++) {
    const start = performance.now();
    const response = await fetch(endpoint);
    const body = await response.json();
    if (response.status !== 200 || body.items.length !== 100) throw new Error('Invalid list response');
    if (i >= 20) timings.push(performance.now() - start);
  }
  const race = await Promise.all(services.map((service, i) => fetch(service.base + '/seats/1/reserve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerName: i ? 'Bob' : 'Alice' })
  }).then(async response => ({ status: response.status, body: await response.json() }))));
  if (race.map(r => r.status).sort().join(',') !== '201,409') throw new Error('Race allowed duplicate reservation');
  const check = openDatabase(path);
  const ordersForSeat = check.prepare('SELECT count(*) AS n FROM orders WHERE seat_id = 1').get().n;
  check.close();
  timings.sort((a, b) => a - b);
  const milliseconds = {
    samples: timings.length, warmup: 20,
    median: +timings[100].toFixed(3), p95: +timings[189].toFixed(3), maximum: +timings.at(-1).toFixed(3)
  };
  console.log(JSON.stringify({ node: process.version, counts, before, after, milliseconds, race, ordersForSeat }, null, 2));
  if (milliseconds.maximum >= 200 || ordersForSeat !== 1) process.exitCode = 1;
} finally {
  await Promise.all(services.map(stopProcess));
  rmSync(directory, { recursive: true, force: true });
}
