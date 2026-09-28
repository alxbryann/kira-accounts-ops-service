import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutboundTransfer } from '../src/transfers.js';
import { processOutbox } from '../src/outbox.js';
import { reconcile } from '../src/reconciliation.js';
import { fresh } from './helpers.js';

// TICKET-206: routine payouts whose 2.9% fee lands on .5 or above a cent.
test('206: clean payouts reconcile to zero against the provider statement', async () => {
  const db = await fresh();
  for (const amt of [155_500, 172_400, 88_300, 420_000, 250_900]) {
    await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: amt, idempotency_key: `k-${amt}` });
  }
  await processOutbox(db);

  const r = await reconcile(db);
  assert.deepEqual(r.feeMismatches, []);
  assert.equal(r.diffCents, 0);
});
