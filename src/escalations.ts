import type { PGlite } from '@electric-sql/pglite';
import type { MailTransport } from './mailer.js';
import { toDollars } from './money.js';
import { log } from './logger.js';
import { esc, kira, when } from './html.js';
import { draftUnhandledSummary, summaryConfigured, type ParkedEventForModel } from './triage-summary.js';
import { PROVIDER_STATUSES } from './providers.js';
import { SUMMARY_DEADLINE_MS, type SummaryStatus } from './triage-escalation.js';

export type UnhandledEvent = {
  provider_event_id: string; provider_ref: string; raw_status: string; payload: unknown; deliveries: number;
  first_seen_at: Date; last_seen_at: Date; escalated_at: Date | null; escalation_attempts: number;
  summary: string | null; summary_status: SummaryStatus; summary_error: string | null;
  last_escalation_error: string | null; resolved_at: Date | null;
  transfer_id: string | null; account_id: string | null; transfer_status: string | null; held_cents: number | null;
};

// Parked webhooks joined with the transfer they point at, oldest first.
export async function listUnhandledEvents(db: PGlite, filter: 'all' | 'open' | 'to_escalate' | { id: string } = 'all'): Promise<UnhandledEvent[]> {
  const byId = typeof filter === 'object';
  const where = byId ? 'u.provider_event_id = $1'
    : { all: 'true', open: 'u.resolved_at is null', to_escalate: 'u.resolved_at is null and u.escalated_at is null' }[filter];
  const r = await db.query<any>(`
    select u.*, t.id as transfer_id, t.account_id, t.status as transfer_status,
      -- What is still reserved for the transfer, straight from the ledger (holds minus releases).
      (select sum(case l.entry_type when 'hold' then l.amount_cents when 'release' then -l.amount_cents else 0 end)
         from ledger_entries l where l.transfer_id = t.id) as held_cents
    from unhandled_provider_events u left join transfers t on t.provider_ref = u.provider_ref
    where ${where} order by u.first_seen_at, u.provider_event_id`, byId ? [filter.id] : []);
  return r.rows.map((x) => ({ ...x, held_cents: x.held_cents == null ? null : Number(x.held_cents) }));
}

export type UnhandledDrafter = (e: ParkedEventForModel) => Promise<string>;
// DeepSeek when a key is configured, otherwise no analysis (the event is parked as 'skipped').
export const defaultUnhandledDrafter = (): UnhandledDrafter | null =>
  summaryConfigured() ? (e) => draftUnhandledSummary(e, PROVIDER_STATUSES) : null;

const drafting = new Set<Promise<void>>();
// Settles when every analysis started so far is stored; for the CLI and tests (the server never waits on it).
export const unhandledSummariesSettled = async () => { await Promise.all([...drafting]); };

// Called by handleWebhook the first time an event is parked. Runs in the background and never rejects, so the
// webhook response never waits on the LLM. Only a still-pending event is updated: if the deadline already
// mailed it without the analysis, a late one is dropped and the dashboard keeps showing what was mailed.
export function startUnhandledSummary(db: PGlite, id: string, draft: UnhandledDrafter, cid = '-') {
  const job = (async () => {
    try {
      const [e] = await listUnhandledEvents(db, { id });
      if (!e) return;
      const summary = await draft({ ...e, status_received: e.raw_status });
      const ok = await db.query(`update unhandled_provider_events set summary = $2, summary_status = 'ready' where provider_event_id = $1 and summary_status = 'pending' returning 1`, [id, summary]);
      log(ok.rows.length ? 'ops.unhandled_summary_ready' : 'ops.unhandled_summary_late', { provider_event_id: id }, cid, ok.rows.length ? 'info' : 'warn');
    } catch (err: any) {
      const error = String(err?.message ?? err);
      await db.query(`update unhandled_provider_events set summary_error = $2, summary_status = 'failed' where provider_event_id = $1 and summary_status = 'pending'`, [id, error])
        .catch(() => {});
      log('ops.unhandled_summary_failed', { provider_event_id: id, error }, cid, 'warn');
    }
  })();
  drafting.add(job);
  job.finally(() => drafting.delete(job));
  return job;
}

// Escalate newly parked webhooks to ops by email: one mail per pass listing every new event, so a burst
// of the same unknown status doesn't send hundreds of mails. Runs outside the webhook path (like the
// outbox worker): a slow or failing SMTP never delays or fails a webhook, and a failed send is retried next pass.
// An event whose AI analysis is still pending waits for a later pass, up to the same deadline as the triage
// mail; past it, it goes out without the analysis (the alert matters more than the analysis).
export async function processEscalations(
  db: PGlite, transport: MailTransport, opts: { to?: string; dashboardUrl?: string; summaryDeadlineMs?: number } = {}, cid = 'ESCALATIONS',
) {
  const deadline = opts.summaryDeadlineMs ?? SUMMARY_DEADLINE_MS;
  const expired = await db.query<{ provider_event_id: string }>(
    `update unhandled_provider_events set summary_status = 'failed', summary_error = $1
     where escalated_at is null and resolved_at is null and summary_status = 'pending' and first_seen_at <= now() - $2 * interval '1 millisecond'
     returning provider_event_id`,
    [`no analysis after ${Math.round(deadline / 1000)}s; sent without it`, deadline]);
  for (const r of expired.rows) log('ops.unhandled_summary_timeout', { provider_event_id: r.provider_event_id }, cid, 'warn');

  const pending = (await listUnhandledEvents(db, 'to_escalate')).filter((e) => e.summary_status !== 'pending');
  if (!pending.length) return { sent: 0 };
  const ids = pending.map((e) => e.provider_event_id);
  // Without an explicit recipient, escalate to the Gmail account that sends (if configured).
  const to = opts.to ?? process.env.ALERT_EMAIL_TO ?? process.env.gmail ?? 'ops@localhost';
  const dashboardUrl = opts.dashboardUrl ?? process.env.OPS_DASHBOARD_URL ?? `http://localhost:${process.env.PORT ?? 3000}/ops`;
  try {
    await transport.send({ to, ...escalationMail(pending, dashboardUrl) });
    await db.query(`update unhandled_provider_events set escalated_at = now(), escalation_attempts = escalation_attempts + 1, last_escalation_error = null where provider_event_id = any($1)`, [ids]);
    log('ops.escalation_sent', { to, provider_event_ids: ids }, cid, 'warn');
    return { sent: ids.length };
  } catch (e: any) {
    await db.query(`update unhandled_provider_events set escalation_attempts = escalation_attempts + 1, last_escalation_error = $2 where provider_event_id = any($1)`, [ids, String(e?.message ?? e)]);
    log('ops.escalation_failed', { to, provider_event_ids: ids, error: String(e?.message ?? e) }, cid, 'error');
    return { sent: 0, error: String(e?.message ?? e) };
  }
}

// raw_status comes straight from the webhook body: cap it so a hostile or broken payload can't bloat the mail.
const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n) + '…' : s);
const AI_NOTE = 'AI draft; the status meaning is a guess to confirm in the provider docs';
const NEXT_STEPS = `Check the status in the provider's docs, add it (or an alias) in normalizeProviderStatus / applyProviderResult, deploy, then press "Replay open events" on the dashboard.`;

export function escalationMail(events: UnhandledEvent[], dashboardUrl: string) {
  const n = events.length;
  const intro = `The payment provider sent ${n === 1 ? 'a webhook' : `${n} webhooks`} with a status we don't recognise.`;
  const impact = `Nothing was applied: no ledger entries were posted, so any hold on these transfers stays in place and the client's funds stay reserved until this is resolved.`;
  const lines = events.map((e) => [
    `- Event ${e.provider_event_id} (provider ref ${e.provider_ref})`,
    `  Status received: "${clip(e.raw_status)}"`,
    e.transfer_id
      ? `  Transfer ${e.transfer_id} · account ${e.account_id} · status ${e.transfer_status} · $${toDollars(e.held_cents ?? 0)} held`
      : `  No transfer matches this provider ref`,
    `  First seen ${new Date(e.first_seen_at).toISOString()} · deliveries ${e.deliveries}`,
    ...(e.summary ? ['', `  AI analysis (${AI_NOTE}):`, ...e.summary.split('\n').map((l) => `  ${l}`)] : []),
  ].join('\n'));
  return {
    subject: `[Kira ops] ${n} provider webhook${n === 1 ? '' : 's'} with an unrecognised status`,
    text: [intro, impact, '', ...lines, '', `Next steps: ${NEXT_STEPS}`, `Dashboard: ${dashboardUrl}`].join('\n'),
    html: escalationMailHtml(events, dashboardUrl, intro, impact),
  };
}

// Email HTML: table layout and inline styles only, since mail clients (Gmail included) drop most <style> rules.
// Gradients are progressive enhancement: every background also has a solid bgcolor, so clients that
// ignore background-image still render the dark Kira surfaces.
function escalationMailHtml(events: UnhandledEvent[], dashboardUrl: string, intro: string, impact: string) {
  const k = kira;
  const held = events.reduce((s, e) => s + (e.held_cents ?? 0), 0);
  const label = `font-family:${k.font};font-size:12px;font-weight:500;color:${k.textMuted};`;
  const eyebrow = `font-family:${k.font};font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${k.pinkSoft};`;
  const kv = (name: string, value: string) =>
    `<tr><td style="padding:6px 0;${label}width:96px;vertical-align:top;">${name}</td><td style="padding:6px 0;font-family:${k.font};font-size:14px;color:${k.text};">${value}</td></tr>`;
  const dim = (v: string) => `<span style="color:${k.textMuted};">${v}</span>`;
  const eventCard = (e: UnhandledEvent, i: number) => `
    <tr><td style="padding:0 0 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${k.surface}" style="background-color:${k.surface};border:1px solid ${k.border};border-radius:20px;">
        <tr><td style="padding:22px 24px;">
          <div style="${eyebrow}">Event ${String(i + 1).padStart(2, '0')} / ${String(events.length).padStart(2, '0')}</div>
          <div style="margin:12px 0 14px;"><span style="font-family:${k.mono};font-size:13px;font-weight:600;color:#FFFFFF;background-color:#BB1187;border-radius:8px;padding:5px 11px;">${esc(clip(e.raw_status))}</span></div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${kv('Event', `${esc(e.provider_event_id)} ${dim(`· ${esc(e.provider_ref)}`)}`)}
            ${e.transfer_id
              ? kv('Transfer', `${esc(e.transfer_id)} ${dim(`· ${esc(e.account_id)} · ${esc(e.transfer_status)}`)}`) + kv('Held', `<strong style="font-weight:600;color:${k.pinkSoft};">$${toDollars(e.held_cents ?? 0)}</strong>`)
              : kv('Transfer', dim('No matching transfer'))}
            ${kv('First seen', `${esc(when(e.first_seen_at))} ${dim(`· ${e.deliveries} deliver${e.deliveries === 1 ? 'y' : 'ies'}`)}`)}
          </table>
          ${e.summary ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.08);">
            <div style="${eyebrow}">AI analysis · Análisis</div>
            <div style="margin-top:10px;font-family:${k.font};font-size:14px;line-height:1.6;color:${k.text};white-space:pre-wrap;">${esc(e.summary)}</div>
            <div style="margin-top:10px;font-family:${k.font};font-size:11px;color:${k.textMuted};">${esc(AI_NOTE)}.</div></div>` : ''}
        </td></tr>
      </table>
    </td></tr>`;
  const stat = (name: string, value: string, glow: boolean) => `
    <td width="49%" valign="top" bgcolor="${glow ? k.surfaceGlow : k.surface}" style="background-color:${glow ? k.surfaceGlow : k.surface};${glow ? `background-image:linear-gradient(135deg, ${k.surfaceGlow} 0%, ${k.surface} 75%);` : ''}border:1px solid ${k.border};border-radius:20px;padding:20px 22px;">
      <div style="${label}">${name}</div>
      <div style="margin-top:8px;font-family:${k.display};font-size:32px;line-height:1.1;font-weight:500;color:${glow ? k.pinkSoft : k.text};">${value}</div>
    </td>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background-color:${k.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${k.bg}" style="background-color:${k.bg};background-image:radial-gradient(70% 320px at 50% 0%, ${k.glow} 0%, rgba(117,12,87,0) 100%);background-repeat:no-repeat;">
  <tr><td align="center" style="padding:28px 16px 40px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
      <tr><td align="center" style="padding:0 0 28px;">
        <table role="presentation" cellpadding="0" cellspacing="0" bgcolor="${k.nav}" style="background-color:${k.nav};border:1px solid rgba(255,0,133,.25);border-radius:999px;">
          <tr><td style="padding:10px 20px;font-family:${k.display};font-size:20px;font-weight:500;color:${k.text};">
            <span style="color:${k.pinkBright};">&#9670;</span> kira
            <span style="margin-left:10px;font-family:${k.font};font-size:12px;font-weight:500;color:${k.text};background-color:${k.navActive};border-radius:8px;padding:4px 10px;vertical-align:3px;">Ops alert</span>
          </td></tr>
        </table>
      </td></tr>
      <tr><td align="center" style="padding:0 8px 28px;">
        <div style="${eyebrow}">Provider webhooks</div>
        <h1 style="margin:14px 0 14px;font-family:${k.display};font-size:34px;line-height:1.12;font-weight:500;color:${k.blush};">
          ${events.length === 1 ? 'A webhook needs' : `${events.length} webhooks need`} <span style="color:${k.pinkBright};">attention</span></h1>
        <p style="margin:0 0 8px;font-family:${k.font};font-size:16px;line-height:1.55;color:${k.text};">${esc(intro)}</p>
        <p style="margin:0;font-family:${k.font};font-size:14px;line-height:1.55;color:${k.textMuted};">${esc(impact)}</p>
      </td></tr>
      <tr><td style="padding:0 0 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          ${stat('Open events', String(events.length), true)}
          <td width="12" style="width:12px;min-width:12px;font-size:0;line-height:0;">&nbsp;</td>
          ${stat('Funds held', `$${toDollars(held)}`, false)}
        </tr></table>
      </td></tr>
      <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${events.map(eventCard).join('')}</table></td></tr>
      <tr><td style="padding:18px 4px 0;">
        <div style="${eyebrow}">Next steps</div>
        <p style="margin:10px 0 26px;font-family:${k.font};font-size:14px;line-height:1.6;color:${k.textMuted};">${esc(NEXT_STEPS)}</p>
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td bgcolor="${k.magenta}" style="background-color:${k.magenta};border-radius:999px;">
            <a href="${esc(dashboardUrl)}" style="display:inline-block;padding:15px 26px;font-family:${k.font};font-size:13px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">Open dashboard &nbsp;&rarr;</a>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:36px 4px 0;border-top:0;">
        <div style="height:1px;background-color:rgba(255,255,255,.08);line-height:1px;font-size:0;">&nbsp;</div>
        <p style="margin:16px 0 0;font-family:${k.font};font-size:11px;line-height:1.6;color:rgba(255,255,255,.45);">
          Sent by kira-accounts-ops-service. One email per batch of new events; redeliveries of an event already reported don't trigger another email.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}
