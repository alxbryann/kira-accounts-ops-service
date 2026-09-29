import type { PGlite } from '@electric-sql/pglite';
import * as provider from './providers.js';
import { post } from './ledger.js';

// With the fixes in place, seeding no longer produces the incidents: the seed reaches a clean state. This
// rewrites a freshly seeded database into the state production was left in *before* the fixes (the
// "Remediation" sections of FINDINGS.md), so the ops monitor can be run against real incident data.
// Demo/test use only. It drops the TICKET-201 unique index because production had duplicates before the
// migration; POST /transfers needs that index, so don't serve the API from a snapshot database.
export async function loadIncidentSnapshot(db: PGlite) {
  const one = async (key: string) => (await db.query<any>(`select * from transfers where idempotency_key = $1`, [key])).rows[0];
  const total = (t: any) => Number(t.amount_cents) + Number(t.fee_cents);
  const aged = `now() - interval '3 hours'`;

  // 201: the concurrent retry created a second transfer for the same key, submitted and settled on both sides.
  await db.query(`drop index if exists transfers_idempotency_key_uq`);
  const t201 = await one('idem-201');
  const dup = 'TX-201-DUP', dupRef = 'PROV-201-DUP';
  await db.query(`insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, idempotency_key, provider_ref, created_at)
                  values ($1, $2, 'outbound', $3, $4, $5, 'settled', 'idem-201', $6, $7::timestamptz + interval '1 millisecond')`,
    [dup, t201.account_id, t201.rail, t201.amount_cents, t201.fee_cents, dupRef, t201.created_at]);
  for (const [entry_type, memo] of [['hold', 'reserve outbound'], ['debit', 'settle outbound'], ['release', 'release hold (settled)']]) {
    await post(db, { transfer_id: dup, account_id: t201.account_id, entry_type, amount_cents: total(t201), memo });
  }
  provider.submissions.push({ provider_ref: dupRef, transfer_id: dup, amount_cents: Number(t201.amount_cents), accepted_at: new Date().toISOString(), outcome: 'settled' });

  // 202: 'reversed' was swallowed. Still submitted, hold never released.
  const t202 = await one('idem-202');
  await db.query(`delete from ledger_entries where transfer_id = $1 and entry_type = 'release'`, [t202.id]);
  await db.query(`update transfers set status = 'submitted', updated_at = ${aged} where id = $1`, [t202.id]);

  // 203: 'settled' then a stale 'failed': the hold was released twice and the status overwritten.
  const t203 = await one('idem-203');
  await post(db, { transfer_id: t203.id, account_id: t203.account_id, entry_type: 'release', amount_cents: total(t203), memo: 'release hold (failed)' });
  await db.query(`update transfers set status = 'failed' where id = $1`, [t203.id]);

  // 204: the crash committed the transfer and its hold, but no outbox event.
  const t204 = 'TX-204-SNAP';
  await db.query(`insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, idempotency_key, created_at, updated_at)
                  values ($1, $2, 'outbound', 'ach', 40000, 1160, 'created', 'idem-204', ${aged}, ${aged})`, [t204, t201.account_id]);
  await post(db, { transfer_id: t204, account_id: t201.account_id, entry_type: 'hold', amount_cents: 41_160, memo: 'reserve outbound' });

  // 205: the retry after the timeout was paid again; our transfer only knows one of the two provider refs.
  const t205 = await one('idem-205');
  provider.submissions.push({ provider_ref: 'PROV-205-DUP', transfer_id: t205.id, amount_cents: Number(t205.amount_cents), accepted_at: new Date().toISOString(), outcome: 'settled' });

  // 206: fees floored instead of rounded half-up, 1 cent short on three routine payouts.
  for (const amt of [155_500, 172_400, 88_300]) {
    const t = await one(`idem-206-${amt}`);
    await db.query(`update transfers set fee_cents = fee_cents - 1 where id = $1`, [t.id]);
    await db.query(`update ledger_entries set amount_cents = amount_cents - 1 where transfer_id = $1`, [t.id]);
  }
}
