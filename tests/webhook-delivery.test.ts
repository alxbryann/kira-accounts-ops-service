import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableCents } from '../src/ledger.js';
import { createOutboundTransfer, getTransfer, setStatus } from '../src/transfers.js';
import { handleWebhook } from '../src/webhooks.js';
import { processOutbox } from '../src/outbox.js';
import { faults } from '../src/faults.js';
import { fresh, rows, ledgerFor, FUNDING } from './helpers.js';

const TOTAL = 75_000 + 2_175;
async function submitted(key: string) {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 75_000, idempotency_key: key });
  await setStatus(db, t.id, 'submitted', `PROV-${key}`);
  return { db, t, ref: `PROV-${key}` };
}

// Partial failure: the process dies while applying a webhook. The event id must not be consumed
// unless its ledger entries and status change committed with it, or the redelivery is dropped as a duplicate.
test('a crash while applying a webhook leaves it unconsumed, and the redelivery applies it once', async () => {
  const { db, t, ref } = await submitted('idem-crash-evt');
  faults.crashApplyingEvent = 'EVT-c';
  await assert.rejects(handleWebhook(db, { provider_event_id: 'EVT-c', provider_ref: ref, status: 'settled' }));
  faults.crashApplyingEvent = undefined;

  assert.deepEqual(await rows(db, `select * from processed_events where provider_event_id='EVT-c'`), [], 'event id not consumed');
  assert.equal((await getTransfer(db, t.id)).status, 'submitted');
  assert.equal((await ledgerFor(db, t.id)).debit, undefined, 'nothing half-applied');

  assert.equal((await handleWebhook(db, { provider_event_id: 'EVT-c', provider_ref: ref, status: 'settled' })).status, 'processed');
  assert.equal((await getTransfer(db, t.id)).status, 'settled');
  assert.equal(await availableCents(db, 'A'), FUNDING - TOTAL);
});

// Concurrency: the provider redelivers the same event while the first delivery is still in flight.
test('the same event delivered twice concurrently is applied once and neither delivery errors', async () => {
  const { db, t, ref } = await submitted('idem-dup-race');
  const evt = { provider_event_id: 'EVT-d', provider_ref: ref, status: 'settled' };
  const results = await Promise.all([handleWebhook(db, evt), handleWebhook(db, evt)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['processed', 'skipped']);
  const l = await ledgerFor(db, t.id);
  assert.deepEqual([l.debit.n, l.release.n], [1, 1]);
});

// Event order: the outcome webhook arrives before we have stored the provider_ref (e.g. after a timeout).
test('a webhook for a provider_ref we do not know yet is not consumed, so its redelivery is applied', async () => {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 75_000, idempotency_key: 'idem-early' });
  const early = { provider_event_id: 'EVT-e', provider_ref: 'PROV-early', status: 'settled' };
  assert.equal((await handleWebhook(db, early)).status, 'unknown_transfer');
  assert.deepEqual(await rows(db, `select * from processed_events`), []);

  await setStatus(db, t.id, 'submitted', 'PROV-early');
  assert.equal((await handleWebhook(db, early)).status, 'processed');
  assert.equal((await getTransfer(db, t.id)).status, 'settled');
  assert.equal(await availableCents(db, 'A'), FUNDING - TOTAL);
});