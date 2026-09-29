import type { PGlite } from '@electric-sql/pglite';
import * as provider from './providers.js';
import { getTransfer, markSubmitted } from './transfers.js';
import { handleWebhook } from './webhooks.js';
import { log } from './logger.js';

const MAX_ATTEMPTS = 3;

// Worker: drain pending outbox events, submit each transfer to the provider, then deliver
// the provider's webhooks. Transient provider errors are retried on the next pass.
export async function processOutbox(db: PGlite, cid = 'WORKER') {
  const events = (await db.query<any>(`select * from outbox where status='pending' order by id`)).rows;
  for (const ev of events) {
    const t = await getTransfer(db, ev.transfer_id);
    try {
      // The transfer id is the provider idempotency key (TICKET-205): a timeout can hide an accepted payment,
      // so every retry must carry the same key and the provider returns the original acceptance instead of paying again.
      const res = provider.submit(t, t.id);
      await markSubmitted(db, t.id, res.provider_ref);
      await db.query(`update outbox set status='processed', processed_at=now(), attempts=attempts+1 where id=$1`, [ev.id]);
      log('provider.submitted', { transfer_id: t.id, provider_ref: res.provider_ref, attempt: ev.attempts + 1 }, cid);
      for (const w of res.webhooks) await handleWebhook(db, { ...w, correlation_id: cid });
    } catch (e: any) {
      const attempts = ev.attempts + 1;
      const final = attempts >= MAX_ATTEMPTS;
      await db.query(`update outbox set attempts=$1, last_error=$2, status=$3 where id=$4`, [attempts, e.message, final ? 'failed' : 'pending', ev.id]);
      log('provider.submit_error', { transfer_id: t.id, attempt: attempts, error: e.message, will_retry: !final }, cid, 'warn');
    }
  }
}
