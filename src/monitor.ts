import type { PGlite } from '@electric-sql/pglite';
import * as provider from './providers.js';
import { reconcile } from './reconciliation.js';
import { listStuckTransfers, stuckAfterMinutes } from './stuck.js';
import { toDollars } from './money.js';

// Ops triage monitor: scans the ledger, the outbox, the provider's submissions and its statement, and flags
// every anomaly class behind TICKET-201..206. Read-only: it reports and suggests a next step, it never moves money.
// Each check is written against the symptom (what the data looks like), not the bug, so it also catches a
// regression or a new cause of the same shape.

export type Severity = 'critical' | 'high' | 'medium';
export type CheckId = 'duplicate_payouts' | 'provider_double_submissions' | 'ledger_integrity' | 'stranded_holds' | 'ledger_statement_drift' | 'stuck_transfers';
export type Finding = { subject: string; account_id: string | null; amount_cents: number; detail: string; action: string };
export type Check = { id: CheckId; title: string; severity: Severity; meaning: string; findings: Finding[]; at_risk_cents: number };
export type TriageReport = { generated_at: string; stuck_after_minutes: number; status: 'ok' | 'attention' | 'action_needed'; checks: Check[]; totals: { findings: number; at_risk_cents: number } };

type Q = (sql: string, p?: unknown[]) => Promise<any[]>;
const usd = (c: number) => '$' + Number(toDollars(c)).toLocaleString('en-US', { minimumFractionDigits: 2 });
const TOTAL = `(t.amount_cents + t.fee_cents)`;

// Two transfers for one client idempotency key = the client sent one payout and we paid it twice (TICKET-201).
// The unique index now prevents it, so on a migrated database this is the audit that must be clean *before*
// the index can be created, and a tripwire afterwards.
async function duplicatePayouts(q: Q): Promise<Finding[]> {
  const rows = await q(`
    select t.idempotency_key, min(t.account_id) account_id, array_agg(t.id order by t.created_at, t.id) ids,
      array_agg(t.status order by t.created_at, t.id) statuses, min(${TOTAL}) each_cents, count(*)::int n
    from transfers t where t.direction = 'outbound' and t.idempotency_key is not null
    group by t.idempotency_key having count(*) > 1 order by t.idempotency_key`);
  return rows.map((r) => ({
    subject: `Key ${r.idempotency_key}: ${r.ids.map((id: string, i: number) => `${id} (${r.statuses[i]})`).join(', ')}`,
    account_id: r.account_id, amount_cents: (r.n - 1) * Number(r.each_cents),
    detail: `The client sent this payout once, but it exists ${r.n} times. ${usd(Number(r.each_cents))} each.`,
    action: `Keep ${r.ids[0]}. Stop or recover ${r.ids.slice(1).join(', ')}: if not yet paid, cancel it and release the hold; if paid, ask the provider to reverse it or recover it from the vendor.`,
  }));
}

// The provider accepted the same transfer more than once, e.g. a retry after a timeout without an idempotency
// key (TICKET-205). Also: a provider payout that matches no transfer of ours at all.
async function providerDoubleSubmissions(q: Q): Promise<Finding[]> {
  const byTransfer = new Map<string, provider.Submission[]>();
  for (const s of provider.submissions) byTransfer.set(s.transfer_id, [...(byTransfer.get(s.transfer_id) ?? []), s]);
  const known = new Map((await q(`select id, account_id, provider_ref from transfers where direction = 'outbound'`)).map((t) => [t.id, t]));
  const out: Finding[] = [];
  for (const [transferId, subs] of byTransfer) {
    const t = known.get(transferId);
    if (!t) {
      for (const s of subs) out.push({
        subject: `${s.provider_ref} (provider says transfer ${transferId})`, account_id: null, amount_cents: s.amount_cents,
        detail: `The provider accepted a ${usd(s.amount_cents)} payout that matches no transfer in our system.`,
        action: 'Ask the provider for the payout details, then reverse it or book it against the right transfer.',
      });
      continue;
    }
    if (subs.length < 2) continue;
    const extra = subs.filter((s) => s.provider_ref !== t.provider_ref);
    out.push({
      subject: `${transferId}: accepted ${subs.length} times (${subs.map((s) => s.provider_ref).join(', ')})`, account_id: t.account_id,
      amount_cents: extra.reduce((a, s) => a + s.amount_cents, 0),
      detail: `We track ${t.provider_ref ?? 'no provider reference'}; the provider also paid ${extra.map((s) => `${s.provider_ref} (${usd(s.amount_cents)}, ${s.outcome})`).join(', ')}. The client was debited once, so the extra payout is Kira's loss.`,
      action: `Ask the provider to reverse ${extra.map((s) => s.provider_ref).join(', ')}, or recover the funds from the vendor.`,
    });
  }
  return out;
}

// The ledger must agree with the transfer's own status. Each rule is a way the client's balance ends up wrong:
// a hold released more times than it was placed (TICKET-203), more than one debit, or a net effect that doesn't
// match the status (open/settled: amount+fee gone; failed/returned: nothing gone).
async function ledgerIntegrity(q: Q): Promise<Finding[]> {
  const rows = await q(`
    select t.id, t.account_id, t.status, ${TOTAL} as total,
      coalesce(sum(l.amount_cents) filter (where l.entry_type = 'hold'), 0) holds,
      coalesce(sum(l.amount_cents) filter (where l.entry_type = 'release'), 0) releases,
      count(*) filter (where l.entry_type = 'debit')::int debits,
      coalesce(sum(case l.entry_type when 'credit' then l.amount_cents when 'release' then l.amount_cents else -l.amount_cents end), 0) net
    from transfers t left join ledger_entries l on l.transfer_id = t.id
    where t.direction = 'outbound' group by t.id order by t.id`);
  const out: Finding[] = [];
  for (const r of rows) {
    const [total, holds, releases, net] = [r.total, r.holds, r.releases, r.net].map(Number);
    const expected = ['failed', 'returned'].includes(r.status) ? 0 : -total;
    const problems: string[] = [];
    if (releases > holds) problems.push(`the hold was released ${usd(releases)} against ${usd(holds)} placed`);
    if (r.debits > 1) problems.push(`it was debited ${r.debits} times`);
    if (net !== expected) problems.push(`the ledger shows ${usd(-net)} gone, but a '${r.status}' payout should show ${usd(-expected)}`);
    if (!problems.length) continue;
    const off = Math.max(Math.abs(net - expected), releases - holds, 0);
    out.push({
      subject: `${r.id} (${r.status})`, account_id: r.account_id, amount_cents: off,
      detail: `Balance misstated: ${problems.join('; ')}.`,
      action: `Confirm the real outcome with the provider, then post one correcting entry for ${usd(off)} referencing ${r.id}, and fix the status if it is wrong.`,
    });
  }
  return out;
}

// Client money reserved with nothing that will ever move it: a live hold on a transfer that has no provider ref
// and no pending outbox event (TICKET-204), or a hold left behind on a transfer that is already final.
// Not age-gated: on a healthy system this state can't exist even for a second.
async function strandedHolds(q: Q): Promise<Finding[]> {
  const rows = await q(`
    select t.id, t.account_id, t.status, t.provider_ref, h.held,
      (select o.status from outbox o where o.transfer_id = t.id order by o.id desc limit 1) outbox_status
    from transfers t
    join lateral (select coalesce(sum(case l.entry_type when 'hold' then l.amount_cents when 'release' then -l.amount_cents else 0 end), 0) held
                  from ledger_entries l where l.transfer_id = t.id) h on true
    where t.direction = 'outbound' and h.held > 0 order by t.created_at, t.id`);
  const out: Finding[] = [];
  for (const r of rows) {
    const held = Number(r.held);
    const final = ['settled', 'failed', 'returned'].includes(r.status);
    const noDriver = !r.provider_ref && r.outbox_status !== 'pending';
    if (!final && !noDriver) continue;
    out.push({
      subject: `${r.id} (${r.status})`, account_id: r.account_id, amount_cents: held,
      detail: final
        ? `The payout is ${r.status}, but ${usd(held)} is still on hold.`
        : `${usd(held)} is on hold, but ${r.outbox_status ? `its submission ${r.outbox_status}` : 'it was never queued'} and the provider has no reference for it. Nothing will ever submit or release it.`,
      action: final
        ? `Release the remaining ${usd(held)} hold (memo referencing ${r.id}).`
        : `Ask the client whether they still want this payout. Yes: re-queue it for submission. No: release the ${usd(held)} hold and mark it failed so they can resend with a new key.`,
    });
  }
  return out;
}

// Our settled payouts vs the provider's settlement statement (TICKET-206, and the money side of 203/205).
async function ledgerStatementDrift(db: PGlite, q: Q): Promise<{ findings: Finding[]; diffCents: number }> {
  const r = await reconcile(db);
  const byRef = new Map((await q(`select id, account_id, status, provider_ref from transfers where provider_ref is not null`)).map((t) => [t.provider_ref, t]));
  const byId = new Map((await q(`select id, account_id from transfers`)).map((t) => [t.id, t]));
  const out: Finding[] = [];
  for (const s of r.statementOnly) {
    const t = byRef.get(s.provider_ref);
    // Not ours by reference: the provider's own record may still say which transfer it paid it for.
    const claimed = t ? undefined : byId.get(provider.submissions.find((x) => x.provider_ref === s.provider_ref)?.transfer_id ?? '');
    out.push({
      subject: s.provider_ref + (t ? ` → ${t.id} (${t.status})` : claimed ? ` → extra payout for ${claimed.id}` : ' → no transfer'),
      account_id: t?.account_id ?? claimed?.account_id ?? null, amount_cents: s.amount_cents + s.fee_cents,
      detail: t
        ? `The provider settled ${usd(s.amount_cents + s.fee_cents)}, but we record this payout as '${t.status}', so the client was not debited for it.`
        : claimed
          ? `The provider settled ${usd(s.amount_cents + s.fee_cents)} under a reference ${claimed.id} doesn't track: a second payout of the same transfer.`
          : `The provider settled ${usd(s.amount_cents + s.fee_cents)} that we have no transfer for.`,
      action: t ? `Confirm with the provider that ${s.provider_ref} settled, then correct ${t.id} to settled and post the missing debit.`
        : 'Same money as under "Provider double submissions": recover it there, don\'t book it twice.',
    });
  }
  for (const id of r.ledgerOnly) out.push({
    subject: id, account_id: byId.get(id)?.account_id ?? null, amount_cents: 0,
    detail: 'We debited the client for this payout, but it is not on the provider\'s settlement statement.',
    action: 'Ask the provider whether it was paid. If not, refund the client.',
  });
  for (const m of r.feeMismatches) out.push({
    subject: m.transfer, account_id: byId.get(m.transfer)?.account_id ?? null, amount_cents: Math.abs(m.statement_fee - m.ledger_fee),
    detail: `Fee ${usd(m.ledger_fee)} in our ledger vs ${usd(m.statement_fee)} on the provider statement.`,
    action: 'Finance: post a fee correction or write it off, and record the decision.',
  });
  return { findings: out, diffCents: r.diffCents };
}

const META: Record<CheckId, { title: string; severity: Severity; meaning: string }> = {
  duplicate_payouts: { title: 'Duplicate payouts', severity: 'critical', meaning: 'One client request became more than one payout: the vendor may have been paid twice and the client charged twice.' },
  provider_double_submissions: { title: 'Provider double submissions', severity: 'critical', meaning: 'The provider paid out the same transfer more than once, or paid something we have no record of.' },
  ledger_integrity: { title: 'Balance misstated', severity: 'critical', meaning: 'The ledger disagrees with the payout\'s own status, so the client\'s available balance is wrong (too high is an overdraft risk).' },
  stranded_holds: { title: 'Stranded holds', severity: 'high', meaning: 'Client funds are reserved, but nothing in the system will ever submit or release them. They stay locked until someone acts.' },
  ledger_statement_drift: { title: 'Ledger vs provider statement', severity: 'high', meaning: 'Our settled payouts and the provider\'s settlement statement disagree.' },
  stuck_transfers: { title: 'Stuck payouts', severity: 'medium', meaning: 'Payouts that have not changed status for a while and still hold client funds. Some will resolve on their own (a retry, a late webhook); check the likely cause.' },
};

export async function runTriage(db: PGlite, opts: { stuckAfter?: number; now?: Date } = {}): Promise<TriageReport> {
  const q: Q = async (sql, p = []) => (await db.query<any>(sql, p)).rows;
  const stuckAfter = opts.stuckAfter ?? stuckAfterMinutes();
  const stranded = await strandedHolds(q);
  const strandedIds = new Set(stranded.map((f) => f.subject.split(' ')[0]));
  const drift = await ledgerStatementDrift(db, q);
  const stuck = (await listStuckTransfers(db, stuckAfter))
    .filter((t) => !strandedIds.has(t.id)) // already reported, with a stronger diagnosis
    .map((t): Finding => ({
      subject: `${t.id} (${t.status}${t.provider_ref ? `, ${t.provider_ref}` : ''})`, account_id: t.account_id, amount_cents: t.held_cents,
      detail: `No change for ${Math.floor(t.age_minutes)} min, ${usd(t.held_cents)} on hold. ${t.detail}`,
      action: t.reason === 'unrecognised_status' ? 'See "Unhandled webhooks" on /ops: the provider sent a status we don\'t support yet.'
        : t.reason === 'queued' ? 'Usually resolves on the next worker pass. If it keeps failing, check the provider\'s status page.'
        : 'Ask the provider for the payout\'s final status, then apply it (replay the webhook) so the hold is released or settled.',
    }));
  const found: Record<CheckId, Finding[]> = {
    duplicate_payouts: await duplicatePayouts(q),
    provider_double_submissions: await providerDoubleSubmissions(q),
    ledger_integrity: await ledgerIntegrity(q),
    stranded_holds: stranded,
    ledger_statement_drift: drift.findings,
    stuck_transfers: stuck,
  };
  const checks = (Object.keys(META) as CheckId[]).map((id) => ({ id, ...META[id], findings: found[id], at_risk_cents: found[id].reduce((a, f) => a + f.amount_cents, 0) }));
  const findings = checks.reduce((a, c) => a + c.findings.length, 0);
  const status = checks.some((c) => c.findings.length && c.severity !== 'medium') ? 'action_needed' : findings ? 'attention' : 'ok';
  return {
    generated_at: (opts.now ?? new Date()).toISOString(), stuck_after_minutes: stuckAfter, status, checks,
    // The same money can show up under two checks (e.g. a 203 payout is both misstated and missing from our side
    // of the statement), so this is an upper bound, labelled as such in the report.
    totals: { findings, at_risk_cents: checks.reduce((a, c) => a + c.at_risk_cents, 0) },
  };
}

// Plain-text report for ops / support: what is wrong, how much money, what to do, in that order.
export function formatReport(r: TriageReport): string {
  const headline = { ok: 'ALL CLEAR: no anomalies found.', attention: 'ATTENTION: some payouts need a look; nothing critical.', action_needed: 'ACTION NEEDED: client funds are affected.' }[r.status];
  const lines = [
    `KIRA OPS TRIAGE · ${r.generated_at.replace('T', ' ').slice(0, 16)} UTC`,
    headline,
    `${r.totals.findings} finding(s) · up to ${usd(r.totals.at_risk_cents)} affected · stuck threshold ${r.stuck_after_minutes} min`,
    '',
  ];
  for (const c of r.checks) {
    lines.push(`${c.findings.length ? '■' : '□'} ${c.title.toUpperCase()} [${c.severity}] · ${c.findings.length ? `${c.findings.length} found · ${usd(c.at_risk_cents)}` : 'none'}`);
    if (!c.findings.length) continue;
    lines.push(`  What it means: ${c.meaning}`);
    for (const f of c.findings) {
      lines.push(`  • ${f.subject}${f.account_id ? ` · account ${f.account_id}` : ''}`);
      lines.push(`      ${f.detail}`);
      lines.push(`      Next step: ${f.action}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}
