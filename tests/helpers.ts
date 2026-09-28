import { openDb } from '../src/db.js';
import { creditInbound } from '../src/transfers.js';
import * as provider from '../src/providers.js';
import { faults } from '../src/faults.js';

export const FUNDING = 1_000_000;

export async function fresh() {
  provider.resetProvider();
  faults.crashMidRequestFor = undefined;
  const db = await openDb();
  await db.query(`insert into accounts(id,name) values ('A','Test')`);
  await creditInbound(db, { account_id: 'A', amount_cents: FUNDING });
  return db;
}

type Db = Awaited<ReturnType<typeof fresh>>;
export const rows = async (db: Db, sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;

// Per-entry-type counts/sums for one transfer's ledger entries.
export async function ledgerFor(db: Db, transferId: string) {
  const r = await rows(db, `select entry_type, count(*)::int n, sum(amount_cents)::bigint s from ledger_entries where transfer_id=$1 group by entry_type`, [transferId]);
  return Object.fromEntries(r.map((x) => [x.entry_type, { n: x.n, sum: Number(x.s) }])) as Record<string, { n: number; sum: number }>;
}
