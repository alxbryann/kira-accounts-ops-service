import type { PGlite } from '@electric-sql/pglite';
import { feeCents } from './money.js';
import { post } from './ledger.js';
import { log } from './logger.js';
import { faults } from './faults.js';
import type { ProviderStatus } from './providers.js';

// Ids count up per prefix (TX-0001, TX-0002, ...), so every run of the seed produces the same ids
// and the log written by one run names the same transfers another run serves.
const seq = new Map<string, number>();
export function newId(prefix: string) { const n = (seq.get(prefix) ?? 0) + 1; seq.set(prefix, n); return prefix + n.toString().padStart(4, '0'); }

export async function getByIdemKey(db: PGlite, key?: string | null) {
  if (!key) return null;
  const r = await db.query<any>(`select * from transfers where idempotency_key = $1`, [key]);
  return r.rows[0] ?? null;
}

export async function getTransfer(db: PGlite, id: string) {
  return (await db.query<any>(`select * from transfers where id = $1`, [id])).rows[0];
}

/**
 * Create an outbound transfer:
 *  1. de-dupe on the client's idempotency key
 *  2. insert the transfer and reserve funds with a 'hold'
 *  3. enqueue a 'transfer.submit' event for the worker to send to the provider
 */
export async function createOutboundTransfer(
  db: PGlite,
  opts: { account_id: string; rail: string; amount_cents: number; idempotency_key?: string; scenario?: string; correlation_id?: string }
) {
  const cid = opts.correlation_id ?? newId('CID-');
  const existing = await getByIdemKey(db, opts.idempotency_key);
  if (existing) { log('transfer.idempotent_hit', { idempotency_key: opts.idempotency_key, transfer_id: existing.id }, cid); return existing; }

  const id = newId('TX-');
  const fee = feeCents(opts.amount_cents);
  // The insert itself claims the key: the unique index lets only one concurrent attempt win.
  // The pre-check above is just a fast path; this is what actually guarantees one transfer per key.
  const claimed = await db.query(
    `insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, idempotency_key, scenario)
     values ($1,$2,'outbound',$3,$4,$5,'created',$6,$7)
     on conflict (idempotency_key) where idempotency_key is not null do nothing
     returning id`,
    [id, opts.account_id, opts.rail, opts.amount_cents, fee, opts.idempotency_key ?? null, opts.scenario ?? null]
  );
  if (claimed.rows.length === 0) {
    const winner = await getByIdemKey(db, opts.idempotency_key);
    log('transfer.idempotent_hit', { idempotency_key: opts.idempotency_key, transfer_id: winner.id, concurrent: true }, cid);
    return winner;
  }
  await post(db, { transfer_id: id, account_id: opts.account_id, entry_type: 'hold', amount_cents: opts.amount_cents + fee, memo: 'reserve outbound' });
  log('transfer.created', { transfer_id: id, amount_cents: opts.amount_cents, fee_cents: fee, idempotency_key: opts.idempotency_key }, cid);

  if (faults.crashMidRequestFor && faults.crashMidRequestFor === opts.idempotency_key) {
    throw new Error('process crashed (simulated)');
  }
  await db.query(`insert into outbox(event_type, transfer_id) values ('transfer.submit', $1)`, [id]);
  log('outbox.enqueued', { transfer_id: id, event_type: 'transfer.submit' }, cid);
  return getTransfer(db, id);
}

export async function creditInbound(db: PGlite, opts: { account_id: string; amount_cents: number; memo?: string }) {
  const id = newId('TX-');
  await db.query(`insert into transfers(id, account_id, direction, rail, amount_cents, status) values ($1,$2,'inbound','ach',$3,'settled')`, [id, opts.account_id, opts.amount_cents]);
  await post(db, { transfer_id: id, account_id: opts.account_id, entry_type: 'credit', amount_cents: opts.amount_cents, memo: opts.memo ?? 'inbound' });
  return id;
}

export async function setStatus(db: PGlite, id: string, status: string, provider_ref?: string) {
  await db.query(`update transfers set status=$1, provider_ref=coalesce($2, provider_ref), updated_at=now() where id=$3`, [status, provider_ref ?? null, id]);
}

// Apply a provider outcome to a transfer.
export async function applyProviderResult(db: PGlite, transfer: any, status: ProviderStatus, cid = '-') {
  const total = Number(transfer.amount_cents) + Number(transfer.fee_cents);
  switch (status) {
    case 'pending':
      await setStatus(db, transfer.id, 'pending');
      break;
    case 'settled':
      await post(db, { transfer_id: transfer.id, account_id: transfer.account_id, entry_type: 'debit', amount_cents: total, memo: 'settle outbound' });
      await post(db, { transfer_id: transfer.id, account_id: transfer.account_id, entry_type: 'release', amount_cents: total, memo: 'release hold (settled)' });
      await setStatus(db, transfer.id, 'settled');
      break;
    case 'failed':
      await post(db, { transfer_id: transfer.id, account_id: transfer.account_id, entry_type: 'release', amount_cents: total, memo: 'release hold (failed)' });
      await setStatus(db, transfer.id, 'failed');
      break;
    case 'returned':
      await post(db, { transfer_id: transfer.id, account_id: transfer.account_id, entry_type: 'release', amount_cents: total, memo: 'release hold (returned)' });
      await setStatus(db, transfer.id, 'returned');
      break;
    case 'reversed':
      // Reversed before settlement: no debit was ever posted, so releasing the hold is the whole unwind.
      await post(db, { transfer_id: transfer.id, account_id: transfer.account_id, entry_type: 'release', amount_cents: total, memo: 'release hold (reversed)' });
      await setStatus(db, transfer.id, 'returned');
      break;
    default: {
      // Adding a status to PROVIDER_STATUSES without a case here is a compile error.
      // Unknown statuses used to fall through silently and still log 'provider_result' (TICKET-202).
      // Log loudly instead of throwing: a throw here re-queues the outbox row and re-submits the payout.
      const unhandled: never = status;
      log('transfer.unhandled_provider_status', { transfer_id: transfer.id, from: transfer.status, provider_status: unhandled }, cid, 'error');
      return;
    }
  }
  log('transfer.provider_result', { transfer_id: transfer.id, from: transfer.status, provider_status: status }, cid);
}
