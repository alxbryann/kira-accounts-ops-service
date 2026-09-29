import fs from 'fs';
import { openDb } from './db.js';
import { seedInto } from './bootstrap.js';
import { loadIncidentSnapshot } from './incident-snapshot.js';
import { runTriage, formatReport } from './monitor.js';
import { draftSummary } from './triage-summary.js';
import { processTriageEscalation, sendTriageEscalations, latestEscalation } from './triage-escalation.js';
import { mailTransportFromEnv } from './mailer.js';

// npm run monitor [-- --snapshot] [--json] [--ai] [--escalate] [--stuck-after=N]
//   --snapshot     run against the pre-fix incident state instead of today's clean seed
//   --json         machine-readable output (for alerting / cron)
//   --ai           append an LLM-drafted plain-language summary in English and Spanish (DeepSeek, needs deepseek_api_key)
//   --escalate     send the escalation email (report + AI summary) if there are critical/high findings
// Exit code 2 when there is a critical/high finding, so a scheduler can page on it.
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const stuckArg = args.find((a) => a.startsWith('--stuck-after='))?.split('=')[1];
const envFile = ['.env', '../.env'].find((f) => fs.existsSync(f));
if (envFile) process.loadEnvFile(envFile);

const db = await openDb();
await seedInto(db);
if (flag('--snapshot')) await loadIncidentSnapshot(db);
const stuckAfter = stuckArg === undefined ? undefined : Number(stuckArg);
const report = await runTriage(db, { stuckAfter });

if (flag('--escalate')) {
  // One-shot: wait for the summary (it has its own 60 s API timeout), then run the mail pass once.
  const res = await processTriageEscalation(db, { stuckAfter });
  if (res.escalated) await res.drafted;
  const [sent] = await sendTriageEscalations(db, mailTransportFromEnv());
  const e = await latestEscalation(db);
  console.error(sent?.sent ? `Escalation email sent (${e?.summary ? 'with' : 'without'} AI summary${e?.summary_error ? `: ${e.summary_error}` : ''}).`
    : report.status === 'action_needed' ? `Escalation NOT sent: ${sent?.error ?? 'unknown error'}` : 'Nothing to escalate.');
}
if (flag('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(formatReport(report));
  if (flag('--ai')) {
    try { console.log('--- Plain-language summary (AI draft: review before sending) ---\n' + (await draftSummary(report))); }
    catch (e: any) { console.error(`AI summary skipped: ${e.message}`); }
  }
}
await db.close();
process.exitCode = report.status === 'action_needed' ? 2 : 0;
