import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableCents } from '../src/ledger.js';
import { createOutboundTransfer, getTransfer, setStatus } from '../src/transfers.js';
import { handleWebhook } from '../src/webhooks.js';
import { normalizeProviderStatus } from '../src/providers.js';
import { fresh, rows, ledgerFor, FUNDING } from './helpers.js';

// A transfer the provider has accepted but not yet reported an outcome for.
async function submitted(key: string) {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'crypto', amount_cents: 60_000, idempotency_key: key });
  await setStatus(db, t.id, 'submitted', `PROV-${key}`);
  return { db, t, ref: `PROV-${key}` };
}

test('normalizeProviderStatus accepts known statuses in any case/whitespace and rejects the rest', () => {
  assert.equal(normalizeProviderStatus('settled'), 'settled');
  assert.equal(normalizeProviderStatus('  REVERSED '), 'reversed');
  assert.equal(normalizeProviderStatus('chargeback'), null);
  assert.equal(normalizeProviderStatus(''), null);
  assert.equal(normalizeProviderStatus(undefined), null);
  assert.equal(normalizeProviderStatus(42), null);
});

test('a webhook status in a different case is applied, not dropped', async () => {
  const { db, t, ref } = await submitted('idem-case');
  const res = await handleWebhook(db, { provider_event_id: 'EVT-case', provider_ref: ref, status: 'Reversed' });
  assert.equal(res.status, 'processed');
  assert.equal((await getTransfer(db, t.id)).status, 'returned');
  assert.equal(await availableCents(db, 'A'), FUNDING);
});

test('an unknown status is parked, not consumed, and a redelivery is applied once supported', async () => {
  const { db, t, ref } = await submitted('idem-unknown');
  const held = await availableCents(db, 'A');

  const res = await handleWebhook(db, { provider_event_id: 'EVT-x', provider_ref: ref, status: 'chargeback' });
  assert.equal(res.status, 'unhandled_status');
  assert.equal((await getTransfer(db, t.id)).status, 'submitted', 'no guessing: the transfer is left as it was');
  assert.equal(await availableCents(db, 'A'), held, 'no ledger movement for an unknown status');
  assert.deepEqual(await rows(db, `select * from processed_events where provider_event_id='EVT-x'`), [], 'event id must not be consumed');

  await handleWebhook(db, { provider_event_id: 'EVT-x', provider_ref: ref, status: 'chargeback' });
  const parked = await rows(db, `select raw_status, deliveries from unhandled_provider_events where provider_event_id='EVT-x'`);
  assert.deepEqual(parked, [{ raw_status: 'chargeback', deliveries: 2 }]);

  // Same event id redelivered with a status we handle (e.g. after adding an alias): it is not a "duplicate".
  const replay = await handleWebhook(db, { provider_event_id: 'EVT-x', provider_ref: ref, status: 'reversed' });
  assert.equal(replay.status, 'processed');
  assert.equal((await getTransfer(db, t.id)).status, 'returned');
  assert.equal(await availableCents(db, 'A'), FUNDING);
  const l = await ledgerFor(db, t.id);
  assert.equal(l.release?.n, 1);
  assert.equal(l.debit, undefined);
});
