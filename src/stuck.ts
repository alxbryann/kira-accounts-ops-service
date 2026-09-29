import type { PGlite } from '@electric-sql/pglite';
import { OPEN_STATUSES } from './transfers.js';

// Why a transfer is stuck, derived from its outbox row and any parked provider webhook:
//  - never_queued:        'created' with no outbox event, so the worker will never submit it (TICKET-204 class)
//  - submission_failed:   the outbox gave up after its retries
//  - queued:              still waiting in the outbox, possibly retrying after provider errors
//  - unrecognised_status: the provider answered with a status we don't model yet (TICKET-202 class)
//  - no_outcome:          submitted, but no final outcome has arrived from the provider
export type StuckReason = 'never_queued' | 'submission_failed' | 'queued' | 'unrecognised_status' | 'no_outcome';

export type StuckTransfer = {
  id: string; account_id: string; rail: string; status: string; provider_ref: string | null;
  updated_at: Date; age_minutes: number; held_cents: number;
  outbox_status: string | null; outbox_attempts: number | null; outbox_error: string | null; parked_events: number;
  reason: StuckReason; detail: string;
};

export const stuckAfterMinutes = (raw: unknown = process.env.STUCK_AFTER_MINUTES) => {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : 30;
};

// The age-based backstop: outbound transfers still in a non-terminal status (hold live, no debit) whose
// status hasn't changed for longer than `olderThanMinutes`. Whatever the cause, including ones we haven't
// thought of, a payout that stops moving shows up here. Oldest first.
export async function listStuckTransfers(db: PGlite, olderThanMinutes = stuckAfterMinutes()): Promise<StuckTransfer[]> {
  const r = await db.query<any>(`
    select t.id, t.account_id, t.rail, t.status, t.provider_ref, t.updated_at,
      extract(epoch from now() - t.updated_at) / 60 as age_minutes,
      (select sum(case l.entry_type when 'hold' then l.amount_cents when 'release' then -l.amount_cents else 0 end)
         from ledger_entries l where l.transfer_id = t.id) as held_cents,
      o.status as outbox_status, o.attempts as outbox_attempts, o.last_error as outbox_error,
      (select count(*) from unhandled_provider_events u where u.provider_ref = t.provider_ref and u.resolved_at is null)::int as parked_events
    from transfers t
    left join lateral (select * from outbox where outbox.transfer_id = t.id order by id desc limit 1) o on true
    where t.direction = 'outbound' and t.status = any($1) and t.updated_at <= now() - make_interval(secs => $2)
    order by t.updated_at, t.id`, [OPEN_STATUSES, olderThanMinutes * 60]);
  return r.rows.map((x) => {
    const row = { ...x, age_minutes: Number(x.age_minutes), held_cents: Number(x.held_cents ?? 0) };
    return { ...row, ...diagnose(row) };
  });
}

function diagnose(t: { status: string; outbox_status: string | null; outbox_attempts: number | null; outbox_error: string | null; parked_events: number }): { reason: StuckReason; detail: string } {
  if (t.status === 'created') {
    if (!t.outbox_status) return { reason: 'never_queued', detail: 'No outbox event: the worker will never submit it.' };
    if (t.outbox_status === 'failed') return { reason: 'submission_failed', detail: `Submission failed after ${t.outbox_attempts} attempts${t.outbox_error ? `: ${t.outbox_error}` : ''}.` };
    if (t.outbox_status === 'pending') return { reason: 'queued', detail: t.outbox_attempts ? `Waiting in the outbox, ${t.outbox_attempts} failed attempt(s)${t.outbox_error ? `: ${t.outbox_error}` : ''}.` : 'Waiting in the outbox; the worker has not picked it up.' };
  }
  if (t.parked_events > 0) return { reason: 'unrecognised_status', detail: `The provider answered with a status we don't recognise (${t.parked_events} parked event${t.parked_events === 1 ? '' : 's'}).` };
  return { reason: 'no_outcome', detail: 'Submitted, but no final outcome has arrived from the provider.' };
}
