// Mock payment-rail provider (sandbox). Like real providers, it:
//  - accepts a submission and returns a provider_ref
//  - reports outcomes asynchronously via webhooks (which may arrive out of order or be re-sent)
//  - occasionally times out AFTER accepting a payment
//  - de-duplicates on a client-supplied idempotency key, if one is provided
// Sandbox scenario codes (set on the transfer, like a test card number):
//   ok | reversed | out_of_order | timeout_once
export type WebhookEvent = { provider_event_id: string; provider_ref: string; status: string };

// Every outcome status we know how to apply. The raw webhook status is an untrusted string;
// it only becomes a ProviderStatus through normalizeProviderStatus.
export const PROVIDER_STATUSES = ['pending', 'settled', 'failed', 'returned', 'reversed'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

// The one place that maps what the provider sends onto our statuses. Provider aliases
// (e.g. a different spelling for 'settled') belong here, once confirmed against the provider's docs.
export function normalizeProviderStatus(raw: unknown): ProviderStatus | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return (PROVIDER_STATUSES as readonly string[]).includes(s) ? (s as ProviderStatus) : null;
}
export type Submission = { provider_ref: string; transfer_id: string; amount_cents: number; idem_key?: string; accepted_at: string; outcome: 'settled' | 'reversed' };

let seq = 0;
const nid = (p: string) => `${p}${(++seq).toString().padStart(4, '0')}`;
export const submissions: Submission[] = [];          // what the provider actually accepted (i.e. paid)
const timedOutOnce = new Set<string>();
const deferred = new Map<string, WebhookEvent[]>();   // webhooks the provider still owes for earlier acceptances

export class ProviderTimeout extends Error { constructor() { super('provider timeout (no response)'); this.name = 'ProviderTimeout'; } }

export function resetProvider() { submissions.length = 0; timedOutOnce.clear(); deferred.clear(); seq = 0; }

export function submit(t: { id: string; amount_cents: number; scenario?: string | null }, idemKey?: string): { provider_ref: string; webhooks: WebhookEvent[] } {
  const late = deferred.get(t.id) ?? []; deferred.delete(t.id);
  if (idemKey) {
    const prior = submissions.find((s) => s.idem_key === idemKey);
    if (prior) return { provider_ref: prior.provider_ref, webhooks: late };
  }
  const ref = nid('PROV-');
  const sc0 = t.scenario ?? 'ok';
  submissions.push({ provider_ref: ref, transfer_id: t.id, amount_cents: Number(t.amount_cents), idem_key: idemKey, accepted_at: new Date().toISOString(), outcome: sc0 === 'reversed' ? 'reversed' : 'settled' });
  const ev = (status: string) => ({ provider_event_id: nid('EVT-'), provider_ref: ref, status });

  const sc = t.scenario ?? 'ok';
  if (sc === 'timeout_once' && !timedOutOnce.has(t.id)) {
    timedOutOnce.add(t.id);
    deferred.set(t.id, [ev('settled')]);   // the payment WAS accepted; its webhook will arrive later
    throw new ProviderTimeout();           // ...but the client never hears back
  }
  if (sc === 'reversed') return { provider_ref: ref, webhooks: [...late, ev('reversed')] };
  if (sc === 'out_of_order') return { provider_ref: ref, webhooks: [...late, ev('settled'), ev('failed')] };
  return { provider_ref: ref, webhooks: [...late, ev('settled')] };
}

// Settlement statement as the provider would export it: settled payouts only, fees rounded half-up.
export function statement(): { provider_ref: string; amount_cents: number; fee_cents: number }[] {
  return submissions.filter((s) => s.outcome === 'settled').map((s) => ({ provider_ref: s.provider_ref, amount_cents: s.amount_cents, fee_cents: Math.floor(s.amount_cents * 0.029 + 0.5) }));
}
