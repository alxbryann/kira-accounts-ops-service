import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import * as provider from '../src/providers.js';

async function serve() {
  provider.resetProvider();
  const db = await openDb();
  await db.query(`insert into accounts(id,name) values ('A','Test')`);
  const server = createApp(db).listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('POST /transfers without amount_cents is a 400 and the server keeps serving', async () => {
  const s = await serve();
  const r = await post(`${s.base}/transfers`, { account_id: 'A', rail: 'ach' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /amount_cents/);
  assert.equal((await fetch(`${s.base}/health`)).status, 200);
  await s.close();
});

test('GET /transfers/:id for an unknown id is a 404', async () => {
  const s = await serve();
  const r = await fetch(`${s.base}/transfers/TX-NOPE`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'transfer not found');
  await s.close();
});

test('an error thrown inside a handler is answered, not fatal, and the server keeps serving', async () => {
  const s = await serve();
  const r = await post(`${s.base}/webhooks/provider`, { provider_ref: 'PROV-0001', status: 'settled' }); // no provider_event_id
  assert.equal(r.status, 400, 'a webhook without an event id cannot be de-duplicated, so it is rejected');
  assert.match((await r.json()).error, /provider_event_id/);
  assert.equal((await fetch(`${s.base}/health`)).status, 200);
  await s.close();
});
