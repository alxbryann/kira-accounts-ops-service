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