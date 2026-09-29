import fs from 'fs';
import { openDb } from './db.js';
import { seedInto } from './bootstrap.js';
import { processOutbox } from './outbox.js';
import { createApp } from './app.js';
import { processEscalations } from './escalations.js';
import { mailTransportFromEnv } from './mailer.js';

// Secrets (e.g. the Gmail credentials for escalation mail) come from a .env: the service's own,
// or the one in the parent workspace folder. Neither is committed.
const envFile = ['.env', '../.env'].find((f) => fs.existsSync(f));
if (envFile) process.loadEnvFile(envFile);

const mail = mailTransportFromEnv();
await mail.verify?.().then(
  () => console.log('escalation mail: transport verified'),
  (e) => console.error(`escalation mail: transport NOT working (${e.message}); escalations will be retried`),
);

const db = await openDb();
await seedInto(db);
const app = createApp(db);
setInterval(() => processOutbox(db).catch(() => {}), 2000);
// Email ops about webhooks with an unrecognised status (see escalations.ts). Slower than the worker so a
// failing SMTP server isn't hammered; failures are retried on the next pass.
setInterval(() => processEscalations(db, mail).catch(() => {}), 30_000);
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`kira-accounts-ops-service on :${port} (seeded, in-memory; worker every 2s)`));
