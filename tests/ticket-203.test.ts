import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableCents } from '../src/ledger.js';
import { createOutboundTransfer, getTransfer } from '../src/transfers.js';
import { processOutbox } from '../src/outbox.js';
import { fresh, ledgerFor, FUNDING } from './helpers.js';

// TICKET-203: provider sends 'settled' and then 'failed' (distinct event ids) for the same payout.
test('203: a late "failed" after "settled" does not un-settle the payout or re-release the hold', async () => {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 75_000, idempotency_key: 'idem-203', scenario: 'out_of_order' });
  await processOutbox(db);

  const total = 75_000 + 2_175;
  assert.equal((await getTransfer(db, t.id)).status, 'settled', 'provider paid it');
  assert.equal(await availableCents(db, 'A'), FUNDING - total, 'balance must not be overstated');
  const l = await ledgerFor(db, t.id);
  assert.equal(l.release?.sum, l.hold?.sum, 'released exactly what was held');
  assert.equal(l.debit?.n, 1);
});
