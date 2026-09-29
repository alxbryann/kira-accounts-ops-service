import type { PGlite } from '@electric-sql/pglite';
import { applyProviderResult } from './transfers.js';
import { normalizeProviderStatus } from './providers.js';
import { log } from './logger.js';
import { defaultUnhandledDrafter, startUnhandledSummary, type UnhandledDrafter } from './escalations.js';

// Provider settlement webhook. Deliveries can be duplicated, so we de-dupe on provider_event_id.
// The select below is only a fast path; the claim in applyProviderResult is what guarantees apply-once.
// opts.draftUnhandled: who analyses a newly parked unknown status (default: DeepSeek if configured; null: nobody).
export async function handleWebhook(
  db: PGlite, evt: { provider_event_id: string; provider_ref: string; status: string; correlation_id?: string },
  opts: { draftUnhandled?: UnhandledDrafter | null } = {},
) {
  const cid = evt.correlation_id ?? '-';
  // Without an event id a delivery can't be de-duplicated, and without a ref it can't be matched: reject, don't guess.
  for (const f of ['provider_event_id', 'provider_ref'] as const) {
    if (typeof evt?.[f] !== 'string' || !evt[f]) throw Object.assign(new Error(`${f} is required`), { status: 400 });
  }
  const dup = await db.query(`select 1 from processed_events where provider_event_id = $1`, [evt.provider_event_id]);
  if (dup.rows.length) { log('webhook.duplicate_skipped', { provider_event_id: evt.provider_event_id }, cid); return { status: 'skipped' }; }

  // Validate before marking the event processed: an unknown status must not consume the event id,
  // or the transfer stays stuck with its hold and every redelivery is dropped as a duplicate (TICKET-202).
  const status = normalizeProviderStatus(evt.status);
  if (!status) {
    const { correlation_id: _cid, ...payload } = evt;
    const draft = opts.draftUnhandled !== undefined ? opts.draftUnhandled : defaultUnhandledDrafter();
    const parked = await db.query<{ deliveries: number }>(
      `insert into unhandled_provider_events(provider_event_id, provider_ref, raw_status, payload, summary_status) values ($1, $2, $3, $4, $5)
       on conflict (provider_event_id) do update set deliveries = unhandled_provider_events.deliveries + 1,
         raw_status = excluded.raw_status, payload = excluded.payload, last_seen_at = now()
       returning deliveries`,
      [evt.provider_event_id, evt.provider_ref, String(evt.status), JSON.stringify(payload), draft ? 'pending' : 'skipped'],
    );
    log('webhook.unhandled_status', { provider_event_id: evt.provider_event_id, provider_ref: evt.provider_ref, status: evt.status }, cid, 'error');
    // First delivery only (the insert, not a redelivery): start the AI analysis now, without waiting for it.
    // Concurrent first deliveries race on the primary key, so exactly one of them sees deliveries = 1.
    if (draft && parked.rows[0].deliveries === 1) startUnhandledSummary(db, evt.provider_event_id, draft, cid);
    return { status: 'unhandled_status' };
  }

  const t = (await db.query<any>(`select * from transfers where provider_ref = $1`, [evt.provider_ref])).rows[0];
  if (!t) {
    // Not consumed: the outcome can arrive before we have stored the provider_ref (e.g. the submit timed out,
    // TICKET-205). Marking it processed here would drop the provider's redelivery as a duplicate and strand the hold.
    log('webhook.unknown_transfer', { provider_event_id: evt.provider_event_id, provider_ref: evt.provider_ref, status: evt.status }, cid, 'warn');
    return { status: 'unknown_transfer' };
  }
  log('webhook.received', { provider_event_id: evt.provider_event_id, provider_ref: evt.provider_ref, transfer_id: t.id, status: evt.status, current_status: t.status }, cid);
  // The event id is claimed inside the same transaction that applies it (see applyProviderResult).
  const res = await applyProviderResult(db, t, status, cid, evt.provider_event_id);
  return { status: res === 'duplicate' ? 'skipped' : 'processed' };
}

// Re-run parked events through handleWebhook, e.g. after deploying support for a new status or alias.
// Events whose status is still unknown are left untouched (not counted as another delivery).
export async function replayUnhandledEvents(db: PGlite, cid = 'OPS-replay') {
  const parked = (await db.query<any>(
    `select provider_event_id, provider_ref, raw_status, payload from unhandled_provider_events where resolved_at is null order by first_seen_at`,
  )).rows;
  const results: { provider_event_id: string; result: string }[] = [];
  for (const p of parked) {
    if (!normalizeProviderStatus(p.raw_status)) { results.push({ provider_event_id: p.provider_event_id, result: 'still_unhandled' }); continue; }
    const res = await handleWebhook(db, { ...(p.payload ?? {}), provider_event_id: p.provider_event_id, provider_ref: p.provider_ref, status: p.raw_status, correlation_id: cid });
    results.push({ provider_event_id: p.provider_event_id, result: res.status });
  }
  log('ops.replay_unhandled', { replayed: results.length, results }, cid);
  return results;
}
