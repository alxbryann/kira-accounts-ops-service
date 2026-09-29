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
  const key = env.deepseek_api_key ?? env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('no deepseek_api_key configured');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      max_tokens: 2000,
      temperature: 0.2,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(reportForModel(report)) }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body: any = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('DeepSeek returned no text');
  return text.trim();
}
