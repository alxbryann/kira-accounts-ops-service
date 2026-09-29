import type { PGlite } from '@electric-sql/pglite';
import { applyProviderResult } from './transfers.js';
import { normalizeProviderStatus } from './providers.js';
import { log } from './logger.js';

// Provider settlement webhook. Deliveries can be duplicated, so we de-dupe on provider_event_id.
export async function handleWebhook(db: PGlite, evt: { provider_event_id: string; provider_ref: string; status: string; correlation_id?: string }) {
  const cid = evt.correlation_id ?? '-';
  const dup = await db.query(`select 1 from processed_events where provider_event_id = $1`, [evt.provider_event_id]);
  if (dup.rows.length) { log('webhook.duplicate_skipped', { provider_event_id: evt.provider_event_id }, cid); return { status: 'skipped' }; }

  // Validate before marking the event processed: an unknown status must not consume the event id,
  // or the transfer stays stuck with its hold and every redelivery is dropped as a duplicate (TICKET-202).
  const status = normalizeProviderStatus(evt.status);
  if (!status) {
    await db.query(
      `insert into unhandled_provider_events(provider_event_id, provider_ref, raw_status) values ($1, $2, $3)
       on conflict (provider_event_id) do update set deliveries = unhandled_provider_events.deliveries + 1, raw_status = excluded.raw_status, last_seen_at = now()`,
      [evt.provider_event_id, evt.provider_ref, String(evt.status)],
    );
    log('webhook.unhandled_status', { provider_event_id: evt.provider_event_id, provider_ref: evt.provider_ref, status: evt.status }, cid, 'error');
    return { status: 'unhandled_status' };
  }
  await db.query(`insert into processed_events(provider_event_id) values ($1)`, [evt.provider_event_id]);

  const t = (await db.query<any>(`select * from transfers where provider_ref = $1`, [evt.provider_ref])).rows[0];
  if (!t) { log('webhook.unknown_transfer', { provider_event_id: evt.provider_event_id, provider_ref: evt.provider_ref, status: evt.status }, cid, 'warn'); return { status: 'unknown_transfer' }; }
  log('webhook.received', { provider_event_id: evt.provider_event_id, provider_ref: evt.provider_ref, transfer_id: t.id, status: evt.status, current_status: t.status }, cid);
  await applyProviderResult(db, t, status, cid);
  return { status: 'processed' };
}
