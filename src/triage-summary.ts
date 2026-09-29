import type { TriageReport } from './monitor.js';
import { toDollars } from './money.js';

// Optional: an LLM-drafted plain-language summary of the triage report, in English and Spanish, for a support
// lead or account manager. It is a draft: the numbers come from the report (the model is told not to invent
// any), and a human reviews it before anything reaches a client.
// Provider: DeepSeek's chat completions API. Key from `deepseek_api_key` (or DEEPSEEK_API_KEY) in the .env;
// DEEPSEEK_MODEL overrides the model.
const SYSTEM = `You write short incident summaries for the operations and client-support team of Kira, a payments company.
Input: a JSON triage report of payout anomalies. Write for a non-engineer.
Rules:
- Use only facts and amounts present in the report. Never invent causes, dates, names or numbers.
- Amounts are already in US dollars; copy them exactly as written. The total can count the same money twice, so call it "up to".
- Lead with what needs action today and how much money is affected, then the rest, most severe first.
- Name transfers and accounts by the ids in the report. Keep the suggested next steps from the report.
- No jargon (no "idempotency", "outbox", "webhook"); say what happened to the money.
- Plain text, no markdown. Two sections with these exact headings on their own line: "English" then "Español". Under 200 words each.`;

// The model only ever sees dollars: given raw *_cents fields it read 552183 cents as $552,183.00.
const usd = (c: number) => '$' + Number(toDollars(c)).toLocaleString('en-US', { minimumFractionDigits: 2 });
export function reportForModel(r: TriageReport) {
  return {
    generated_at: r.generated_at, status: r.status, stuck_after_minutes: r.stuck_after_minutes,
    total_findings: r.totals.findings, total_affected_upper_bound: usd(r.totals.at_risk_cents),
    checks: r.checks.filter((c) => c.findings.length).map((c) => ({
      title: c.title, severity: c.severity, meaning: c.meaning, affected: usd(c.at_risk_cents),
      findings: c.findings.map((f) => ({ subject: f.subject, account_id: f.account_id, amount: usd(f.amount_cents), detail: f.detail, next_step: f.action })),
    })),
  };
}

export const summaryConfigured = (env = process.env) => Boolean(env.deepseek_api_key ?? env.DEEPSEEK_API_KEY);

export async function draftSummary(report: TriageReport, env = process.env): Promise<string> {
  return chat(SYSTEM, reportForModel(report), env);
}

// Same idea for a webhook parked because the provider sent a status we don't support: what it probably means,
// what it does to the client's money right now, and what to do. The meaning is the model's reading of a
// status name, so it is told to present it as something to confirm in the provider's docs, never as fact.
const UNHANDLED_SYSTEM = `You write short alerts for the operations and client-support team of Kira, a payments company.
Input: JSON describing a webhook from our payment provider with a status our system does not recognise yet, the payout it refers to,
and the statuses we do support. The event was NOT applied: no money moved and any hold on the payout stays in place.
Rules:
- Use only facts and amounts present in the input. Never invent dates, names, reasons or numbers. Copy amounts exactly as written.
- Say what the status most likely means as a hypothesis ("likely", "probably") that must be confirmed in the provider's documentation.
- Say what it means for the client's money today (the payout's current status and the amount still held), then the next steps:
  confirm the meaning with the provider, map it to a supported status or add support for it, then replay the event from the ops dashboard.
- No jargon (no "webhook", "idempotency", "ledger"); say "a status update from the provider".
- Plain text, no markdown. Two sections with these exact headings on their own line: "English" then "Español". Under 120 words each.`;

export type ParkedEventForModel = {
  status_received: string; provider_event_id: string; deliveries: number;
  transfer_id: string | null; account_id: string | null; transfer_status: string | null; held_cents: number | null;
};
// Dollars only, for the same reason as reportForModel.
export function unhandledEventForModel(e: ParkedEventForModel, supported: readonly string[]) {
  return {
    status_received: e.status_received.slice(0, 80), provider_event_id: e.provider_event_id, deliveries: e.deliveries,
    payout: e.transfer_id ? { id: e.transfer_id, account_id: e.account_id, current_status: e.transfer_status, still_held: usd(e.held_cents ?? 0) } : null,
    supported_statuses: supported,
  };
}

export async function draftUnhandledSummary(e: ParkedEventForModel, supported: readonly string[], env = process.env): Promise<string> {
  return chat(UNHANDLED_SYSTEM, unhandledEventForModel(e, supported), env);
}

async function chat(system: string, input: unknown, env: NodeJS.ProcessEnv): Promise<string> {
  const key = env.deepseek_api_key ?? env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('no deepseek_api_key configured');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      max_tokens: 2000,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body: any = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('DeepSeek returned no text');
  return text.trim();
}
