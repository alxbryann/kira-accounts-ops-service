import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableCents } from '../src/ledger.js';
import { createOutboundTransfer } from '../src/transfers.js';
import { processOutbox } from '../src/outbox.js';
import { faults } from '../src/faults.js';
import { fresh, rows, FUNDING } from './helpers.js';

// TICKET-204: the API process dies between writing the transfer+hold and enqueuing the outbox event.
test('204: a crash mid-request never leaves a held transfer without an outbox event', async () => {
  const db = await fresh();
  faults.crashMidRequestFor = 'idem-204';
  await assert.rejects(createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 40_000, idempotency_key: 'idem-204' }));
  faults.crashMidRequestFor = undefined;

  const stranded = await rows(db, `select t.id from transfers t where t.direction='outbound' and t.status='created'
                                   and not exists (select 1 from outbox o where o.transfer_id=t.id)`);
  assert.deepEqual(stranded, [], 'no transfer may be held with nothing to submit it');
  assert.equal(await availableCents(db, 'A'), FUNDING, 'a failed request must not hold funds');
});

test('204: the client retry after the crash gets the payout submitted', async () => {
  const db = await fresh();
  const req = { account_id: 'A', rail: 'ach', amount_cents: 40_000, idempotency_key: 'idem-204' };
  faults.crashMidRequestFor = 'idem-204';
  await createOutboundTransfer(db, req).catch(() => {});
  faults.crashMidRequestFor = undefined;

  const t = await createOutboundTransfer(db, req);
  await processOutbox(db);
  assert.equal((await rows(db, `select status from transfers where id=$1`, [t.id]))[0].status, 'settled');
  assert.equal(await availableCents(db, 'A'), FUNDING - 40_000 - 1_160);
});
