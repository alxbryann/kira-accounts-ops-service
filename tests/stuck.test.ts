import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createOutboundTransfer, setStatus } from '../src/transfers.js';
import { handleWebhook } from '../src/webhooks.js';
import { listStuckTransfers, stuckAfterMinutes } from '../src/stuck.js';
import { createApp } from '../src/app.js';
import { fresh } from './helpers.js';

type Db = Awaited<ReturnType<typeof fresh>>;
const payout = (db: Db, key: string) => createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10_000, idempotency_key: key });
// Pretend the transfer's status last changed `minutes` ago.
const age = (db: Db, id: string, minutes: number) => db.query(`update transfers set updated_at = now() - make_interval(mins => $2) where id = $1`, [id, minutes]);

test('each kind of stuck payout is listed with its likely cause and the amount still held', async () => {
  const db = await fresh();

  const neverQueued = await payout(db, 'k-never');           // TICKET-204 class: hold but no outbox row
  await db.query(`delete from outbox where transfer_id = $1`, [neverQueued.id]);
  const failed = await payout(db, 'k-failed');
  await db.query(`update outbox set status='failed', attempts=3, last_error='provider timeout' where transfer_id = $1`, [failed.id]);
  const queued = await payout(db, 'k-queued');
  const unrecognised = await payout(db, 'k-unrec');          // TICKET-202 class
  await setStatus(db, unrecognised.id, 'submitted', 'PROV-unrec');
  await handleWebhook(db, { provider_event_id: 'EVT-u', provider_ref: 'PROV-unrec', status: 'chargeback' });
  const noOutcome = await payout(db, 'k-silent');
  await setStatus(db, noOutcome.id, 'submitted', 'PROV-silent');
  const settled = await payout(db, 'k-settled');
  await setStatus(db, settled.id, 'submitted', 'PROV-ok');
  await handleWebhook(db, { provider_event_id: 'EVT-ok', provider_ref: 'PROV-ok', status: 'settled' });

  for (const t of [neverQueued, failed, queued, unrecognised, noOutcome, settled]) await age(db, t.id, 120);
  const stuck = await listStuckTransfers(db, 30);

  const reasons = Object.fromEntries(stuck.map((t) => [t.id, t.reason]));
  assert.deepEqual(reasons, {
    [neverQueued.id]: 'never_queued',
    [failed.id]: 'submission_failed',
    [queued.id]: 'queued',
    [unrecognised.id]: 'unrecognised_status',
    [noOutcome.id]: 'no_outcome',
  }, 'a settled payout is final, so it is not stuck');

  const total = 10_000 + Number(neverQueued.fee_cents);
  for (const t of stuck) assert.equal(t.held_cents, total, `${t.id} still holds amount + fee`);
  assert.match(stuck.find((t) => t.id === failed.id)!.detail, /3 attempts: provider timeout/);
  assert.ok(stuck.every((t) => t.age_minutes >= 119));
});

test('only payouts older than the threshold are stuck', async () => {
  const db = await fresh();
  const old = await payout(db, 'k-old');
  const recent = await payout(db, 'k-recent');
  await age(db, old.id, 45);
  await age(db, recent.id, 5);
  assert.deepEqual((await listStuckTransfers(db, 30)).map((t) => t.id), [old.id]);
  assert.deepEqual((await listStuckTransfers(db, 60)).map((t) => t.id), []);
  assert.deepEqual((await listStuckTransfers(db, 0)).map((t) => t.id), [old.id, recent.id], 'oldest first');
});

test('stuckAfterMinutes falls back to 30 for missing or invalid values', () => {
  assert.equal(stuckAfterMinutes(undefined), 30);
  assert.equal(stuckAfterMinutes(''), 30);
  assert.equal(stuckAfterMinutes('abc'), 30);
  assert.equal(stuckAfterMinutes('-5'), 30);
  assert.equal(stuckAfterMinutes('0'), 0);
  assert.equal(stuckAfterMinutes('90'), 90);
});

test('GET /ops shows stuck payouts, and /ops/stuck-transfers honours ?stuck_after', async () => {
  const db = await fresh();
  const t = await payout(db, 'k-http');
  await db.query(`delete from outbox where transfer_id = $1`, [t.id]);
  await age(db, t.id, 40);
  const server = createApp(db).listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const html = await (await fetch(`${base}/ops`)).text();
    assert.ok(html.includes(t.id));
    assert.ok(html.includes('Never queued'));
    assert.deepEqual((await (await fetch(`${base}/ops/stuck-transfers?stuck_after=60`)).json()), []);
    assert.equal((await (await fetch(`${base}/ops/stuck-transfers?stuck_after=30`)).json())[0].id, t.id);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
