import type { UnhandledEvent } from './escalations.js';
import type { StuckTransfer, StuckReason } from './stuck.js';
import type { TriageReport } from './monitor.js';
import type { TriageEscalation } from './triage-escalation.js';
import { toDollars } from './money.js';
import { esc, kira, when } from './html.js';

function escalationPill(e: UnhandledEvent) {
  if (e.resolved_at) return `<span class="pill pill-ok"><i></i>Resolved</span><div class="sub">${esc(when(e.resolved_at))}</div>`;
  if (e.escalated_at) return `<span class="pill pill-ok"><i></i>Email sent</span><div class="sub">${esc(when(e.escalated_at))}</div>`;
  if (e.last_escalation_error) return `<span class="pill pill-bad" title="${esc(e.last_escalation_error)}">Email failed ×${e.escalation_attempts}</span><div class="sub">retrying</div>`;
  return `<span class="pill pill-wait">Pending</span>`;
}

function row(e: UnhandledEvent) {
  return `<tr>
    <td><span class="tag">${esc(e.raw_status)}</span></td>
    <td><div class="strong">${esc(e.provider_event_id)}</div><div class="sub">${esc(e.provider_ref)}</div></td>
    <td>${e.transfer_id
      ? `<a class="strong" href="/transfers/${encodeURIComponent(e.transfer_id)}">${esc(e.transfer_id)}</a><div class="sub">${esc(e.account_id)} · ${esc(e.transfer_status)}</div>`
      : '<span class="sub">No matching transfer</span>'}</td>
    <td class="num strong">${e.held_cents == null ? '—' : '$' + toDollars(e.held_cents)}</td>
    <td>${esc(when(e.first_seen_at))}<div class="sub">${e.deliveries} deliver${e.deliveries === 1 ? 'y' : 'ies'}</div></td>
    <td>${escalationPill(e)}</td>
  </tr>`;
}

function table(events: UnhandledEvent[], empty: string) {
  if (!events.length) return `<div class="card empty"><span class="dot"></span>${empty}</div>`;
  return `<div class="card table-wrap"><table>
    <thead><tr><th>Status received</th><th>Event</th><th>Transfer</th><th class="num">Held</th><th>First seen</th><th>Escalation</th></tr></thead>
    <tbody>${events.map(row).join('')}</tbody></table></div>`;
}

const REASON_LABEL: Record<StuckReason, string> = {
  never_queued: 'Never queued', submission_failed: 'Submission failed', queued: 'Queued',
  unrecognised_status: 'Unrecognised status', no_outcome: 'No outcome',
};
// The reasons that won't fix themselves are loud; the ones that may still resolve (a retry, a late webhook) are soft.
const LOUD: StuckReason[] = ['never_queued', 'submission_failed', 'unrecognised_status'];

const age = (minutes: number) => {
  const m = Math.floor(minutes);
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
};

function stuckRow(t: StuckTransfer) {
  return `<tr>
    <td><a class="strong" href="/transfers/${encodeURIComponent(t.id)}">${esc(t.id)}</a><div class="sub">${esc(t.account_id)} · ${esc(t.rail)}</div></td>
    <td><span class="tag">${esc(t.status)}</span>${t.provider_ref ? `<div class="sub">${esc(t.provider_ref)}</div>` : ''}</td>
    <td class="num strong">$${toDollars(t.held_cents)}</td>
    <td class="strong">${age(t.age_minutes)}<div class="sub">since ${esc(when(t.updated_at))}</div></td>
    <td class="wrap"><span class="pill ${LOUD.includes(t.reason) ? 'pill-bad' : 'pill-wait'}">${REASON_LABEL[t.reason]}</span><div class="sub">${esc(t.detail)}</div></td>
  </tr>`;
}

function stuckTable(stuck: StuckTransfer[], stuckAfter: number) {
  if (!stuck.length) return `<div class="card empty"><span class="dot"></span>No payout has been stuck for more than ${stuckAfter} min.</div>`;
  return `<div class="card table-wrap"><table>
    <thead><tr><th>Transfer</th><th>Status</th><th class="num">Held</th><th>Stuck for</th><th>Likely cause</th></tr></thead>
    <tbody>${stuck.map(stuckRow).join('')}</tbody></table></div>`;
}

// One row per monitor check: severity, what it means, how many and how much. Details live in /ops/triage.txt.
function triageTable(r: TriageReport) {
  return `<div class="card table-wrap"><table>
    <thead><tr><th>Check</th><th>Severity</th><th class="num">Found</th><th class="num">Amount</th><th>What it means</th></tr></thead>
    <tbody>${r.checks.map((c) => `<tr>
      <td class="strong">${esc(c.title)}</td>
      <td><span class="pill ${c.findings.length && c.severity !== 'medium' ? 'pill-bad' : 'pill-wait'}">${esc(c.severity)}</span></td>
      <td class="num strong">${c.findings.length}</td>
      <td class="num strong">${c.findings.length ? '$' + toDollars(c.at_risk_cents) : '—'}</td>
      <td class="wrap"><div class="sub">${c.findings.length ? esc(c.findings[0].subject) + (c.findings.length > 1 ? ` and ${c.findings.length - 1} more` : '') : 'Nothing found.'}</div></td>
    </tr>`).join('')}</tbody></table></div>`;
}

// The last triage escalation, exactly as mailed: when, whether the mail went out, and the AI summary.
function escalationCard(e: TriageEscalation | null | undefined) {
  if (!e) return '';
  const pill = e.sent_at ? `<span class="pill pill-ok"><i></i>Email sent</span> <span class="sub">${esc(when(e.sent_at))}</span>`
    : e.last_error ? `<span class="pill pill-bad" title="${esc(e.last_error)}">Email failed ×${e.send_attempts}</span> <span class="sub">retrying</span>`
    : '<span class="pill pill-wait">Sending</span>';
  const summary = e.summary
    ? `<div class="summary">${esc(e.summary)}</div><div class="sub">AI draft from the report; check it against the report before sharing.</div>`
    : `<div class="sub">${e.summary_error ? `AI summary unavailable: ${esc(e.summary_error)}` : 'No AI summary (deepseek_api_key not set).'} The full report is in the email and at /ops/triage.txt.</div>`;
  return `<div class="card escalation"><div class="esc-head"><div class="eyebrow">Last escalation · ${esc(when(e.created_at))}</div><div>${pill}</div></div>
    <div class="sub">${e.report.totals.findings} finding(s) · up to $${toDollars(e.report.totals.at_risk_cents)} affected</div>${summary}</div>`;
}

// Simple stand-in for the Kira mark (a magenta diamond, same as in the escalation email); not the official asset.
export const kiraMark = (size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
  <defs><linearGradient id="km" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${kira.pinkSoft}"/><stop offset="1" stop-color="${kira.magenta}"/></linearGradient></defs>
  <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" transform="rotate(45 12 12)" fill="url(#km)"/></svg>`;

export function renderDashboard({ events, stuck = [], stuckAfter = 30, flash, triage, escalation }: { events: UnhandledEvent[]; stuck?: StuckTransfer[]; stuckAfter?: number; flash?: string; triage?: TriageReport; escalation?: TriageEscalation | null }) {
  const open = events.filter((e) => !e.resolved_at);
  const resolved = events.filter((e) => e.resolved_at);
  // A transfer can be both stuck and the target of an open event: count its hold once.
  const heldByTransfer = new Map<string, number>();
  for (const t of stuck) heldByTransfer.set(t.id, t.held_cents);
  for (const e of open) if (e.transfer_id) heldByTransfer.set(e.transfer_id, e.held_cents ?? 0);
  const held = [...heldByTransfer.values()].reduce((a, b) => a + b, 0);
  const notEscalated = open.filter((e) => !e.escalated_at).length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15"><meta name="color-scheme" content="dark"><title>Kira Ops · Payout triage</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Raleway:wght@500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:${kira.bg}; --bg-raised:${kira.bgRaised}; --surface:${kira.surface}; --surface-glow:${kira.surfaceGlow};
    --nav:${kira.nav}; --nav-active:${kira.navActive}; --magenta:${kira.magenta}; --pink:${kira.pink}; --pink-bright:${kira.pinkBright};
    --pink-soft:${kira.pinkSoft}; --blush:${kira.blush}; --glow:${kira.glow};
    --text:${kira.text}; --muted:${kira.textMuted}; --soft:${kira.textSoft};
    --border:${kira.border}; --border-subtle:${kira.borderSubtle};
    --r-sm:8px; --r-lg:24px; --r-pill:999px;
  }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; color:var(--text); font:400 14px/1.55 ${kira.font}; -webkit-font-smoothing:antialiased;
    background: radial-gradient(60% 420px at 50% 0%, var(--glow) 0%, rgba(117,12,87,0) 100%), var(--bg); background-repeat:no-repeat; background-color:var(--bg); }
  .container { width:min(100% - 32px, 1280px); margin-inline:auto; }
  a { color:inherit; text-decoration:none; } a:hover { color:var(--pink-soft); }

  .nav { position:sticky; top:16px; z-index:5; margin-top:16px; display:flex; align-items:center; justify-content:space-between; gap:16px;
    height:60px; padding:0 10px 0 20px; border-radius:var(--r-pill); border:1px solid rgba(255,0,133,.25);
    background:rgba(82,1,46,.72); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); }
  .brand { display:flex; align-items:center; gap:8px; }
  .wordmark { font:500 22px ${kira.display}; letter-spacing:-0.01em; }
  .nav-item { font-size:14px; padding:6px 12px; border-radius:var(--r-sm); background:var(--nav-active); }
  .live { display:flex; align-items:center; gap:8px; height:40px; padding:0 14px; border-radius:var(--r-pill); background:rgba(200,176,189,.16); color:var(--soft); font-size:13px; font-weight:500; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--pink); box-shadow:0 0 12px var(--pink); display:inline-block; flex:none; }

  header.hero { padding:88px 0 56px; text-align:center; }
  .eyebrow { font-size:12px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--pink-soft); }
  h1 { font:500 56px/1.05 ${kira.display}; letter-spacing:-0.02em; margin:16px auto 20px; max-width:900px;
    background:linear-gradient(90deg, var(--blush) 0%, var(--pink-soft) 45%, var(--pink-bright) 100%); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .lead { max-width:680px; margin:0 auto; color:var(--muted); font-size:18px; }

  .card { border:1px solid var(--border); border-radius:var(--r-lg); background:var(--surface); }
  .card.glow { background:radial-gradient(80% 90% at 0% 0%, var(--surface-glow) 0%, var(--surface) 65%); }
  .stats { display:grid; grid-template-columns:repeat(4, 1fr); gap:24px; }
  .stat { padding:28px; }
  .stat .label { font-size:13px; color:var(--muted); }
  .stat .value { font:500 40px/1.1 ${kira.display}; letter-spacing:-0.02em; margin-top:10px; font-variant-numeric:tabular-nums; }
  .stat.alert .value { color:var(--pink-soft); }

  section { padding:72px 0 0; } section:last-of-type { padding-bottom:120px; }
  .section-head { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:24px; }
  h2 { font:500 30px/1.15 ${kira.display}; letter-spacing:-0.01em; margin:10px 0 0; }
  .hint { color:var(--muted); font-size:13px; margin-top:6px; }

  .button { display:inline-flex; align-items:center; gap:14px; height:52px; padding:0 5px 0 22px; border:0; border-radius:var(--r-pill);
    background:var(--magenta); color:#fff; font:700 13px ${kira.font}; letter-spacing:.02em; text-transform:uppercase; cursor:pointer;
    transition:transform .2s cubic-bezier(.2,.8,.2,1), filter .2s; }
  .button .arrow { width:42px; height:42px; border-radius:50%; background:#fff; color:#0E0010; display:grid; place-items:center; font-size:18px; }
  .button:hover { transform:translateY(-1px); filter:brightness(1.1); }
  .button:disabled { background:rgba(255,255,255,.08); color:var(--muted); cursor:not-allowed; transform:none; filter:none; }
  .button:disabled .arrow { background:rgba(255,255,255,.12); color:var(--muted); }

  .table-wrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; min-width:860px; }
  th { text-align:left; font-size:12px; font-weight:500; color:var(--muted); padding:18px 24px; border-bottom:1px solid var(--border-subtle); white-space:nowrap; }
  td { padding:20px 24px; border-bottom:1px solid var(--border-subtle); vertical-align:top; }
  tbody tr:last-child td { border-bottom:0; }
  tbody tr:hover td { background:rgba(255,255,255,.03); }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .strong { font-weight:500; color:var(--text); }
  .sub { color:var(--muted); font-size:12px; margin-top:2px; }
  td .strong, td .sub { white-space:nowrap; }
  td.wrap .sub { white-space:normal; max-width:360px; margin-top:6px; }
  .tag { display:inline-block; max-width:260px; font:500 12px ${kira.mono}; color:#fff; background:rgba(187,17,135,.45); border-radius:var(--r-sm); padding:4px 10px; overflow-wrap:anywhere; }

  .pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:500; padding:5px 12px; border-radius:var(--r-pill); white-space:nowrap; }
  .pill i { width:6px; height:6px; border-radius:50%; background:currentColor; }
  .pill-ok { background:rgba(253,110,189,.14); color:var(--pink-soft); border:1px solid rgba(253,110,189,.3); }
  .pill-wait { background:rgba(255,255,255,.06); color:var(--soft); border:1px solid var(--border-subtle); }
  .pill-bad { background:var(--pink); color:#fff; }

  .escalation { padding:24px 28px; margin-bottom:24px; }
  .esc-head { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:6px; }
  .summary { white-space:pre-wrap; margin:16px 0 10px; line-height:1.65; color:var(--text); }
  .empty { display:flex; align-items:center; gap:12px; padding:28px; color:var(--muted); }
  .flash { display:inline-flex; align-items:center; gap:12px; padding:14px 20px; margin-top:32px; text-align:left; }

  footer { border-top:1px solid var(--border-subtle); background:var(--bg-raised); color:rgba(255,255,255,.45); font-size:12px; padding:24px 0; }

  @media (max-width: 900px) { .stats { grid-template-columns:repeat(2, 1fr); gap:16px; } }
  @media (max-width: 560px) {
    header.hero { padding:56px 0 40px; } h1 { font-size:36px; } .lead { font-size:16px; }
    .stat { padding:20px; } .stat .value { font-size:28px; }
    .live-text { display:none; } .nav-item { display:none; }
  }
  @media (prefers-reduced-motion: reduce) { .button { transition:none; } }
</style></head>
<body>
  <div class="container">
    <nav class="nav">
      <div class="brand">${kiraMark()}<span class="wordmark">kira</span></div>
      <span class="nav-item">Ops · Payout triage</span>
      <div class="live"><span class="dot"></span><span class="live-text">Auto-refresh 15s</span></div>
    </nav>
  </div>

  <main class="container">
    <header class="hero">
      <div class="eyebrow">Ops triage</div>
      <h1>Payouts that stopped moving</h1>
      <p class="lead">Outbound transfers stuck in a non-final state, and provider webhooks with a status we don't recognise. In both cases the client's funds stay on hold until someone acts.</p>
      ${flash ? `<div class="card flash"><span class="dot"></span>${esc(flash)}</div>` : ''}
    </header>

    <div class="stats">
      <div class="card stat${stuck.length ? ' glow alert' : ''}"><div class="label">Stuck payouts</div><div class="value">${stuck.length}</div></div>
      <div class="card stat${open.length ? ' glow alert' : ''}"><div class="label">Unhandled webhooks</div><div class="value">${open.length}</div></div>
      <div class="card stat"><div class="label">Funds on hold</div><div class="value">$${toDollars(held)}</div></div>
      <div class="card stat"><div class="label">Not yet escalated</div><div class="value">${notEscalated}</div></div>
    </div>

    ${triage ? `<section>
      <div class="section-head">
        <div><div class="eyebrow">00 / Triage monitor</div><h2>${triage.status === 'ok' ? 'All clear' : triage.status === 'attention' ? 'Needs a look' : 'Action needed'}</h2>
          <div class="hint">Every anomaly class behind the incident tickets. The full report, with a next step for each finding, is at <a class="strong" href="/ops/triage.txt">/ops/triage.txt</a>.</div></div>
      </div>
      ${escalationCard(escalation)}
      ${triageTable(triage)}
    </section>` : ''}

    <section>
      <div class="section-head">
        <div><div class="eyebrow">01 / Stuck payouts</div><h2>No status change for over ${stuckAfter} min</h2>
          <div class="hint">Non-final transfers (created, submitted, pending) with a live hold, oldest first. The age-based backstop: any cause shows up here, including ones we haven't modelled.</div></div>
      </div>
      ${stuckTable(stuck, stuckAfter)}
    </section>

    <section>
      <div class="section-head">
        <div><div class="eyebrow">02 / Unhandled webhooks</div><h2>Waiting for support</h2><div class="hint">Replay applies only events whose status is now supported; the rest stay open.</div></div>
        <form method="post" action="/ops/unhandled-events/replay?redirect"><button class="button" ${open.length ? '' : 'disabled'}>Replay open events<span class="arrow">→</span></button></form>
      </div>
      ${table(open, 'No open events. Every provider status received so far is supported.')}
    </section>

    <section>
      <div class="section-head"><div><div class="eyebrow">03 / Resolved webhooks</div><h2>Applied after replay or redelivery</h2></div></div>
      ${table(resolved, 'Nothing resolved yet.')}
    </section>
  </main>
  <footer><div class="container">kira-accounts-ops-service · internal ops tool</div></footer>
</body></html>`;
}
