import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Live concurrency check against the real HTTP API: fires the same requests at the same time and checks the money.
//   npm run live                          starts its own server (temp dir, no mail/LLM credentials) and stops it after
//   npm run live -- --base=http://localhost:3000   uses a server you already started (a seeded, untouched one)
//   npm run live -- --escalation          also waits (~35 s) for the unknown-status escalation mail to go out
// Every run uses fresh idempotency keys and event ids, so it can be repeated against the same server.
// Exit code 1 when any check fails.

const args = process.argv.slice(2);
const baseArg = args.find((a) => a.startsWith('--base='))?.split('=')[1];
const waitEscalation = args.includes('--escalation');
const run = Date.now().toString(36);
const ACC = 'ACC-MAREA';

let base = baseArg ?? '';
let server: ChildProcess | undefined;
let failed = 0;

const api = async (method: 'GET' | 'POST', p: string, body?: unknown): Promise<any> => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
};
const balance = async () => (await api('GET', `/accounts/${ACC}/balance`)).available_cents as number;
const transfer = (id: string) => api('GET', `/transfers/${id}`);
const submissionsFor = async (id: string) => ((await api('GET', '/provider/submissions')) as any[]).filter((s) => s.transfer_id === id);
const webhook = (provider_ref: string, status: string, provider_event_id: string) => api('POST', '/webhooks/provider', { provider_event_id, provider_ref, status });
const usd = (c: number) => '$' + (c / 100).toFixed(2);

function check(name: string, ok: boolean, detail: string) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
}

// A settled payout to play webhooks against: create it, run the worker, and it settles (scenario 'ok').
async function settledTransfer(label: string, amount_cents: number) {
  const t = await api('POST', '/transfers', { account_id: ACC, rail: 'ach', amount_cents, idempotency_key: `live-${run}-${label}` });
  await api('POST', '/worker/run');
  return transfer(t.id);
}

async function startServer() {
  const repo = path.resolve(import.meta.dirname, '..');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kira-live-'));
  const port = 3999;
  // No mail or LLM credentials: escalation mail is written to <cwd>/logs/mail/*.eml, nothing leaves the machine.
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
  for (const k of ['gmail', 'gmail_api_key', 'SMTP_URL', 'deepseek_api_key', 'DEEPSEEK_API_KEY', 'ALERT_EMAIL_TO', 'OPS_SNAPSHOT']) delete env[k];
  server = spawn(path.join(repo, 'node_modules', '.bin', 'tsx'), [path.join(repo, 'src', 'server.ts')], { cwd, env, stdio: 'ignore' });
  base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + '/health')).ok) { console.log(`Server started on ${base} (cwd ${cwd})\n`); return cwd; } } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

async function main() {
  const cwd = baseArg ? undefined : await startServer();
  if (baseArg) console.log(`Using ${base}\n`);

  // TICKET-201: the client retries the same payout 20 times at once. One transfer, one hold, one provider payout.
  console.log('[201] 20 concurrent POST /transfers with the same idempotency key');
  {
    const before = await balance();
    const key = `live-${run}-201`;
    const res = await Promise.all(Array.from({ length: 20 }, () => api('POST', '/transfers', { account_id: ACC, rail: 'ach', amount_cents: 30_000, idempotency_key: key })));
    const ids = new Set(res.map((r) => r.id));
    const held = before - (await balance());
    const total = 30_000 + Number(res[0].fee_cents);
    check('one transfer for the key', ids.size === 1, `20 responses, transfer ids: ${[...ids].join(', ')}`);
    check('funds held once', held === total, `balance went down ${usd(held)}; amount + fee is ${usd(total)}`);
    await api('POST', '/worker/run');
    const subs = await submissionsFor([...ids][0]);
    check('paid out once', subs.length === 1, `provider submissions for ${[...ids][0]}: ${subs.length}`);
  }

  // TICKET-205: several workers drain the outbox at the same time. Each transfer reaches the provider once.
  console.log('\n[205] 10 concurrent POST /worker/run over 5 fresh transfers');
  const fresh: any[] = [];
  {
    for (let i = 0; i < 5; i++) fresh.push(await api('POST', '/transfers', { account_id: ACC, rail: 'ach', amount_cents: 10_000 + i, idempotency_key: `live-${run}-205-${i}` }));
    await Promise.all(Array.from({ length: 10 }, () => api('POST', '/worker/run')));
    const counts = await Promise.all(fresh.map(async (t) => (await submissionsFor(t.id)).length));
    const statuses = await Promise.all(fresh.map(async (t) => (await transfer(t.id)).status));
    check('one provider submission per transfer', counts.every((n) => n === 1), fresh.map((t, i) => `${t.id}=${counts[i]}`).join(' '));
    check('all settled', statuses.every((s) => s === 'settled'), statuses.join(', '));
  }

  // TICKET-203: after the payout settled, the provider sends stale 'failed' and 'pending' events (distinct ids), all at once.
  // Settled wins: no second release, the balance doesn't move.
  console.log('\n[203] 10 stale "failed" + 5 "pending" at once on a settled payout');
  {
    const t = await transfer(fresh[0].id);
    const before = await balance();
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => webhook(t.provider_ref, 'failed', `EVT-${run}-203-f${i}`)),
      ...Array.from({ length: 5 }, (_, i) => webhook(t.provider_ref, 'pending', `EVT-${run}-203-p${i}`)),
    ]);
    const after = await transfer(t.id);
    check('status stays settled', after.status === 'settled', `${t.id}: ${after.status}`);
    check('balance unchanged', (await balance()) === before, `before ${usd(before)}, after ${usd(await balance())}`);
  }

  // TICKET-202: a clawback after settlement, redelivered 10 times with the SAME event id, racing 5 'reversed' with other ids.
  // Exactly one refund credit.
  console.log('\n[202] 10 redeliveries of one "returned" event + 5 "reversed" at once on a settled payout');
  {
    const t = await transfer(fresh[1].id);
    const total = Number(t.amount_cents) + Number(t.fee_cents);
    const before = await balance();
    await Promise.all([
      ...Array.from({ length: 10 }, () => webhook(t.provider_ref, 'returned', `EVT-${run}-202-ret`)),
      ...Array.from({ length: 5 }, (_, i) => webhook(t.provider_ref, 'reversed', `EVT-${run}-202-rev${i}`)),
    ]);
    const after = await transfer(t.id);
    const refunded = (await balance()) - before;
    check('status returned', after.status === 'returned', `${t.id}: ${after.status}`);
    check('refunded once', refunded === total, `balance went up ${usd(refunded)}; the payout was ${usd(total)}`);
  }

  // Unknown status: parked, not applied, one row however many concurrent redeliveries; escalated by email once.
  console.log('\n[unknown status] 5 concurrent deliveries of "chargeback_pending" with the same event id');
  {
    const t = await transfer(fresh[2].id);
    const before = await balance();
    const evt = `EVT-${run}-unknown`;
    const res = await Promise.all(Array.from({ length: 5 }, () => webhook(t.provider_ref, 'chargeback_pending', evt)));
    const parked = ((await api('GET', '/ops/unhandled-events')) as any[]).filter((e) => e.provider_event_id === evt);
    check('parked, not applied', res.every((r) => r.status === 'unhandled_status'), res.map((r) => r.status).join(', '));
    check('one parked row counting every delivery', parked.length === 1 && parked[0].deliveries === 5, `rows: ${parked.length}, deliveries: ${parked[0]?.deliveries}`);
    check('payout and balance untouched', (await transfer(t.id)).status === 'settled' && (await balance()) === before, `${t.id}: ${(await transfer(t.id)).status}`);
    if (waitEscalation) {
      console.log('        waiting for the escalation pass (runs every 30 s)...');
      let escalated: string | null = null;
      for (let i = 0; i < 45 && !escalated; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        escalated = ((await api('GET', '/ops/unhandled-events')) as any[]).find((e) => e.provider_event_id === evt)?.escalated_at ?? null;
      }
      const where = cwd ? ` · mail in ${path.join(cwd, 'logs', 'mail')}` : '';
      check('escalated by email', Boolean(escalated), `escalated_at: ${escalated}${where}`);
    }
  }

  // After all of the above, the triage monitor must find nothing wrong with the money, except one expected finding:
  // the [202] clawback was a webhook we forged, the mock provider never returned that payout, so its statement still
  // lists it as settled. The monitor flagging exactly that drift (and nothing else) is the right answer.
  console.log('\n[triage] /ops/triage after everything');
  {
    const r = await api('GET', '/ops/triage');
    const found = r.checks.flatMap((c: any) => c.findings.map((f: any) => ({ check: c.id, subject: f.subject as string })));
    const expected = found.filter((f: any) => f.check === 'ledger_statement_drift' && f.subject.includes(`${fresh[1].id} (returned)`));
    const other = found.filter((f: any) => !expected.includes(f));
    check('only the expected drift from the forged clawback', expected.length === 1 && other.length === 0,
      `expected: ${expected.map((f: any) => f.subject).join('; ') || 'missing'} · other findings: ${other.map((f: any) => `${f.check}: ${f.subject}`).join('; ') || 'none'}`);
  }

  console.log(`\n${failed ? `${failed} check(s) FAILED` : 'All checks passed.'}`);
}

try { await main(); }
catch (e: any) { failed++; console.error(`Error: ${e.message}`); }
finally { server?.kill(); }
process.exitCode = failed ? 1 : 0;
