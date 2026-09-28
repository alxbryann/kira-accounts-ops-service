import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutboundTransfer } from '../src/transfers.js';
import { processOutbox } from '../src/outbox.js';
import * as provider from '../src/providers.js';
import { fresh } from './helpers.js';

// TICKET-205: provider accepts the payment but the response times out; the worker retries.
test('205: a retry after a provider timeout does not pay the vendor twice', async () => {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 120_000, idempotency_key: 'idem-205', scenario: 'timeout_once' });
  await processOutbox(db); // times out (provider already accepted)
  await processOutbox(db); // retry

  assert.equal(provider.submissions.filter((s) => s.transfer_id === t.id).length, 1, 'provider accepted it once');
  assert.equal(provider.statement().length, 1);
});
