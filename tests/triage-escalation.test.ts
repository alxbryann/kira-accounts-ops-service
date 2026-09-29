import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.js';
import { seedInto } from '../src/bootstrap.js';
import { loadIncidentSnapshot } from '../src/incident-snapshot.js';
import { processTriageEscalation, sendTriageEscalations, latestEscalation } from '../src/triage-escalation.js';
import { reportForModel } from '../src/triage-summary.js';
import { runTriage } from '../src/monitor.js';
import { createApp } from '../src/app.js';
import { createOutboundTransfer } from '../src/transfers.js';
import type { Mail, MailTransport } from '../src/mailer.js';
import { post } from '../src/ledger.js';
import { fresh } from './helpers.js';

function mailbox() {
  const sent: Mail[] = [];
  let failWith: string | undefined;
  const mail: MailTransport = { async send(m) { if (failWith) throw new Error(failWith); sent.push(m); } };
  return { sent, mail, fail: (m?: string) => { failWith = m; } };
}
async function snapshot() { const db = await openDb(); await seedInto(db); await loadIncidentSnapshot(db); return db; }

// A draft the test resolves or rejects by hand, to hold the summary "in progress".
function deferred() {
  let resolve!: (v: string) => void, reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  let calls = 0;
  return { draft: () => { calls++; return promise; }, resolve, reject, calls: () => calls };
}
const TO = { to: 'ops@test' };

test('triage escalation: nothing to escalate on a clean system', async () => {
  const db = await openDb();
  await seedInto(db);
  const { sent, mail } = mailbox();
  assert.deepEqual(await processTriageEscalation(db, { draft: async () => 'x' }), { escalated: false });
  assert.deepEqual(await sendTriageEscalations(db, mail, TO), []);
  assert.equal(sent.length, 0);
  assert.equal(await latestEscalation(db), null);
});

test('triage escalation: the report starts the summary at once; the mail waits for it, then carries it', async () => {
  const db = await snapshot();
  const { sent, mail } = mailbox();
  const d = deferred();
  const res = await processTriageEscalation(db, { draft: d.draft });
  assert.equal(res.escalated, true);
  assert.equal(d.calls(), 1, 'drafting starts when the report is escalated, not when the mail goes out');
  assert.equal((await latestEscalation(db))!.summary_status, 'pending');

  // Summary still in progress: the mail pass leaves it pending.
  assert.deepEqual(await sendTriageEscalations(db, mail, TO), []);
  assert.equal(sent.length, 0);

  d.resolve('English\nDraft summary <b>.\n\nEspañol\nResumen.');
  if (res.escalated) await res.drafted;
  assert.equal((await latestEscalation(db))!.summary_status, 'ready');
  assert.equal((await sendTriageEscalations(db, mail, TO)).length, 1);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ops@test');
  assert.match(sent[0].subject, /Triage: \d+ findings need action/);
  assert.match(sent[0].text, /SUMMARY[\s\S]*Draft summary[\s\S]*DUPLICATE PAYOUTS[\s\S]*Next step:/);
  assert.ok(sent[0].html!.includes('Draft summary &lt;b&gt;.'), 'summary is escaped in the HTML mail');
  assert.ok(sent[0].html!.includes('TX-201-DUP'));
  assert.ok((await latestEscalation(db))!.sent_at);

  // Same findings on the next pass: no second escalation, no second LLM call, no second mail.
  assert.equal((await processTriageEscalation(db, { draft: d.draft })).escalated, false);
  assert.deepEqual(await sendTriageEscalations(db, mail, TO), []);
  assert.deepEqual([sent.length, d.calls()], [1, 1]);

  // A new critical/high finding is a new escalation. (Raw SQL: the snapshot has no idempotency index, so the API path can't run.)
  await db.query(`insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status) values ('TX-NEW', 'ACC-MAREA', 'outbound', 'ach', 10000, 290, 'created')`);
  await post(db, { transfer_id: 'TX-NEW', account_id: 'ACC-MAREA', entry_type: 'hold', amount_cents: 10_290 });
  const again = await processTriageEscalation(db, { draft: async () => 'Second summary' });
  assert.equal(again.escalated, true);
  if (again.escalated) await again.drafted;
  await sendTriageEscalations(db, mail, TO);
  assert.equal(sent.length, 2);
  assert.ok(sent[1].text.includes('TX-NEW') && sent[1].text.includes('Second summary'));
});

test('triage escalation: a failed summary sends the report without it; a failed mail is retried without re-drafting', async () => {
  const db = await snapshot();
  const { sent, mail, fail } = mailbox();
  let drafts = 0;
  const res = await processTriageEscalation(db, { draft: async () => { drafts++; throw new Error('DeepSeek API 401'); } });
  if (res.escalated) await res.drafted;
  fail('smtp down');
  assert.deepEqual((await sendTriageEscalations(db, mail, TO)).map((r) => r.sent), [false]);
  let e = (await latestEscalation(db))!;
  assert.deepEqual([e.summary, e.summary_status, e.summary_error, e.last_error, e.send_attempts, e.send_claimed_at], [null, 'failed', 'DeepSeek API 401', 'smtp down', 1, null]);

  fail(undefined);
  assert.deepEqual((await sendTriageEscalations(db, mail, TO)).map((r) => r.sent), [true]);
  assert.equal(drafts, 1, 'the retry reuses the stored escalation');
  assert.ok(!sent[0].text.includes('SUMMARY'));
  assert.match(sent[0].text, /DUPLICATE PAYOUTS/);
  e = (await latestEscalation(db))!;
  assert.deepEqual([Boolean(e.sent_at), e.last_error, e.send_attempts], [true, null, 2]);
});

test('triage escalation: a summary that never arrives does not hold the alert back past the deadline', async () => {
  const db = await snapshot();
  const { sent, mail } = mailbox();
  const d = deferred();
  const res = await processTriageEscalation(db, { draft: d.draft });
  assert.deepEqual(await sendTriageEscalations(db, mail, { ...TO, summaryDeadlineMs: 60_000 }), [], 'within the deadline it waits');

  assert.deepEqual((await sendTriageEscalations(db, mail, { ...TO, summaryDeadlineMs: 0 })).map((r) => r.sent), [true]);
  assert.ok(!sent[0].text.includes('SUMMARY'));
  let e = (await latestEscalation(db))!;
  assert.equal(e.summary_status, 'failed');
  assert.match(e.summary_error!, /sent without it/);

  // The draft lands after the mail went out: dropped, so the dashboard still shows exactly what was mailed.
  d.resolve('Too late');
  if (res.escalated) await res.drafted;
  e = (await latestEscalation(db))!;
  assert.deepEqual([e.summary, e.summary_status], [null, 'failed']);
});

test('triage escalation: without a summary provider the mail goes out on the first pass', async () => {
  const db = await snapshot();
  const { sent, mail } = mailbox();
  await processTriageEscalation(db, { draft: null });
  assert.equal((await latestEscalation(db))!.summary_status, 'skipped');
  await sendTriageEscalations(db, mail, TO);
  assert.equal(sent.length, 1);
});

test('triage escalation: overlapping mail passes send it once', async () => {
  const db = await snapshot();
  const sent: Mail[] = [];
  const slow: MailTransport = { async send(m) { await new Promise((r) => setTimeout(r, 20)); sent.push(m); } };
  const res = await processTriageEscalation(db, { draft: async () => 'Summary' });
  if (res.escalated) await res.drafted;
  await Promise.all([sendTriageEscalations(db, slow, TO), sendTriageEscalations(db, slow, TO), sendTriageEscalations(db, slow, TO)]);
  assert.equal(sent.length, 1);
});

test('the model is only given amounts in dollars, never raw cents', async () => {
  const r = await runTriage(await snapshot());
  const json = JSON.stringify(reportForModel(r));
  assert.ok(!/_cents/.test(json));
  assert.match(json, /"total_affected_upper_bound":"\$5,521\.83"/);
});

test('/ops shows the last escalation: pending while the summary is drafted, then sent with it', async () => {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10_000, idempotency_key: 'k-dash' });
  await db.query(`delete from outbox where transfer_id = $1`, [t.id]);
  const { mail } = mailbox();
  const d = deferred();
  const res = await processTriageEscalation(db, { draft: d.draft });
  const server = createApp(db).listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const ops = async () => (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ops`)).text();
  try {
    let html = await ops();
    assert.ok(html.includes('Last escalation') && html.includes('waiting for the AI summary'));
    d.resolve('Resumen <script>x</script>');
    if (res.escalated) await res.drafted;
    await sendTriageEscalations(db, mail, TO);
    html = await ops();
    assert.ok(html.includes('Email sent'));
    assert.ok(html.includes('Resumen &lt;script&gt;x&lt;/script&gt;'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
