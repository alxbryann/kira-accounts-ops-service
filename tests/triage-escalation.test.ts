import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.js';
import { seedInto } from '../src/bootstrap.js';
import { loadIncidentSnapshot } from '../src/incident-snapshot.js';
import { processTriageEscalation, latestEscalation } from '../src/triage-escalation.js';
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

test('triage escalation: nothing to escalate on a clean system', async () => {
  const db = await openDb();
  await seedInto(db);
  const { sent, mail } = mailbox();
  assert.deepEqual(await processTriageEscalation(db, mail, { to: 'ops@test', draft: async () => 'x' }), { escalated: false });
  assert.equal(sent.length, 0);
  assert.equal(await latestEscalation(db), null);
});

test('triage escalation: one email with the AI summary and the full report, stored for the dashboard', async () => {
  const db = await snapshot();
  const { sent, mail } = mailbox();
  let drafts = 0;
  const draft = async () => { drafts++; return 'English\nDraft summary <b>.\n\nEspañol\nResumen.'; };
  assert.equal((await processTriageEscalation(db, mail, { to: 'ops@test', draft })).escalated, true);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ops@test');
  assert.match(sent[0].subject, /Triage: \d+ findings need action/);
  assert.match(sent[0].text, /SUMMARY[\s\S]*Draft summary[\s\S]*DUPLICATE PAYOUTS[\s\S]*Next step:/);
  assert.ok(sent[0].html!.includes('Draft summary &lt;b&gt;.'), 'summary is escaped in the HTML mail');
  assert.ok(sent[0].html!.includes('TX-201-DUP'));

  const e = (await latestEscalation(db))!;
  assert.ok(e.sent_at);
  assert.match(e.summary!, /Resumen/);

  // Same findings on the next pass: no second mail, no second LLM call.
  assert.equal((await processTriageEscalation(db, mail, { to: 'ops@test', draft })).escalated, false);
  assert.deepEqual([sent.length, drafts], [1, 1]);

  // A new critical/high finding is a new escalation. (Raw SQL: the snapshot has no idempotency index, so the API path can't run.)
  await db.query(`insert into transfers(id, account_id, direction, rail, amount_cents, fee_cents, status) values ('TX-NEW', 'ACC-MAREA', 'outbound', 'ach', 10000, 290, 'created')`);
  await post(db, { transfer_id: 'TX-NEW', account_id: 'ACC-MAREA', entry_type: 'hold', amount_cents: 10_290 });
  assert.equal((await processTriageEscalation(db, mail, { to: 'ops@test', draft })).escalated, true);
  assert.equal(sent.length, 2);
  assert.ok(sent[1].text.includes('TX-NEW'));
});

test('triage escalation: a failing summary still sends the report; a failing mail is retried without re-drafting', async () => {
  const db = await snapshot();
  const { sent, mail, fail } = mailbox();
  let drafts = 0;
  const draft = async () => { drafts++; throw new Error('DeepSeek API 401'); };
  fail('smtp down');
  const first = await processTriageEscalation(db, mail, { to: 'ops@test', draft });
  assert.equal(first.escalated, false);
  let e = (await latestEscalation(db))!;
  assert.deepEqual([e.summary, e.summary_error, e.last_error, e.send_attempts], [null, 'DeepSeek API 401', 'smtp down', 1]);

  fail(undefined);
  assert.equal((await processTriageEscalation(db, mail, { to: 'ops@test', draft })).escalated, true);
  assert.equal(drafts, 1, 'the retry reuses the stored escalation');
  assert.ok(!sent[0].text.includes('SUMMARY'));
  assert.match(sent[0].text, /DUPLICATE PAYOUTS/);
  e = (await latestEscalation(db))!;
  assert.deepEqual([Boolean(e.sent_at), e.last_error, e.send_attempts], [true, null, 2]);
});

test('the model is only given amounts in dollars, never raw cents', async () => {
  const r = await runTriage(await snapshot());
  const json = JSON.stringify(reportForModel(r));
  assert.ok(!/_cents/.test(json));
  assert.match(json, /"total_affected_upper_bound":"\$5,521\.83"/);
});

test('/ops shows the last escalation and its summary', async () => {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'ach', amount_cents: 10_000, idempotency_key: 'k-dash' });
  await db.query(`delete from outbox where transfer_id = $1`, [t.id]);
  const { mail } = mailbox();
  await processTriageEscalation(db, mail, { to: 'ops@test', draft: async () => 'Resumen <script>x</script>' });
  const server = createApp(db).listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  try {
    const html = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ops`)).text();
    assert.ok(html.includes('Last escalation') && html.includes('Email sent'));
    assert.ok(html.includes('Resumen &lt;script&gt;x&lt;/script&gt;'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
