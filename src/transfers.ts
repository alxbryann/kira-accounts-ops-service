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
  // Transfer, hold and outbox event commit together or not at all (TICKET-204). A crash in between used to
  // leave a committed hold with no outbox event, so the worker never submitted it and the funds stayed locked.
  const winner = await db.transaction(async (tx) => {
    // The insert itself claims the key: the unique index lets only one concurrent attempt win.
    // The pre-check above is just a fast path; this is what actually guarantees one transfer per key.
    const claimed = await tx.query(
      `insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status, idempotency_key, scenario)
       values ($1,$2,'outbound',$3,$4,$5,'created',$6,$7)
       on conflict (idempotency_key) where idempotency_key is not null do nothing
       returning id`,
      [id, opts.account_id, opts.rail, opts.amount_cents, fee, opts.idempotency_key ?? null, opts.scenario ?? null]
    );
    if (claimed.rows.length === 0) {
      return (await tx.query<any>(`select * from transfers where idempotency_key = $1`, [opts.idempotency_key])).rows[0];
    }
    await post(tx, { transfer_id: id, account_id: opts.account_id, entry_type: 'hold', amount_cents: opts.amount_cents + fee, memo: 'reserve outbound' });

    if (faults.crashMidRequestFor && faults.crashMidRequestFor === opts.idempotency_key) {
      throw new Error('process crashed (simulated)');
    }
    await tx.query(`insert into outbox(event_type, transfer_id) values ('transfer.submit', $1)`, [id]);
    return null;
  });
  if (winner) {
    log('transfer.idempotent_hit', { idempotency_key: opts.idempotency_key, transfer_id: winner.id, concurrent: true }, cid);
    return winner;
  }
  // Logged only after commit, so the log never claims a transfer that was rolled back.
  log('transfer.created', { transfer_id: id, amount_cents: opts.amount_cents, fee_cents: fee, idempotency_key: opts.idempotency_key }, cid);
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

// While a transfer is in one of these states its hold is still live and no debit has been posted.
export const OPEN_STATUSES = ['created', 'submitted', 'pending'];

export type Transition = { to: string; entries: { entry_type: 'debit' | 'release' | 'credit'; memo: string }[] };

/**
 * The transfer state machine: what a provider outcome does to a transfer in status `from`.
 * Returns the ledger entries to post (each for amount + fee) and the new status, or null when the
 * event must be ignored. Providers send late, out-of-order and contradictory webhooks with distinct
 * event ids (TICKET-203: 'settled' then 'failed'), so the decision depends on the CURRENT status,
 * never on the event alone. Every path keeps the ledger at exactly one hold, one release, and at most
 * one net debit, so no sequence of events can release the same money twice.
 */
export function planTransition(from: string, status: ProviderStatus): Transition | null {
  if (OPEN_STATUSES.includes(from)) {
    switch (status) {
      case 'pending':
        return { to: 'pending', entries: [] };
      case 'settled':
        return { to: 'settled', entries: [{ entry_type: 'debit', memo: 'settle outbound' }, { entry_type: 'release', memo: 'release hold (settled)' }] };
      case 'failed':
        return { to: 'failed', entries: [{ entry_type: 'release', memo: 'release hold (failed)' }] };
      case 'returned':
        return { to: 'returned', entries: [{ entry_type: 'release', memo: 'release hold (returned)' }] };
      case 'reversed':
        // Reversed before settlement: no debit was ever posted, so releasing the hold is the whole unwind.
        return { to: 'returned', entries: [{ entry_type: 'release', memo: 'release hold (reversed)' }] };
      default: {
        // Adding a status to PROVIDER_STATUSES without a case here is a compile error (TICKET-202).
        const unhandled: never = status;
        throw new Error(`no transition for provider status ${unhandled}`);
      }
    }
  }
  // Returned or reversed after settlement is a real clawback: the money came back to us. The debit
  // already happened and the hold is already released, so it is a credit, not another release.
  if (from === 'settled' && (status === 'returned' || status === 'reversed')) {
    return { to: 'returned', entries: [{ entry_type: 'credit', memo: `refund (${status} after settlement)` }] };
  }
  // 'settled' is the provider saying the money left. If a stale 'failed' got here first, the hold
  // is already released, so only the debit is missing. Ignoring this would overstate the balance.
  if (from === 'failed' && status === 'settled') {
    return { to: 'settled', entries: [{ entry_type: 'debit', memo: 'settle outbound (after failed, hold already released)' }] };
  }
  // Everything else is stale or contradicts a final outcome: settled→failed, settled→pending,
  // failed→failed, returned→anything, ... Posting it is how TICKET-203 released a paid payout's hold twice.
  return null;
}

// Apply a provider outcome to a transfer. The status read, the ledger entries and the status write happen
// in one transaction, so two webhooks for the same transfer can't both plan from the same status.
export async function applyProviderResult(db: PGlite, transfer: any, status: ProviderStatus, cid = '-', eventId?: string) {
  const total = Number(transfer.amount_cents) + Number(transfer.fee_cents);
  const { from, plan } = await db.transaction(async (tx) => {
    const from: string = (await tx.query<any>(`select status from transfers where id = $1 for update`, [transfer.id])).rows[0].status;
    const plan = planTransition(from, status);
    if (!plan) return { from, plan };
    for (const e of plan.entries) {
      await post(tx, { transfer_id: transfer.id, account_id: transfer.account_id, entry_type: e.entry_type, amount_cents: total, memo: e.memo });
    }
    if (eventId && faults.crashApplyingEvent === eventId) throw new Error('process crashed (simulated)');
    await tx.query(`update transfers set status = $1, updated_at = now() where id = $2`, [plan.to, transfer.id]);
    return { from, plan };
  });
  if (!plan) {
    // Not an error on our side, but a payout the provider reports two different ways deserves a human look.
    log('transfer.transition_ignored', { transfer_id: transfer.id, from, provider_status: status }, cid, 'warn');
    return;
  }
  if (from === 'failed' || from === 'settled') {
    log('transfer.outcome_changed', { transfer_id: transfer.id, from, to: plan.to, provider_status: status }, cid, 'warn');
  }
  log('transfer.provider_result', { transfer_id: transfer.id, from, to: plan.to, provider_status: status }, cid);
}
