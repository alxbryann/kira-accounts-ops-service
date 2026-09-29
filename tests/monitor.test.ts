import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.js';
import { seedInto } from '../src/bootstrap.js';
import { loadIncidentSnapshot } from '../src/incident-snapshot.js';
import { runTriage, formatReport, type CheckId } from '../src/monitor.js';
import { createApp } from '../src/app.js';
import { createOutboundTransfer, setStatus } from '../src/transfers.js';
import { post } from '../src/ledger.js';
import { fresh } from './helpers.js';

const byId = (r: Awaited<ReturnType<typeof runTriage>>) => Object.fromEntries(r.checks.map((c) => [c.id, c])) as Record<CheckId, (typeof r.checks)[number]>;

test('monitor: the fixed service seeds clean, so every check is empty', async () => {
  const db = await openDb();
  await seedInto(db);
  const r = await runTriage(db);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.checks.filter((c) => c.findings.length).map((c) => c.id), []);
  assert.match(formatReport(r), /ALL CLEAR/);
});

test('monitor: on the pre-fix incident state, each ticket is flagged by the check for its class', async () => {
  const db = await openDb();
  await seedInto(db);
  await loadIncidentSnapshot(db);
  const r = await runTriage(db, { stuckAfter: 30 });
  const c = byId(r);
  const subjects = (id: CheckId) => c[id].findings.map((f) => f.subject).join(' | ');

  assert.equal(r.status, 'action_needed');
  assert.match(subjects('duplicate_payouts'), /idem-201: TX-\d+ \(settled\), TX-201-DUP/);          // 201
  assert.equal(c.duplicate_payouts.at_risk_cents, 50_000 + 1_450);
  assert.match(subjects('stuck_transfers'), /\(submitted, PROV-/);                                  // 202
  assert.match(subjects('ledger_integrity'), /\(failed\)/);                                         // 203: hold released twice
  assert.equal(c.ledger_integrity.at_risk_cents, 75_000 + 2_175);
  assert.match(subjects('stranded_holds'), /TX-204-SNAP \(created\)/);                              // 204
  assert.ok(!subjects('stuck_transfers').includes('TX-204-SNAP'), 'reported once, under the stronger check');
  assert.match(subjects('provider_double_submissions'), /accepted 2 times/);                        // 205
  assert.equal(c.provider_double_submissions.at_risk_cents, 120_000);
  assert.equal(c.ledger_statement_drift.findings.filter((f) => /^Fee /.test(f.detail)).length, 3);  // 206
  assert.match(subjects('ledger_statement_drift'), /→ TX-\d+ \(failed\)/);                          // 203 from the money side
  for (const ch of r.checks) for (const f of ch.findings) assert.ok(f.action.length > 0, `${ch.id}: every finding says what to do`);
});

test('monitor: a hold left on a payout that is already final is stranded, without waiting for the stuck threshold', async () => {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10_000, idempotency_key: 'k-final' });
  await setStatus(db, t.id, 'failed', 'PROV-f');   // status moved without its release
  const q = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10_000, idempotency_key: 'k-queued' });
  const r = byId(await runTriage(db, { stuckAfter: 30 }));
  assert.deepEqual(r.stranded_holds.findings.map((f) => f.subject), [`${t.id} (failed)`], 'a freshly queued payout is fine');
  assert.equal(r.stranded_holds.findings[0].amount_cents, 10_290);
  assert.ok(!r.stranded_holds.findings.some((f) => f.subject.startsWith(q.id)));
});

test('monitor: a second debit on one payout is a misstated balance', async () => {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10_000, idempotency_key: 'k-2debit' });
  await setStatus(db, t.id, 'settled', 'PROV-2');
  for (const entry_type of ['debit', 'release', 'debit']) await post(db, { transfer_id: t.id, account_id: 'A', entry_type, amount_cents: 10_290 });
  const [f] = byId(await runTriage(db)).ledger_integrity.findings;
  assert.match(f.detail, /debited 2 times/);
  assert.equal(f.amount_cents, 10_290);
});

test('GET /ops/triage (JSON), /ops/triage.txt (report) and the /ops summary', async () => {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10_000, idempotency_key: 'k-http' });
  await db.query(`delete from outbox where transfer_id = $1`, [t.id]);
  const server = createApp(db).listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const json = await (await fetch(`${base}/ops/triage`)).json();
    assert.equal(json.status, 'action_needed');
    const txt = await (await fetch(`${base}/ops/triage.txt`)).text();
    assert.match(txt, new RegExp(`STRANDED HOLDS[\\s\\S]*${t.id}[\\s\\S]*Next step:`));
    const html = await (await fetch(`${base}/ops`)).text();
    assert.ok(html.includes('Triage monitor') && html.includes('Stranded holds'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
