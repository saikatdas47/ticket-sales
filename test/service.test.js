import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, seedDatabase } from '../database.js';
import { startProcess, stopProcess } from '../processes.js';

test('foreign keys, seed, pagination, validation and cross-process reservation races', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ticket-test-'));
  const path = join(directory, 'tickets.db');
  const db = openDatabase(path);
  const services = [];
  try {
    seedDatabase(db);
    assert.equal(db.prepare('SELECT count(*) AS n FROM seats').get().n, 10000);
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 5);
    assert.throws(() => db.prepare('INSERT INTO seats VALUES(10001, 99, ?, 100)').run('invalid'));
    assert.throws(() => db.prepare('INSERT INTO orders VALUES(99, 10001, ?, ?)').run('invalid', 'now'));
    services.push(await startProcess(path));
    services.push(await startProcess(path));
    const base = services[0].base;
    for (const suffix of ['?limit=0', '?limit=101', '?after=-1', '?limit=1.5']) {
      assert.equal((await fetch(base + '/events/1/seats' + suffix)).status, 400);
    }
    assert.equal((await fetch(base + '/events/99/seats')).status, 404);
    const first = await fetch(base + '/events/1/seats?limit=3').then(res => res.json());
    assert.deepEqual(first.items.map(s => s.id), [1, 2, 3]);
    assert.equal(first.nextCursor, 3);
    const second = await fetch(base + '/events/1/seats?limit=3&after=3').then(res => res.json());
    assert.deepEqual(second.items.map(s => s.id), [4, 5, 6]);
    const last = await fetch(base + '/events/1/seats?after=1999').then(res => res.json());
    assert.equal(last.nextCursor, null);
    for (const body of ['{', 'null', '[]', '{}', '{"customerName":42}', '{"customerName":" "}']) {
      const response = await fetch(base + '/seats/1/reserve', { method: 'POST', body });
      assert.equal(response.status, 400);
      assert.ok((await response.json()).fields);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n, 0);
    assert.equal((await fetch(base + '/seats/99999/reserve', { method: 'POST', body: '{"customerName":"Alice"}' })).status, 404);
    for (let seat = 1; seat <= 20; seat++) {
      const responses = await Promise.all(services.map((s, i) => fetch(s.base + `/seats/${seat}/reserve`, { method: 'POST', body: JSON.stringify({ customerName: i ? 'Bob' : 'Alice' }) })));
      assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
      await Promise.all(responses.map(r => r.json()));
      assert.equal(db.prepare('SELECT count(*) AS n FROM orders WHERE seat_id = ?').get(seat).n, 1);
    }
    const free = await fetch(base + '/events/1/seats').then(res => res.json());
    assert.equal(free.items[0].id, 21);
    assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n, 20);
  } finally {
    await Promise.all(services.map(stopProcess));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
