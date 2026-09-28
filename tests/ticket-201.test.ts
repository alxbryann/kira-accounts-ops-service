import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableCents } from '../src/ledger.js';
import { createOutboundTransfer } from '../src/transfers.js';
import { processOutbox } from '../src/outbox.js';
import * as provider from '../src/providers.js';
import { fresh, rows, FUNDING } from './helpers.js';

// TICKET-201: two requests with the same Idempotency-Key in flight at the same time.
test('201: concurrent requests with the same idempotency key create exactly one transfer', async () => {
  const db = await fresh();
  const req = { account_id: 'A', rail: 'ach', amount_cents: 50_000, idempotency_key: 'idem-201' };
  const [a, b] = await Promise.all([createOutboundTransfer(db, req), createOutboundTransfer(db, req)]);

  assert.equal(a.id, b.id, 'both attempts must resolve to the same transfer');
  assert.equal((await rows(db, `select id from transfers where idempotency_key='idem-201'`)).length, 1);
  assert.equal((await rows(db, `select id from outbox`)).length, 1, 'only one submit event');

  await processOutbox(db);
  assert.equal(provider.submissions.length, 1, 'vendor paid once');
  assert.equal(await availableCents(db, 'A'), FUNDING - 50_000 - 1_450, 'balance debited once');
});
