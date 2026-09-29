import type { PGlite } from '@electric-sql/pglite';
import type { MailTransport } from './mailer.js';
import { runTriage, formatReport, type TriageReport } from './monitor.js';
import { draftSummary, summaryConfigured } from './triage-summary.js';
import { toDollars } from './money.js';
import { esc, kira, when } from './html.js';
import { log } from './logger.js';

export type SummaryStatus = 'pending' | 'ready' | 'failed' | 'skipped';
export type TriageEscalation = {
  id: number; fingerprint: string; report: TriageReport; summary: string | null; summary_status: SummaryStatus; summary_error: string | null;
  created_at: Date; sent_at: Date | null; send_claimed_at: Date | null; send_attempts: number; last_error: string | null;
};

// How long a mail waits for its AI summary before going out without it. The summary is optional; the alert is not,
// so a hung or lost draft (e.g. the process restarted mid-call) must not hold a critical escalation back for good.
export const SUMMARY_DEADLINE_MS = 2 * 60_000;
// A mail pass that claimed an escalation and died before finishing: after this long another pass may take it over.
const CLAIM_TIMEOUT = '5 minutes';

// What makes two passes "the same problem": the critical/high findings. Stuck payouts (medium) come and go
// with the clock and would mail on every pass, so they ride along in the report but don't trigger a mail.
export function fingerprint(r: TriageReport) {
  return r.checks.filter((c) => c.severity !== 'medium').flatMap((c) => c.findings.map((f) => `${c.id}:${f.subject}`)).sort().join('\n');
}

export async function latestEscalation(db: PGlite): Promise<TriageEscalation | null> {
  return (await db.query<any>(`select * from triage_escalations order by id desc limit 1`)).rows[0] ?? null;
}

// Step 1 (monitor pass): when the monitor has critical/high findings that weren't escalated before, store the
// report and start drafting the plain-language summary right away, without waiting for it. The mail is sent
// separately by sendTriageEscalations once the summary is ready. `drafted` settles when the draft is stored,
// for callers that want to wait (the CLI, tests); the server doesn't. The LLM is called once per escalation.
export async function processTriageEscalation(
  db: PGlite,
  opts: { stuckAfter?: number; draft?: ((r: TriageReport) => Promise<string>) | null } = {},
  cid = 'TRIAGE',
): Promise<{ escalated: false; id?: number } | { escalated: true; id: number; drafted: Promise<void> }> {
  const report = await runTriage(db, { stuckAfter: opts.stuckAfter });
  if (report.status !== 'action_needed') return { escalated: false };
  const fp = fingerprint(report);
  const last = await latestEscalation(db);
  if (last && last.fingerprint === fp) return { escalated: false, id: last.id };

  // null: explicitly no summary; undefined: DeepSeek if a key is configured.
  const draft = opts.draft !== undefined ? opts.draft : summaryConfigured() ? (r: TriageReport) => draftSummary(r) : null;
  const row: TriageEscalation = (await db.query<any>(
    `insert into triage_escalations(fingerprint, report, summary_status) values ($1, $2, $3) returning *`,
    [fp, JSON.stringify(report), draft ? 'pending' : 'skipped'])).rows[0];
  log('ops.triage_escalation_created', { escalation_id: row.id, findings: report.totals.findings, summary: row.summary_status }, cid, 'warn');
  return { escalated: true, id: row.id, drafted: draft ? storeDraft(db, row.id, report, draft, cid) : Promise.resolve() };
}

// Runs in the background; never rejects. Only a still-pending row is updated: if the deadline already sent the
// mail without a summary, a late draft is dropped, so the dashboard keeps showing exactly what was mailed.
async function storeDraft(db: PGlite, id: number, report: TriageReport, draft: (r: TriageReport) => Promise<string>, cid: string) {
  try {
    const summary = await draft(report);
    const ok = await db.query(`update triage_escalations set summary = $2, summary_status = 'ready' where id = $1 and summary_status = 'pending' returning id`, [id, summary]);
    log(ok.rows.length ? 'ops.triage_summary_ready' : 'ops.triage_summary_late', { escalation_id: id }, cid, ok.rows.length ? 'info' : 'warn');
  } catch (e: any) {
    const error = String(e?.message ?? e);
    await db.query(`update triage_escalations set summary_error = $2, summary_status = 'failed' where id = $1 and summary_status = 'pending'`, [id, error])
      .catch(() => {});
    log('ops.triage_summary_failed', { escalation_id: id, error }, cid, 'warn');
  }
}

// Step 2 (mail worker): send every unsent escalation whose summary is no longer pending: ready (with it), or
// failed/skipped (report only). A pending one is left for a later pass, unless it has waited past the deadline.
// A failed send is retried on the next pass with the stored summary, never re-drafted.
export async function sendTriageEscalations(
  db: PGlite, transport: MailTransport,
  opts: { to?: string; dashboardUrl?: string; summaryDeadlineMs?: number } = {},
  cid = 'TRIAGE',
) {
  const deadline = opts.summaryDeadlineMs ?? SUMMARY_DEADLINE_MS;
  const expired = await db.query<{ id: number }>(
    `update triage_escalations set summary_status = 'failed', summary_error = $1
     where sent_at is null and summary_status = 'pending' and created_at <= now() - $2 * interval '1 millisecond' returning id`,
    [`no summary after ${Math.round(deadline / 1000)}s; sent without it`, deadline]);
  for (const { id } of expired.rows) log('ops.triage_summary_timeout', { escalation_id: id }, cid, 'warn');

  const to = opts.to ?? process.env.ALERT_EMAIL_TO ?? process.env.gmail ?? 'ops@localhost';
  const dashboardUrl = opts.dashboardUrl ?? process.env.OPS_DASHBOARD_URL ?? `http://localhost:${process.env.PORT ?? 3000}/ops`;
  const ready = (await db.query<{ id: number }>(
    `select id from triage_escalations where sent_at is null and summary_status <> 'pending' order by id`)).rows;
  const results: { id: number; sent: boolean; error?: string }[] = [];
  for (const { id } of ready) {
    // Claim before sending: two overlapping passes (a slow SMTP call outlasts the interval) must not both mail it.
    const row: TriageEscalation | undefined = (await db.query<any>(
      `update triage_escalations set send_claimed_at = now()
       where id = $1 and sent_at is null and (send_claimed_at is null or send_claimed_at < now() - interval '${CLAIM_TIMEOUT}') returning *`,
      [id])).rows[0];
    if (!row) continue;
    try {
      await transport.send({ to, ...triageMail(row.report, row.summary, dashboardUrl) });
      await db.query(`update triage_escalations set sent_at = now(), send_claimed_at = null, send_attempts = send_attempts + 1, last_error = null where id = $1`, [id]);
      log('ops.triage_escalated', { escalation_id: id, to, findings: row.report.totals.findings, summary: row.summary_status }, cid, 'warn');
      results.push({ id, sent: true });
    } catch (e: any) {
      const error = String(e?.message ?? e);
      await db.query(`update triage_escalations set send_claimed_at = null, send_attempts = send_attempts + 1, last_error = $2 where id = $1`, [id, error]);
      log('ops.triage_escalation_failed', { escalation_id: id, to, error }, cid, 'error');
      results.push({ id, sent: false, error });
    }
  }
  return results;
}

const usd = (c: number) => '$' + Number(toDollars(c)).toLocaleString('en-US', { minimumFractionDigits: 2 });
const DRAFT_NOTE = 'AI draft from the report below; check it against the report before sharing.';

export function triageMail(r: TriageReport, summary: string | null, dashboardUrl: string) {
  const urgent = r.checks.filter((c) => c.findings.length && c.severity !== 'medium').reduce((a, c) => a + c.findings.length, 0);
  const subject = `[Kira ops] Triage: ${urgent} finding${urgent === 1 ? '' : 's'} need action · up to ${usd(r.totals.at_risk_cents)} affected`;
  const text = [
    ...(summary ? ['SUMMARY', `(${DRAFT_NOTE})`, '', summary, '', '---', ''] : []),
    formatReport(r), `Dashboard: ${dashboardUrl}`,
  ].join('\n');
  return { subject, text, html: triageMailHtml(r, summary, dashboardUrl) };
}

// Same email conventions as escalations.ts: tables and inline styles only, every value escaped.
function triageMailHtml(r: TriageReport, summary: string | null, dashboardUrl: string) {
  const k = kira;
  const eyebrow = `font-family:${k.font};font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${k.pinkSoft};`;
  const card = (inner: string) => `<tr><td style="padding:0 0 14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${k.surface}" style="background-color:${k.surface};border:1px solid ${k.border};border-radius:20px;"><tr><td style="padding:20px 24px;">${inner}</td></tr></table></td></tr>`;
  const p = (t: string, color: string = k.text, size = 14) => `<p style="margin:0 0 8px;font-family:${k.font};font-size:${size}px;line-height:1.55;color:${color};">${t}</p>`;
  const sev = (s: string, active: boolean) => `<span style="font-family:${k.font};font-size:11px;font-weight:600;color:#FFFFFF;background-color:${active && s !== 'medium' ? '#BB1187' : '#5D1A3F'};border-radius:999px;padding:3px 10px;">${esc(s)}</span>`;
  const checks = r.checks.filter((c) => c.findings.length).map((c) => card(`
    <div style="margin:0 0 10px;">${sev(c.severity, true)} <span style="font-family:${k.display};font-size:18px;font-weight:500;color:${k.text};vertical-align:-1px;">&nbsp;${esc(c.title)}</span>
      <span style="font-family:${k.font};font-size:13px;color:${k.pinkSoft};">&nbsp;· ${c.findings.length} · ${usd(c.at_risk_cents)}</span></div>
    ${p(esc(c.meaning), k.textMuted, 13)}
    ${c.findings.map((f) => `<div style="border-top:1px solid rgba(255,255,255,.08);padding-top:10px;margin-top:10px;">
      ${p(`<strong style="font-weight:600;">${esc(f.subject)}</strong>${f.account_id ? ` <span style="color:${k.textMuted};">· ${esc(f.account_id)}</span>` : ''}`)}
      ${p(esc(f.detail), k.textSoft, 13)}
      ${p(`<span style="color:${k.pinkSoft};font-weight:600;">Next step:</span> ${esc(f.action)}`, k.text, 13)}</div>`).join('')}`)).join('');
  const summaryCard = summary ? card(`<div style="${eyebrow}">Summary · Resumen</div>
    <div style="margin-top:10px;font-family:${k.font};font-size:14px;line-height:1.6;color:${k.text};white-space:pre-wrap;">${esc(summary)}</div>
    <div style="margin-top:12px;font-family:${k.font};font-size:11px;color:${k.textMuted};">${esc(DRAFT_NOTE)}</div>`) : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"></head>
<body style="margin:0;padding:0;background-color:${k.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${k.bg}" style="background-color:${k.bg};">
  <tr><td align="center" style="padding:28px 16px 40px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;">
      <tr><td align="center" style="padding:0 8px 24px;">
        <div style="${eyebrow}">Ops triage · ${esc(when(new Date(r.generated_at)))}</div>
        <h1 style="margin:14px 0 10px;font-family:${k.display};font-size:32px;line-height:1.15;font-weight:500;color:${k.blush};">Action <span style="color:${k.pinkBright};">needed</span></h1>
        ${p(`${r.totals.findings} finding(s) · up to ${usd(r.totals.at_risk_cents)} affected`, k.textMuted)}
      </td></tr>
      ${summaryCard}
      ${checks}
      <tr><td style="padding:14px 4px 0;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td bgcolor="${k.magenta}" style="background-color:${k.magenta};border-radius:999px;"><a href="${esc(dashboardUrl)}" style="display:inline-block;padding:15px 26px;font-family:${k.font};font-size:13px;font-weight:700;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">Open dashboard &nbsp;&rarr;</a></td>
      </tr></table></td></tr>
      <tr><td style="padding:28px 4px 0;">${p('Sent by kira-accounts-ops-service. One email per new set of critical/high findings; the same findings are not mailed again.', 'rgba(255,255,255,.45)', 11)}</td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}
