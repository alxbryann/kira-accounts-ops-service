import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { availableCents } from '../src/ledger.js';
import { createOutboundTransfer, getTransfer, setStatus } from '../src/transfers.js';
import { handleWebhook, replayUnhandledEvents } from '../src/webhooks.js';
import { listUnhandledEvents, processEscalations, unhandledSummariesSettled } from '../src/escalations.js';
import { unhandledEventForModel } from '../src/triage-summary.js';
import { createApp } from '../src/app.js';
import type { Mail, MailTransport } from '../src/mailer.js';
import { fresh, rows, FUNDING } from './helpers.js';

// A transfer the provider accepted, plus an in-memory mailbox standing in for SMTP.
async function setup(key: string) {
  const db = await fresh();
  const t = await createOutboundTransfer(db, { account_id: 'A', rail: 'crypto', amount_cents: 60_000, idempotency_key: key });
  await setStatus(db, t.id, 'submitted', `PROV-${key}`);
  const sent: Mail[] = [];
  let failWith: string | undefined;
  const mail: MailTransport = { async send(m) { if (failWith) throw new Error(failWith); sent.push(m); } };
  return { db, t, ref: `PROV-${key}`, sent, fail: (msg?: string) => { failWith = msg; }, mail };
}

test('the full webhook body is kept for events with an unknown status', async () => {
  const { db, ref } = await setup('idem-payload');
  await handleWebhook(db, { provider_event_id: 'EVT-p', provider_ref: ref, status: 'chargeback', reason_code: 'R10', correlation_id: 'CID-x' } as any);
  const [p] = await rows(db, `select payload from unhandled_provider_events where provider_event_id='EVT-p'`);
  assert.deepEqual(p.payload, { provider_event_id: 'EVT-p', provider_ref: ref, status: 'chargeback', reason_code: 'R10' });
});

test('unknown statuses are escalated once, in a single mail per pass', async () => {
  const { db, t, ref, sent, mail } = await setup('idem-mail');
  await handleWebhook(db, { provider_event_id: 'EVT-1', provider_ref: ref, status: 'chargeback' });
  await handleWebhook(db, { provider_event_id: 'EVT-2', provider_ref: ref, status: 'on_hold' });

  assert.deepEqual(await processEscalations(db, mail, { to: 'ops@test' }), { sent: 2 });
  assert.equal(sent.length, 1, 'one mail for the whole batch');
  assert.equal(sent[0].to, 'ops@test');
  assert.match(sent[0].text, /EVT-1[\s\S]*"chargeback"[\s\S]*EVT-2[\s\S]*"on_hold"/);
  assert.match(sent[0].text, new RegExp(`Transfer ${t.id}`));

  // A redelivery of an already-escalated event doesn't mail again.
  await handleWebhook(db, { provider_event_id: 'EVT-1', provider_ref: ref, status: 'chargeback' });
  assert.deepEqual(await processEscalations(db, mail, { to: 'ops@test' }), { sent: 0 });
  assert.equal(sent.length, 1);
});

test('a failed escalation is recorded and retried on the next pass', async () => {
  const { db, ref, sent, mail, fail } = await setup('idem-retry');
  await handleWebhook(db, { provider_event_id: 'EVT-r', provider_ref: ref, status: 'chargeback' });

  fail('smtp down');
  const first = await processEscalations(db, mail, { to: 'ops@test' });
  assert.equal(first.sent, 0);
  assert.deepEqual(await rows(db, `select escalated_at, escalation_attempts, last_escalation_error from unhandled_provider_events`),
    [{ escalated_at: null, escalation_attempts: 1, last_escalation_error: 'smtp down' }]);

  fail(undefined);
  assert.deepEqual(await processEscalations(db, mail, { to: 'ops@test' }), { sent: 1 });
  assert.equal(sent.length, 1);
  const [r] = await rows(db, `select escalated_at, escalation_attempts, last_escalation_error from unhandled_provider_events`);
  assert.ok(r.escalated_at);
  assert.equal(r.escalation_attempts, 2);
  assert.equal(r.last_escalation_error, null);
});

test('replay applies parked events whose status is now supported and leaves the rest open', async () => {
  const { db, t, ref } = await setup('idem-replay');
  await handleWebhook(db, { provider_event_id: 'EVT-still', provider_ref: ref, status: 'chargeback' });
  // Parked by an earlier release that didn't support 'reversed' yet.
  await db.query(`insert into unhandled_provider_events(provider_event_id, provider_ref, raw_status, payload) values ('EVT-old', $1, 'reversed', $2)`,
    [ref, JSON.stringify({ provider_event_id: 'EVT-old', provider_ref: ref, status: 'reversed' })]);

  const results = await replayUnhandledEvents(db);
  assert.deepEqual(results.map((r) => [r.provider_event_id, r.result]).sort(), [['EVT-old', 'processed'], ['EVT-still', 'still_unhandled']]);
  assert.equal((await getTransfer(db, t.id)).status, 'returned');
  assert.equal(await availableCents(db, 'A'), FUNDING);

  const state = await rows(db, `select provider_event_id, deliveries, resolved_at is not null as resolved from unhandled_provider_events order by provider_event_id`);
  assert.deepEqual(state, [
    { provider_event_id: 'EVT-old', deliveries: 1, resolved: true },
    { provider_event_id: 'EVT-still', deliveries: 1, resolved: false }, // a replay is not another delivery
  ]);

  // Replaying again is a no-op for the resolved event.
  assert.deepEqual((await replayUnhandledEvents(db)).map((r) => r.provider_event_id), ['EVT-still']);
});

test('GET /ops lists open events and escapes whatever the provider sent', async () => {
  const { db, t, ref } = await setup('idem-ops');
  await handleWebhook(db, { provider_event_id: 'EVT-xss', provider_ref: ref, status: '<script>alert(1)</script>' });
  const server = createApp(db).listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const html = await (await fetch(`${base}/ops`)).text();
    assert.ok(html.includes('EVT-xss'));
    assert.ok(html.includes(t.id));
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw status must be escaped');
    assert.ok(html.includes('&lt;script&gt;'));

    const json = await (await fetch(`${base}/ops/unhandled-events`)).json();
    assert.equal(json.length, 1);
    assert.equal(json[0].transfer_id, t.id);

    const r = await fetch(`${base}/ops/unhandled-events/replay?redirect`, { method: 'POST', redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/ops?replayed=0&still=1');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('"held" comes from the ledger, so a transfer that already released its hold shows nothing held', async () => {
  const { db, t, ref, sent, mail } = await setup('idem-held');
  await handleWebhook(db, { provider_event_id: 'EVT-a', provider_ref: ref, status: 'mystery' });
  const total = Number(t.amount_cents) + Number(t.fee_cents);
  assert.equal((await listUnhandledEvents(db))[0].held_cents, total);

  await handleWebhook(db, { provider_event_id: 'EVT-b', provider_ref: ref, status: 'failed' }); // releases the hold
  const [e] = await listUnhandledEvents(db, 'open');
  assert.equal(e.held_cents, 0);
  await processEscalations(db, mail, { to: 'ops@test' });
  assert.match(sent[0].text, /status failed · \$0\.00 held/);
});

test('the escalation email has an HTML version that escapes whatever the provider sent', async () => {
  const { db, t, ref, sent, mail } = await setup('idem-html');
  await handleWebhook(db, { provider_event_id: 'EVT-h', provider_ref: ref, status: '<img src=x onerror=alert(1)>' });
  await processEscalations(db, mail, { to: 'ops@test', dashboardUrl: 'http://ops.test/ops' });
  const html = sent[0].html!;
  assert.ok(!html.includes('<img src=x'), 'raw status must be escaped');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes(t.id));
  assert.ok(html.includes('href="http://ops.test/ops"'));
});

// --- AI analysis of an unknown status: drafted when the event is parked, the mail waits for it ---

function deferredDraft() {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => { resolve = r; });
  const inputs: unknown[] = [];
  return { draft: async (e: unknown) => { inputs.push(e); return promise; }, resolve, inputs };
}

test('an unknown status starts its AI analysis on arrival; the mail waits for it, then carries it', async () => {
  const { db, t, ref, sent, mail } = await setup('idem-ai');
  const d = deferredDraft();
  const res = await handleWebhook(db, { provider_event_id: 'EVT-ai', provider_ref: ref, status: 'chargeback_pending' }, { draftUnhandled: d.draft });
  assert.equal(res.status, 'unhandled_status', 'the webhook answers without waiting for the LLM');
  await new Promise((r) => setImmediate(r));
  assert.equal(d.inputs.length, 1, 'drafting started on arrival');
  assert.equal((await listUnhandledEvents(db))[0].summary_status, 'pending');

  assert.deepEqual(await processEscalations(db, mail, { to: 'ops@test' }), { sent: 0 }, 'pending: left for a later pass');
  assert.equal(sent.length, 0);

  // A redelivery while pending doesn't start a second analysis.
  await handleWebhook(db, { provider_event_id: 'EVT-ai', provider_ref: ref, status: 'chargeback_pending' }, { draftUnhandled: d.draft });
  d.resolve('English\nLikely a chargeback <b>.\n\nEspañol\nProbablemente un contracargo.');
  await unhandledSummariesSettled();
  assert.equal(d.inputs.length, 1);

  assert.deepEqual(await processEscalations(db, mail, { to: 'ops@test' }), { sent: 1 });
  assert.match(sent[0].text, /EVT-ai[\s\S]*AI analysis[\s\S]*Likely a chargeback[\s\S]*contracargo/);
  assert.ok(sent[0].html!.includes('Likely a chargeback &lt;b&gt;.'), 'analysis is escaped in the HTML mail');
  assert.match((d.inputs[0] as any).transfer_id, new RegExp(t.id));
});

test('a failed or overdue analysis never holds the escalation mail back; a late one is dropped', async () => {
  const { db, ref, sent, mail } = await setup('idem-ai-fail');
  await handleWebhook(db, { provider_event_id: 'EVT-f', provider_ref: ref, status: 'mystery' }, { draftUnhandled: async () => { throw new Error('DeepSeek API 500'); } });
  const d = deferredDraft();
  await handleWebhook(db, { provider_event_id: 'EVT-slow', provider_ref: ref, status: 'mystery2' }, { draftUnhandled: d.draft });
  // Not unhandledSummariesSettled(): EVT-slow's draft is held open on purpose. Wait for EVT-f's failure to land.
  while ((await listUnhandledEvents(db)).find((e) => e.provider_event_id === 'EVT-f')!.summary_status === 'pending') await new Promise((r) => setTimeout(r, 5));

  // EVT-f failed: goes now. EVT-slow still pending within the deadline: waits.
  assert.deepEqual(await processEscalations(db, mail, { to: 'ops@test', summaryDeadlineMs: 60_000 }), { sent: 1 });
  assert.ok(sent[0].text.includes('EVT-f') && !sent[0].text.includes('EVT-slow') && !sent[0].text.includes('AI analysis'));
  // Past the deadline: EVT-slow goes without its analysis.
  assert.deepEqual(await processEscalations(db, mail, { to: 'ops@test', summaryDeadlineMs: 0 }), { sent: 1 });
  assert.ok(sent[1].text.includes('EVT-slow') && !sent[1].text.includes('AI analysis'));

  d.resolve('Too late');
  await unhandledSummariesSettled();
  const slow = (await listUnhandledEvents(db)).find((e) => e.provider_event_id === 'EVT-slow')!;
  assert.deepEqual([slow.summary, slow.summary_status], [null, 'failed']);
});

test('concurrent first deliveries of an unknown status start one analysis', async () => {
  const { db, ref } = await setup('idem-ai-race');
  let calls = 0;
  const draft = async () => { calls++; return 'x'; };
  const evt = { provider_event_id: 'EVT-race', provider_ref: ref, status: 'mystery' };
  await Promise.all([handleWebhook(db, evt, { draftUnhandled: draft }), handleWebhook(db, evt, { draftUnhandled: draft })]);
  await unhandledSummariesSettled();
  assert.equal(calls, 1);
});

test('the analysis model gets dollars, not cents, and a capped status string', () => {
  const m = unhandledEventForModel({ status_received: 'x'.repeat(500), provider_event_id: 'E', deliveries: 1, transfer_id: 'TX-1', account_id: 'A', transfer_status: 'submitted', held_cents: 61_740 }, ['settled']);
  assert.ok(!/_cents/.test(JSON.stringify(m)));
  assert.equal(m.payout?.still_held, '$617.40');
  assert.equal(m.status_received.length, 80);
});

test('/ops shows the AI analysis under the event', async () => {
  const { db, ref } = await setup('idem-ai-ops');
  await handleWebhook(db, { provider_event_id: 'EVT-o', provider_ref: ref, status: 'mystery' }, { draftUnhandled: async () => 'Análisis <script>x</script>' });
  await unhandledSummariesSettled();
  const server = createApp(db).listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  try {
    const html = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ops`)).text();
    assert.ok(html.includes('AI analysis') && html.includes('Análisis &lt;script&gt;x&lt;/script&gt;'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
