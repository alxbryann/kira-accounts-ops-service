import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableCents } from '../src/ledger.js';
import { createOutboundTransfer, getTransfer } from '../src/transfers.js';
import { processOutbox } from '../src/outbox.js';
import { fresh, FUNDING } from './helpers.js';

// TICKET-202: the provider reports the payout as 'reversed'.
test('202: a reversed payout reaches a terminal state and releases its hold', async () => {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'crypto', amount_cents: 60_000, idempotency_key: 'idem-202', scenario: 'reversed' });
  await processOutbox(db);

  const after = await getTransfer(db, t.id);
  assert.ok(['returned', 'failed', 'reversed'].includes(after.status), `expected a terminal status, got '${after.status}'`);
  assert.equal(await availableCents(db, 'A'), FUNDING, 'funds must be released');
});
