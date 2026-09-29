import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutboundTransfer } from '../src/transfers.js';
import { processOutbox } from '../src/outbox.js';
import { reconcile } from '../src/reconciliation.js';
import { availableCents } from '../src/ledger.js';
import { feeCents } from '../src/money.js';
import * as provider from '../src/providers.js';
import { fresh, FUNDING } from './helpers.js';

// TICKET-206: routine payouts whose 2.9% fee lands on .5 or above a cent.
test('206: clean payouts reconcile to zero against the provider statement', async () => {
  const db = await fresh();
  for (const amt of [155_500, 172_400, 88_300, 420_000, 250_900]) {
    await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: amt, idempotency_key: `k-${amt}` });
  }
  await processOutbox(db);

  const r = await reconcile(db);
  assert.deepEqual(r.feeMismatches, []);
  assert.deepEqual(r.statementOnly, []);
  assert.deepEqual(r.ledgerOnly, []);
  assert.equal(r.diffCents, 0);
});

test('206: the client is debited the fee the provider books (half-up), not a floored one', async () => {
  const db = await fresh();
  await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 155_500, idempotency_key: 'k-half' });
  await processOutbox(db);
  assert.equal(await availableCents(db, 'A'), FUNDING - 155_500 - 4_510); // 2.9% = 4509.5 -> 4510
});

test('206: fee rounding boundaries', () => {
  assert.equal(feeCents(155_500), 4_510);  // exactly .5 rounds up
  assert.equal(feeCents(172_400), 5_000);  // .6 rounds up
  assert.equal(feeCents(88_300), 2_561);   // .7 (2560.7000000000003 in floating point)
  assert.equal(feeCents(250_900), 7_276);  // .1 rounds down
  assert.equal(feeCents(420_000), 12_180); // exact
  assert.equal(feeCents(10_000), 290);
  assert.equal(feeCents(17), 0);           // 0.493 rounds down
  assert.equal(feeCents(18), 1);           // 0.522 rounds up
  assert.equal(feeCents(0), 0);
});

// The provider's statement is the source of truth for fees. Compare against its own output over a
// wide sweep of amounts (including every fractional-cent residue), not a copy of its formula.
test('206: our fee matches the provider statement fee for every amount in the sweep', () => {
  provider.resetProvider();
  const amounts: number[] = [];
  for (let a = 1; a <= 20_000; a++) amounts.push(a);                  // covers all 1000 residues many times
  for (let a = 1_000_000; a <= 100_000_000; a += 99_991) amounts.push(a); // large payouts
  for (const a of amounts) provider.submit({ id: `T-${a}`, amount_cents: a });
  const mismatches = provider.statement().filter((s) => s.fee_cents !== feeCents(s.amount_cents));
  assert.deepEqual(mismatches.slice(0, 5), []);
  provider.resetProvider();
});
