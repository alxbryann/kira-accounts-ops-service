import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableCents } from '../src/ledger.js';
import { createOutboundTransfer, creditInbound, getTransfer, setStatus } from '../src/transfers.js';
import { handleWebhook } from '../src/webhooks.js';
import { processOutbox } from '../src/outbox.js';
import { PROVIDER_STATUSES, type ProviderStatus } from '../src/providers.js';
import { fresh, rows, ledgerFor, FUNDING } from './helpers.js';

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
  const ignored = await rows(db, `select 1 from ledger_entries where transfer_id=$1 and memo like '%failed%'`, [t.id]);
  assert.equal(ignored.length, 0, 'the stale failure posted nothing');
});

// Every sequence of up to 3 provider events, applied to a freshly submitted payout. Whatever the order,
// the balance has to match the transfer's final status. It is never higher than what the provider paid out.
test('203: no sequence of provider events overstates the balance or releases a hold twice', async () => {
  const db = await fresh();
  const seqs: ProviderStatus[][] = [[]];
  for (let len = 0; len < 3; len++) for (const s of seqs.filter((x) => x.length === len)) for (const st of PROVIDER_STATUSES) seqs.push([...s, st]);

  let n = 0;
  for (const seq of seqs.slice(1)) {
    const acct = `S${++n}`;
    await db.query(`insert into accounts(id,name) values ($1,$1)`, [acct]);
    await creditInbound(db, { account_id: acct, amount_cents: FUNDING });
    const t = await createOutboundTransfer(db, { account_id: acct, rail: 'ach', amount_cents: 10_000, idempotency_key: `idem-${acct}` });
    await setStatus(db, t.id, 'submitted', `PROV-${acct}`);
    for (const [i, status] of seq.entries()) await handleWebhook(db, { provider_event_id: `EVT-${acct}-${i}`, provider_ref: `PROV-${acct}`, status });

    const total = Number(t.amount_cents) + Number(t.fee_cents);
    const final = (await getTransfer(db, t.id)).status;
    const l = await ledgerFor(db, t.id);
    const label = `${seq.join(' → ')} ended ${final}`;

    assert.ok((l.release?.sum ?? 0) <= l.hold.sum, `${label}: released more than was held`);
    assert.ok((l.debit?.n ?? 0) <= 1, `${label}: debited more than once`);
    assert.ok((l.credit?.n ?? 0) <= 1, `${label}: refunded more than once`);
    // Money is gone while the payout is in flight (held) or once it has settled; it's back after failed/returned.
    const expected = ['submitted', 'pending', 'settled'].includes(final) ? FUNDING - total : FUNDING;
    assert.equal(await availableCents(db, acct), expected, `${label}: balance`);
    // Once the provider has said 'settled', only an explicit return/reversal can give the money back.
    if (seq.includes('settled')) assert.ok(['settled', 'returned'].includes(final), `${label}: a paid payout was marked ${final}`);
  }
});

test('203: settled then returned is a clawback, credited once; a later event cannot move it again', async () => {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 75_000, idempotency_key: 'idem-claw' });
  await setStatus(db, t.id, 'submitted', 'PROV-claw');
  for (const [i, status] of (['settled', 'returned', 'reversed', 'settled', 'failed'] as const).entries()) {
    await handleWebhook(db, { provider_event_id: `EVT-claw-${i}`, provider_ref: 'PROV-claw', status });
  }
  assert.equal((await getTransfer(db, t.id)).status, 'returned');
  assert.equal(await availableCents(db, 'A'), FUNDING, 'money came back exactly once');
  const l = await ledgerFor(db, t.id);
  assert.deepEqual([l.hold.n, l.debit.n, l.release.n, l.credit.n], [1, 1, 1, 1]);
});

test('203: failed then settled posts the missing debit, because the provider did pay', async () => {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 75_000, idempotency_key: 'idem-late' });
  await setStatus(db, t.id, 'submitted', 'PROV-late');
  await handleWebhook(db, { provider_event_id: 'EVT-late-0', provider_ref: 'PROV-late', status: 'failed' });
  await handleWebhook(db, { provider_event_id: 'EVT-late-1', provider_ref: 'PROV-late', status: 'settled' });
  assert.equal((await getTransfer(db, t.id)).status, 'settled');
  assert.equal(await availableCents(db, 'A'), FUNDING - 77_175);
  const l = await ledgerFor(db, t.id);
  assert.deepEqual([l.hold.n, l.release.n, l.debit.n], [1, 1, 1], 'the release from "failed" is not repeated');
});

test('203: two webhooks for the same transfer delivered concurrently apply only one outcome', async () => {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 75_000, idempotency_key: 'idem-race' });
  await setStatus(db, t.id, 'submitted', 'PROV-race');
  await Promise.all([
    handleWebhook(db, { provider_event_id: 'EVT-race-0', provider_ref: 'PROV-race', status: 'settled' }),
    handleWebhook(db, { provider_event_id: 'EVT-race-1', provider_ref: 'PROV-race', status: 'failed' }),
  ]);
  const l = await ledgerFor(db, t.id);
  assert.equal(l.release.n, 1, 'the hold is released once, whichever event won');
  const final = (await getTransfer(db, t.id)).status;
  assert.equal(await availableCents(db, 'A'), final === 'settled' ? FUNDING - 77_175 : FUNDING);
});
