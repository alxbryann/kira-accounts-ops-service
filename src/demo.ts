import { openDb } from './db.js';
import { seedInto } from './bootstrap.js';
import { availableCents } from './ledger.js';
import { reconcile } from './reconciliation.js';
import * as provider from './providers.js';

const db = await openDb();
const acc = await seedInto(db);
const q = async (sql: string, p: any[] = []) => (await db.query<any>(sql, p)).rows;
console.log('=== Kira Accounts Ops Service — open incidents ===\n');
console.log(`Account ${acc} available: $${((await availableCents(db, acc)) / 100).toFixed(2)}`);

const t201 = await q(`select id, status from transfers where idempotency_key='idem-201'`);
console.log(`\n[TICKET-201] transfers for idempotency_key idem-201: ${t201.length} (client sent ONE payout)`);

const t202 = await q(`select id, status, provider_ref from transfers where idempotency_key='idem-202'`);
console.log(`\n[TICKET-202] reversed payout: status=${t202[0]?.status} (client says provider reversed it; funds still held?)`);

const t203 = await q(`select id, status from transfers where idempotency_key='idem-203'`);
const e203 = await q(`select entry_type, count(*)::int c from ledger_entries where transfer_id=$1 group by entry_type order by entry_type`, [t203[0]?.id]);
console.log(`\n[TICKET-203] out-of-order payout: status=${t203[0]?.status} (provider paid it) · ledger entries: ${e203.map((r:any)=>r.entry_type+'x'+r.c).join(', ')}`);

const t204 = await q(`select id, status, provider_ref from transfers where idempotency_key='idem-204'`);
const stranded = await q(`select count(*)::int c from transfers t where t.direction='outbound' and t.status='created' and not exists (select 1 from outbox o where o.transfer_id=t.id)`);
console.log(`\n[TICKET-204] crashed request: ${t204.length ? `status=${t204[0].status}` : 'rolled back, no transfer left behind'} · held transfers with no outbox event: ${stranded[0].c} (funds held, never submitted?)`);

const t205 = await q(`select id, status from transfers where idempotency_key='idem-205'`);
const subs205 = provider.submissions.filter((s) => s.transfer_id === t205[0]?.id).length;
console.log(`\n[TICKET-205] timeout payout: status=${t205[0]?.status}, provider accepted it ${subs205} time(s) (expected 1)`);

const r = await reconcile(db);
console.log(`\n[TICKET-206] reconciliation: diff=${r.diffCents}c, fee mismatches=${r.feeMismatches.length}, statement-only payouts=${r.statementOnly.length}`);
console.log('\nOps triage: `npm run monitor` (today) or `npm run monitor -- --snapshot` (the pre-fix incident state).');
await db.close();
