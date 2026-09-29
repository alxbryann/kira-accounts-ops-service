# Kira Accounts Ops Service (mini)

A stripped-down slice of Kira's virtual-accounts backend — accounts, a double-entry ledger,
outbound transfers submitted to mock payment-rail providers through an **outbox + worker**,
a provider **settlement webhook**, and a **reconciliation** job. **It runs, but it has
production bugs.** Your job: find the root causes, ship production-ready fixes with regression
tests, build a small ops tool, and explain an incident to a client. The full task and deliverables are in the
**Challenge Brief** sent with your invitation.

## Stack
TypeScript + Node.js, raw SQL over an **embedded Postgres (PGlite)** — no Docker, no external
services. The dataset is seeded fresh (in-memory) on every run, so state is reproducible.

## How money moves
1. `POST /transfers` → de-dupe on the client's idempotency key, insert the transfer, reserve
   funds with a **hold**, enqueue a `transfer.submit` event in the **outbox**.
2. The **worker** (`src/outbox.ts`) drains the outbox: submits to the provider, records the
   `provider_ref`, then delivers the provider's webhooks. Transient provider errors are retried.
3. **Webhooks** (`src/webhooks.ts`) report the outcome; `applyProviderResult` moves the
   transfer's state and posts ledger entries (settle → debit + release hold; failed/returned →
   release hold). Balances are *derived* from the ledger.
4. **Reconciliation** compares settled transfers against the provider's statement.

The mock provider (`src/providers.ts`) behaves like a real sandbox: it can time out *after*
accepting, re-send or re-order webhooks, and it de-dupes on a client-supplied idempotency key.
Sandbox **scenario codes** on a transfer (`ok | reversed | out_of_order | timeout_once`) script its
behaviour, like test card numbers. `src/faults.ts` exposes a chaos hook to simulate a crash.

## Quickstart
```bash
npm install
npm run seed     # writes ./logs/incidents.ndjson + ./data/provider_statement.csv (generated, not committed)
npm run demo     # print the open incidents
npm run dev      # API on :3000 — /health, /accounts/:id/balance, POST /transfers,
                 #   GET /transfers/:id, POST /webhooks/provider, POST /worker/run,
                 #   GET /outbox, GET /provider/submissions, GET /reconciliation
                 #   GET /ops  (triage dashboard: monitor summary, stuck payouts, webhooks with an unrecognised status)
                 #   GET /ops/stuck-transfers, GET /ops/unhandled-events; STUCK_AFTER_MINUTES (default 30)
                 #   escalation mail: SMTP_URL, ALERT_EMAIL_TO, ALERT_EMAIL_FROM, OPS_DASHBOARD_URL
                 #   (without SMTP_URL mails are written to ./logs/mail/*.eml)
                 #   (PORT=3100 npm run dev if :3000 is busy)
npm run monitor  # ops triage report (add -- --snapshot for the pre-fix incident state, --json, --ai, --escalate)
                 #   AI summary: deepseek_api_key in .env · OPS_SNAPSHOT=1 npm run dev serves the snapshot
                 #   the server escalates new critical/high findings by email + on /ops every 60s
                 #   live: GET /ops/triage (JSON), GET /ops/triage.txt (report)
npm test         # baseline + regression suite
npm run typecheck
```

## The incidents (full text in `tickets/`)
| Ticket | Summary | |
|---|---|---|
| 201 | Vendor paid twice on a retried request | Required |
| 202 | Reversed payout stuck, funds held | Required |
| 203 | Provider paid, we show "failed", balance overstated | Required |
| 204 | Payout stuck in `created` after an API crash | Required |
| 205 | Provider paid twice after a timeout | Stretch |
| 206 | Reconciliation doesn't net to zero | Stretch |

## What to deliver (details in the Challenge Brief)
1. A root-cause fix per ticket with a **regression test** (must reproduce the failure first). Use git; we read commits.
2. `FINDINGS.md` — per ticket: how you reproduced it, the exact mechanism, the fix, and why it can't recur.
3. A small **Ops triage monitor** that flags these anomaly classes. *Optional:* an LLM-drafted summary.
4. A **client-facing incident note in English and Spanish** for one ticket.

## Where the deliverables are
- Fixes + regression tests: `src/`, `tests/ticket-20*.test.ts`, `tests/webhook-delivery.test.ts`
- `FINDINGS.md`: per ticket, plus the delivery hardening, the monitor and verification
- Ops triage monitor: `src/monitor.ts` (`npm run monitor`, `/ops/triage`, `/ops`)
- Bilingual client note: `INCIDENT-NOTE-203.md`
