# Findings

One section per ticket: how it was reproduced, the exact mechanism, the fix, why it can't recur, and the ambiguity calls made along the way.

---

## TICKET-201 — Vendor paid twice (concurrent retries, same Idempotency-Key)

### Reproduction
`tests/ticket-201.test.ts` fires two `createOutboundTransfer` calls with the same `idempotency_key` via `Promise.all`, the same way `src/bootstrap.ts` seeds the incident. Before the fix it failed: the two calls returned different transfers (`TX-0002` and `TX-0003`), with two holds, two outbox events and two provider submissions.

The existing baseline test ("a retried request with the same idempotency key…") passed because it retries **sequentially**. By the time the second call runs, the first has already committed its row, so the lookup finds it. The bug only shows up when the attempts overlap.

### Mechanism
`createOutboundTransfer` did **check-then-act** with nothing in the database enforcing uniqueness:

1. `SELECT … WHERE idempotency_key = $1` → no row
2. `INSERT INTO transfers …`, then the hold, then the outbox event

Each `await` yields, so both attempts finish step 1 before either reaches step 2. Both see "no row", both insert, and both reserve funds and enqueue a `transfer.submit`. The worker then pays the vendor twice. `transfers.idempotency_key` was a plain `text` column with no constraint, so the database accepted the duplicate.

### Fix
- `src/db.ts`: a partial unique index `transfers_idempotency_key_uq ON transfers(idempotency_key) WHERE idempotency_key IS NOT NULL`.
- `src/transfers.ts`: the insert now claims the key atomically with `ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`. If no row comes back, this attempt lost the race: it reads the winning transfer and returns it without creating a hold or outbox event, and logs `transfer.idempotent_hit` with `concurrent: true`.

The pre-insert `SELECT` stays in place as a cheap fast path for ordinary sequential retries. It no longer carries correctness.

### Why it can't recur
Uniqueness is now enforced by the database, not by application timing. Only one row per key can exist, whatever the interleaving. In a multi-connection Postgres, a concurrent insert of the same key blocks on the index entry until the first transaction commits (then conflicts) or rolls back (then proceeds). So this holds across multiple service replicas too, which an in-process mutex would not. It also holds for any future code path that inserts transfers, even one that forgets to check first.

### Ambiguity calls
- **Partial index vs full unique index.** Postgres treats NULLs as distinct in unique indexes, so either would allow many key-less transfers (e.g. inbound credits). I chose the partial index to make the intent explicit and keep the index small. The trade-off is that `ON CONFLICT` has to repeat the predicate so Postgres can infer the index.
- **Mutex / advisory lock rejected.** An in-memory `Map<key, Promise>` passes the test but only protects one process. `pg_advisory_xact_lock` works across processes, but only on code paths that remember to take it. The constraint protects every writer.
- **Same key, different payload.** A retry that reuses a key with a different `amount_cents`/`account_id`/`rail` currently gets the original transfer back silently. The industry norm (e.g. Stripe) is to reject it with `409/422`, because it is almost certainly a client bug. Left as-is to keep this commit scoped to the race; flagged as a follow-up.
- **Atomicity is out of scope here.** Transfer + hold + outbox are still separate statements. Making them one transaction is the TICKET-204 fix and gets its own commit.

### Remediation (not solved by code)
The fix prevents new duplicates. It does not undo the incident: Marea Pay's `idem-201` already has two outbound transfers, and the vendor was paid twice. Ops needs to recover or reverse the second payout and release its hold/debit. In production, existing duplicates must be resolved **before** creating the index, or `CREATE UNIQUE INDEX` will fail. On a large table, build it with `CREATE UNIQUE INDEX CONCURRENTLY` to avoid blocking writes.

---

## TICKET-202 — Reversed payout stuck, funds held

### Reproduction
`tests/ticket-202.test.ts` creates a $600.00 crypto payout with sandbox scenario `reversed` and runs the worker. Before the fix it failed with `expected a terminal status, got 'submitted'`, and the $617.40 hold (amount + fee) was never released.

`grep CID-202 logs/incidents.ndjson` shows only `transfer.created` and `outbox.enqueued`. That makes it look like the provider never answered. It did. The worker logs under its own correlation id, so the webhook shows up under `WORKER-pass-1` (found with `grep TX-0004`):

```
webhook.received         provider_ref=PROV-0003 transfer_id=TX-0004 status="reversed" current_status="submitted"
transfer.provider_result transfer_id=TX-0004 from="submitted" provider_status="reversed"
```

### Mechanism
The provider sends `reversed`. `applyProviderResult` handled `pending | settled | failed | returned` in an `if/else if` chain with **no final `else`**. So `reversed` matched nothing: no ledger entry, no status change. Execution then fell through to the unconditional `log('transfer.provider_result', …)`, which made a no-op look like a processed outcome. The event id had already been written to `processed_events`, so a redelivery of the same event would be skipped as a duplicate. The transfer stays in `submitted` for good, and its `hold` keeps the client's funds locked.

The provider side confirms the money never left: the submission is recorded with `outcome: 'reversed'`, there was never a `settled` webhook, and `statement()` excludes it.

### Fix
`src/transfers.ts` (`applyProviderResult`):
- New `reversed` branch: post a `release` for amount + fee (memo `release hold (reversed)`), then set the status to `returned`. **No `debit`**, because the payout was never paid out. The release alone cancels the hold.

`reversed` is one instance of a broader class: the provider sends a status we don't model. `WebhookEvent.status` is a free `string` and nothing validated it, so the next unknown value (`cancelled`, `chargeback`, `Settled` in another case…) would get stuck the same way. The rest of the fix closes that class:
- `src/providers.ts`: `PROVIDER_STATUSES` / `ProviderStatus` is the closed list of statuses we can apply. `normalizeProviderStatus` is the single place that maps the raw webhook value onto it (trim + lowercase for now; provider aliases go here once confirmed against their docs). Anything else returns `null`.
- `src/transfers.ts`: `applyProviderResult` takes a `ProviderStatus` instead of a `string` and is a `switch` with a `never` check in `default`. Adding a status to the list without handling it is a compile error.
- `src/webhooks.ts`: `handleWebhook` normalizes the status **before** writing `processed_events`. An unknown status is not consumed: it is parked in the new `unhandled_provider_events` table (`src/db.ts`: raw status, delivery count, first/last seen), logged as `webhook.unhandled_status` at `error` level, and answered with `{ status: 'unhandled_status' }`. The transfer and ledger are left untouched. A redelivery of the same event id is evaluated again, so once the status is supported it gets applied instead of being skipped as a duplicate.

### Why it can't recur
- `reversed` is now a handled terminal outcome. The test asserts the terminal status, the fully restored balance, exactly one `release` equal to the `hold`, and no `debit`.
- An unmodeled status can no longer be silently swallowed: it can't reach `applyProviderResult`, it doesn't burn the event id, and it leaves a parked row plus an error-level log. `tests/provider-status.test.ts` covers the normalization, a status in a different case being applied, and an unknown status being parked (not consumed, redeliveries counted) and then applied exactly once when redelivered with a supported status. The stuck-payouts check on `/ops` (below) is the age-based backstop: a transfer that stops moving for any reason, including a status we still haven't modelled, shows up there.

### Ambiguity calls
- **Final status `returned` vs a new `reversed` status.** I chose `returned`. It is an existing terminal status, so the schema, the dashboard and reconciliation don't change, and the ledger effect is identical. The ledger memo still records that the provider said `reversed`. Trade-off: the client and the provider call it "reversed", and in payments "returned" often means the receiving bank bounced it. A separate status would read closer to the provider's own wording.
- **Release, not debit + credit.** Before settlement our ledger only has a `hold`, so a `release` undoes it exactly. Posting a debit and a credit would record a payment and a refund that never happened. A reversal that arrives **after** `settled` (a real-world clawback) is different: the debit already happened, so it needs a `credit`. Which transitions are legal from which state is the state machine TICKET-203 introduces. **Until 203 lands, `reversed` after `settled` would release the money a second time.** That is the same bug class as 203, not a regression from this change. *(Resolved in TICKET-203: it now posts a `credit`.)*
- **Unknown status: park, don't throw.** Throwing looks stricter but causes harm here. The worker delivers webhooks inside the outbox `try`: a throw lands in its `catch`, which puts the row back to `pending`, and the next pass calls `provider.submit` again with no idempotency key. That pays the vendor twice. Parking the event keeps it recoverable without touching the outbox.
- **`200` for an unknown status, not `422`.** The event is safely parked, so asking the provider to retry would only add a retry storm on something we can't process yet, and provider retries usually give up within hours or days, likely before support for the status ships. Recovery doesn't depend on the provider: see *Escalation and replay* below. If we'd rather lean on the provider's retries anyway, switching the endpoint to `422` is a one-line change.
- **No provider aliases yet.** `normalizeProviderStatus` only normalizes case and whitespace. Mapping e.g. `completed → settled` without the provider's docs would be guessing what money movement a word means, so aliases are added only once confirmed.
- **We don't know *why* it was reversed.** The provider sent only the status, with no reason code. Client comms should say the payout was reversed by the provider and the funds are released, without guessing a cause.


### Escalation and replay (unknown statuses)
Parking an unknown status only helps if someone finds out and the event can be applied later. So:
- **Full payload kept.** `unhandled_provider_events.payload` stores the webhook body as received (minus our own `correlation_id`). A new status likely comes with fields we don't model either (e.g. a reason code), and those are what tell us what the status means.
- **Email escalation** (`src/escalations.ts`, `src/mailer.ts`). The server runs `processEscalations` every 30 s, outbox-style: it picks open rows with no `escalated_at` and sends **one** mail per pass listing all of them (a burst of the same new status is one mail, not hundreds), with the transfer, account, the amount still held (holds minus releases from the ledger, not inferred from the status) and a link to the dashboard. It runs outside the webhook path, so a slow or failing SMTP never delays or fails a webhook; a failed send increments `escalation_attempts`, records `last_escalation_error` and is retried next pass. A redelivery of an already-escalated event doesn't mail again. Transport: SMTP when `SMTP_URL` is set, otherwise `.eml` files in `logs/mail/` so local runs need no external service. Recipient `ALERT_EMAIL_TO`, sender `ALERT_EMAIL_FROM`, link `OPS_DASHBOARD_URL`.
- **Replay** (`replayUnhandledEvents`, `POST /ops/unhandled-events/replay`). After shipping support for a status or alias, it re-runs every open row through `handleWebhook` with its stored payload. Rows whose status is still unknown are skipped without counting as another delivery. Any time a parked event is finally applied (replay or a provider redelivery) its row gets `resolved_at`.
- **Dashboard** (`GET /ops`, JSON at `GET /ops/unhandled-events`). Open vs resolved events, the amount still held, escalation state (sent / pending / failed with the error) and a Replay button. Every value can come from a webhook body, so all of it is HTML-escaped (covered by a test with a `<script>` status).

`tests/escalations.test.ts` covers the payload, one mail per batch and no re-mail on redelivery, a failed send being retried, replay (applies the supported event, leaves the unknown one open, idempotent) and the dashboard escaping.

- **Stuck payouts: the age-based backstop** (`src/stuck.ts`, first section of `/ops`, JSON at `GET /ops/stuck-transfers`). Lists outbound transfers still in a non-final status (`created`, `submitted`, `pending`, i.e. hold live and no debit) whose status hasn't changed for more than `STUCK_AFTER_MINUTES` (default 30; `?stuck_after=` overrides it per request), oldest first, with the amount still held from the ledger. Each one gets a likely cause derived from its outbox row and parked webhooks: *never queued* (no outbox row, the TICKET-204 class), *submission failed* (outbox gave up, with the last error), *queued* (still retrying), *unrecognised status* (a parked webhook, the TICKET-202 class) or *no outcome* (submitted, provider silent). The first three that won't fix themselves are shown as loud pills. Unlike the checks above it doesn't depend on knowing the failure mode: it only asks "has this payout stopped moving?". The dashboard's "Funds on hold" counts each transfer once even if it is both stuck and targeted by an open webhook. Covered by `tests/stuck.test.ts` (every cause, the threshold, the HTTP endpoints). Not escalated by email yet: it's a view, not an alert.

Open points: `/ops` has no auth, like every other endpoint in this service; in production it goes behind the internal SSO. Replay only re-runs events with the status as received: resolving one by hand ("treat this `chargeback` as `returned`") would be a money decision from a UI and is deliberately not offered.

### Follow-up (observability)
The worker logs under `WORKER-pass-N` instead of the request's `correlation_id`, so the ticket's own grep hides the webhook that explains the incident. Persisting `correlation_id` on the transfer (or the outbox row) and logging worker/webhook lines with it would make this a one-grep diagnosis.

### Remediation (not solved by code)
TX-0004 in the seeded data stays `submitted` with its hold, because `EVT-0004` was already consumed and is in `processed_events`. Ops should confirm with the provider that the reversal is final, then either replay the outcome (`applyProviderResult(tx, 'reversed')`) or ask the provider to resend it with a fresh event id.

---

## TICKET-203 — Payout shows "failed" but the provider paid it; balance overstated

### Reproduction
`tests/ticket-203.test.ts` creates a $750.00 ACH payout with sandbox scenario `out_of_order` and runs the worker. The provider accepts it and sends two webhooks with **distinct** event ids: `settled`, then `failed`. Before the fix the test failed with `expected 'settled', got 'failed'`.

As in 202, `grep CID-203 logs/incidents.ndjson` shows only `transfer.created` and `outbox.enqueued`, because the worker logs under its own correlation id. The ledger for the transfer tells the story (amount + fee = 77,175):

| # | entry | memo | effect on available |
|---|---|---|---|
| 1 | `hold` | reserve outbound | −771.75 |
| 2 | `debit` | settle outbound | −771.75 |
| 3 | `release` | release hold (settled) | +771.75 |
| 4 | `release` | release hold (failed) | **+771.75** |

Net effect: **0**. Available balance stays at 1,000,000 instead of 922,825, so the client can spend $771.75 that has already left through the provider. Entry 4 also overwrote the status with `failed`, which is what the dashboard shows.

### Mechanism
`applyProviderResult` decided what to do from the **incoming event alone**. It never looked at the transfer's current status. Every webhook posted its ledger entries and overwrote the status, whatever had already happened.

The dedupe in `handleWebhook` doesn't help here. It keys on `provider_event_id`, which catches the *same* event delivered twice, but these are two different events with contradictory outcomes, so both pass. The provider is the source of truth that it paid: the submission is recorded with `outcome: 'settled'` and `statement()` includes it.

The same hole existed for every second outcome, not just `settled → failed`:
- `settled → returned/reversed` released the hold a second time (flagged in 202's ambiguity calls).
- `failed → settled` posted a debit **and** another release: two releases against one hold.
- a late `pending` after `settled` moved the status back to `pending`.

### Fix
`src/transfers.ts`:
- New **`planTransition(from, status)`**: the transfer state machine. Given the current status and the provider outcome, it returns the new status and the ledger entries to post, or `null` when the event must be ignored:

  | from | event | result |
  |---|---|---|
  | `created` / `submitted` / `pending` | `settled` | debit + release → `settled` |
  | same | `failed` / `returned` / `reversed` | release → `failed` / `returned` |
  | same | `pending` | → `pending` |
  | `settled` | `returned` / `reversed` | **credit** → `returned` (clawback) |
  | `failed` | `settled` | **debit only** → `settled` (hold already released) |
  | anything else | — | ignored |

- **`applyProviderResult`** now reads the status (`select … for update`), plans from it, posts the entries and writes the new status in **one `db.transaction`**. Ignored events log `transfer.transition_ignored` (warn) and post nothing. A settled or failed payout changing outcome logs `transfer.outcome_changed` (warn). `transfer.provider_result` now also records `to`.
- The `never` exhaustiveness check from 202 is kept inside the open-state `switch`.

### Why it can't recur
- The decision depends on the transfer's current status, so a stale or contradictory event can't undo a final outcome. Every path keeps the ledger at one hold, at most one release, at most one debit and at most one credit, so the same money can't be released twice.
- Read, decide and write happen in one transaction. PGlite runs every `query` and `transaction` under a single exclusive lock, and on multi-connection Postgres `for update` serializes the two webhooks on the transfer row. Two webhooks for the same transfer can't both plan from the same old status.
- `tests/ticket-203.test.ts` goes from 1 test to 5:
  1. the incident (`settled → failed`): status stays `settled`, balance = funding − 77,175, release = hold, one debit, nothing posted by the stale `failed`;
  2. **every sequence of 1–3 provider events (155)**: release ≤ hold, ≤ 1 debit, ≤ 1 credit, balance matches the final status, and once `settled` has been seen the payout ends `settled` or `returned`, never `failed`/`pending`;
  3. `settled → returned → reversed → settled → failed`: refunded exactly once, and nothing after it moves it again;
  4. `failed → settled`: the missing debit is posted and the release isn't repeated;
  5. `settled` and `failed` delivered concurrently: the hold is released once, and the balance matches whichever outcome won.

  All 5 fail against the old `applyProviderResult` and pass with the fix. The 204/205/206 failures in the suite are the same before and after this change.

### Ambiguity calls
- **`settled` wins over `failed`, in either order.** `settled` is the provider saying the money left, and its statement counts it as paid. Keeping `failed` would repeat this ticket: an overstated balance and overdraft risk. The opposite mistake (debiting a payout that really failed) shows up in reconciliation against the provider statement and is recoverable; letting a client spend money that is gone may not be.
- **Return/reversal after settlement → `credit`, applied automatically.** The debit already happened and the hold is already released, so money coming back is a credit, as noted in 202. The alternative is to park it for manual review before giving the client the funds back (safer against a bogus provider event, slower for a real one). That would be a one-line change in `planTransition`.
- **Ignore, don't reject.** A contradictory event is still marked processed and answered `processed`. It is a valid provider message we have deliberately decided not to act on, so parking it (as 202 does for unknown statuses) or failing it (which makes the provider retry) would add nothing. The warn logs are what surface it to ops.
- **`returned` is fully terminal.** `returned` can mean "released before settlement" or "credited after settlement", and a later `settled` can't tell which. Rather than guess, it is ignored and logged.
- **Lifecycle coverage is partial.** The machine governs provider outcomes only. `created` is set on insert, and `submitted` is still written unconditionally by the outbox worker via `setStatus` (`src/outbox.ts:17`). That's safe today, because the worker only submits `created` transfers, but a stray `setStatus` could still move a final transfer backwards. Follow-up: route `created → submitted` through the state machine as well. It was left out here because it touches the outbox path that 204/205 are changing.

### Follow-up (observability)
Same as 202: worker and webhook lines log under `WORKER-pass-N`, not the request's correlation id, so `grep CID-203` doesn't show the two contradictory webhooks. `transfer.outcome_changed` / `transfer.transition_ignored` are worth an alert: a provider that reports two outcomes for one payout needs a human to confirm which is real.

### Remediation (not solved by code)
The fix stops new overstatements. It doesn't correct TX-0005, which already has the second `release` and status `failed`, and its events are already in `processed_events`, so a redelivery won't replay them. Ops should confirm with the provider that the payout settled, then post a correcting entry that reverses the extra release (−77,175 against Marea Pay's account, memo referencing TX-0005 / TICKET-203) and set the status back to `settled`. Until then the client's available balance is $771.75 too high. Other transfers with the same shape should be searched for: more than one `release` per transfer, or a `debit` on a transfer that isn't `settled`/`returned`.

---

## TICKET-204 — Payout stuck in `created` after an API crash

### Reproduction
`tests/ticket-204.test.ts` turns on the chaos hook (`faults.crashMidRequestFor = 'idem-204'`) and creates a $400.00 ACH payout. Before the fix both tests failed:
1. `no transfer may be held with nothing to submit it`: `TX-0002` was left in `created`, with a hold and no outbox row.
2. `the client retry after the crash gets the payout submitted`: the retry returned the stranded transfer, and it stayed `created` instead of reaching `settled`.

The log shows the same shape: `grep CID-204 logs/incidents.ndjson` has `transfer.created` immediately followed by `api.crash`, and no `outbox.enqueued`.

### Mechanism
`createOutboundTransfer` made three writes, and each one committed on its own:

1. `INSERT transfers` (status `created`): committed
2. `INSERT ledger_entries` (`hold` for amount + fee): committed, funds locked
3. `INSERT outbox` (`transfer.submit`): **never reached**

The crash landed between 2 and 3. The worker finds work only through the `outbox` table, so a transfer with no outbox row is invisible to it: it is never submitted, no webhook ever arrives, and nothing ever releases the hold. `transfer.created` had already been logged before the crash, so the log reported a success that was actually broken.

The client's retry couldn't repair it. The idempotency pre-check found the existing `idem-204` row and returned it (`transfer.idempotent_hit`), so the stranded transfer was handed back unchanged every time.

The design flaw: the service used an outbox, but not a **transactional** outbox. The point of the pattern is that the business write and the event that drives it commit atomically. Here they didn't.

### Fix
`src/transfers.ts` (`createOutboundTransfer`): the transfer insert, the hold and the outbox insert now run in one `db.transaction`.
- A crash anywhere before commit rolls all three back: no transfer, no hold, no outbox row.
- The chaos hook stays between the hold and the outbox insert, now inside the transaction. That is the honest simulation: a real process death drops the connection, and Postgres aborts the uncommitted transaction.
- The TICKET-201 `ON CONFLICT … DO NOTHING` claim moved inside the same transaction. The loser of a concurrent race reads the winner through `tx` and returns it without a hold or outbox event.
- `transfer.created` and `outbox.enqueued` are logged only **after** commit, so the log never describes a transfer that was rolled back.

### Why it can't recur
A held transfer without an outbox event is no longer a state the database can commit: the hold and the event are written in the same transaction or not at all. Because a failed request leaves no row behind, the client's retry with the same idempotency key doesn't hit a stale transfer. It creates the payout from scratch and the worker submits it. The two tests assert both halves: no stranded transfer and no net hold after the crash, and the retry reaching `settled` with exactly amount + fee debited.

On PGlite every `transaction` holds an exclusive lock. On multi-connection Postgres, a concurrent insert of the same idempotency key blocks on the unique index until the first transaction commits (then conflicts) or rolls back (then proceeds), so 201's guarantee holds across the crash too.

### Ambiguity calls
- **Transaction, not a sweeper.** A background job that finds `created` transfers without an outbox row and enqueues or cancels them would also clear the symptom. But it races with requests still in flight, and it has to guess whether to *pay* or *release* money the client never got a success response for. Making the state unreachable is stronger. That query now lives in the ops dashboard as a backstop: the stuck-payouts check flags `created` transfers with no outbox row older than `STUCK_AFTER_MINUTES` as *never queued* (see TICKET-202, *Escalation and replay*).
- **Heal-on-retry rejected.** Enqueuing the missing event when a retry hits a stranded transfer only works if the client retries, and the funds stay locked until then.
- **Reordering the writes rejected.** Writing the outbox row first only moves the crash window: the worker could then submit a transfer that has no hold.

### Still not atomic (next hole)
The worker side isn't atomic either. `provider.submit` → `setStatus('submitted')` → mark outbox `processed` are separate steps, and a crash or timeout between them can resubmit to the provider. That is TICKET-205.

### Remediation (not solved by code)
The fix prevents new stranded payouts. It doesn't touch the seeded TX-0006, which is already committed as `created` with a $411.60 hold (amount + fee) and no outbox row. A retry with `idem-204` will keep returning it. The client received a crash response, not a success, and may already have resent the payout some other way, so **confirm with Marea Pay before acting**. Then either:
- **proceed:** insert the missing `transfer.submit` outbox row so the worker pays it; or
- **cancel:** post a `release` for 41,160 (memo referencing TX-0006 / TICKET-204) and set the status to `failed`, so the client resubmits with a new idempotency key.

Other stranded transfers can be found with: `select t.id from transfers t where t.direction='outbound' and t.status='created' and not exists (select 1 from outbox o where o.transfer_id=t.id)`.

---

## TICKET-205 — Provider paid twice after a timeout; we only see one transfer

### Reproduction
`tests/ticket-205.test.ts` creates a $1,200.00 ACH payout with sandbox scenario `timeout_once` and runs the worker twice. The first pass times out after the provider has already accepted the payment, and the second pass is the retry. Before the fix it failed with `provider accepted it once: 2 !== 1`: the provider's `submissions` held two payouts for the same transfer, and `statement()` listed both.

The seeded incident (TX-0007) shows the same shape. `grep CID-205 logs/incidents.ndjson` only shows `transfer.created` and `outbox.enqueued`, because the worker logs under its own correlation id (see 202). `grep TX-0007` and `grep PROV-0008` give the rest:

```
WORKER-pass-1  provider.submit_error     TX-0007 attempt=1 "provider timeout (no response)" will_retry=true
WORKER-pass-2  provider.submitted        TX-0007 provider_ref=PROV-0020 attempt=2
WORKER-pass-2  webhook.unknown_transfer  EVT-0009 provider_ref=PROV-0008 status=settled
WORKER-pass-2  webhook.received          EVT-0021 provider_ref=PROV-0020 TX-0007 settled
```

`PROV-0008` is the first payout, the one that "timed out". The provider did pay it, and its `settled` webhook arrived later, but by then the transfer only knew about `PROV-0020`. So that webhook matched nothing. That's the `webhook.unknown_transfer` warning the ticket mentions, and it's why our side shows one transfer settled once while the provider's statement shows two payouts.

### Mechanism
A timeout doesn't tell us whether the provider got the request. Two different situations look identical from our side:

| What really happened | What the worker sees |
|---|---|
| The request never reached the provider | timeout |
| The provider accepted and paid, and the response was lost on the way back | timeout |

The worker treats every provider error as transient: the outbox row goes back to `pending` and the next pass calls `provider.submit(t)` again. That call sent **no idempotency key**, although the provider supports one (`src/providers.ts`: "de-duplicates on a client-supplied idempotency key, if one is provided"). Without a key the provider can't tell a retry from a new payment, so it accepted the transfer a second time with a new `provider_ref` and paid the vendor again.

The retry is necessary, because in the first situation nothing was paid. The bug was that the retry wasn't safe to repeat.

### Fix
`src/outbox.ts` (`processOutbox`): the worker passes the transfer id as the provider idempotency key on every attempt:

```ts
const res = provider.submit(t, t.id);
```

On a retry the provider recognises the key and returns the **original** `provider_ref` without paying again. It also returns the webhooks still pending from the first acceptance. The worker stores that original ref and applies the late `settled` webhook, which now matches the transfer. So the payout settles once, both at the provider and in our ledger.

### Why it can't recur
Whatever happened on the first attempt, every retry of a transfer carries the same key, so the provider accepts it at most once:
- if the first attempt never arrived, the provider has never seen the key and pays normally;
- if it arrived and was paid, the provider returns the existing acceptance.

The worker doesn't need to know which case it was. This also closes the worker-side hole noted at the end of TICKET-204: a crash between `provider.submit` and marking the outbox row `processed` leads to a resubmission, and that resubmission is now harmless. The test asserts it from the provider's side, with exactly one submission for the transfer and one line on the settlement statement.

### Ambiguity calls
- **Transfer `id` as the key, not the client's `idempotency_key`.** They solve different problems. The client's key keeps the *client* from creating two transfers (TICKET-201). The provider key keeps *our worker* from submitting one transfer twice. `idempotency_key` is nullable, so a transfer created without one would still be paid twice. `id` always exists, is unique per transfer, and is identical on every retry because each attempt reads the same row.
- **Idempotent retry, not "stop retrying after a timeout".** Never retrying a timeout would strand every payout whose request simply got lost. Blind retries pay twice. Only the provider knows which case happened, and the key is how we let it decide.
- **We trust the provider to honour the key.** For this mock that's confirmed by its code and by the test, which counts the provider's own `submissions`. For a real provider, confirm it against their docs and a sandbox run before relying on it, and check four things:
  - where the key goes (header vs body — a misplaced key is silently ignored);
  - how long the provider remembers it, e.g. 24 h at Stripe (our retries happen within seconds, but a manual replay days later wouldn't be covered);
  - what happens when the same key arrives with a different payload;
  - how a retry that arrives while the first request is still processing is answered.
- **`submit`'s key is still optional.** The next caller that writes `provider.submit(t)` (e.g. a manual resubmit on `/ops`) would bring the bug back without any warning. Follow-up, in the spirit of 202's `never` check: a single `submitTransfer(t)` wrapper that always derives the key, so there's no way to submit without one.

### Still open (found while fixing this)
- **A webhook that arrives before `provider_ref` is saved is lost.** After a timeout we never learn the `provider_ref`. In production the `settled` webhook comes over HTTP, and it can arrive before the retry. `handleWebhook` writes `processed_events` before it looks up the transfer, so the event is consumed as `unknown_transfer`, and the redelivery is skipped as a duplicate. The transfer stays `submitted` with its hold, although the provider paid. Reproduced by hand: first delivery `unknown_transfer`, redelivery `skipped`, final status `submitted`. It's the same bug class as 202, where an event is consumed that couldn't be applied. The fix is the same too: only mark the event processed once the transfer is found, and otherwise park it for replay. Alternatively, send our transfer id to the provider so the webhook carries it. In this test the idempotent retry happens to repair it, because the mock returns the late webhook in the retry response.
- **An exhausted retry after a timeout may have been paid.** When the outbox row reaches `MAX_ATTEMPTS` and goes to `failed`, the transfer stays `created` with its hold. That's correct, because releasing the hold could hand back money that already left. But nothing escalates it beyond the stuck-payouts view, and it needs a human to ask the provider.

### Follow-up (observability)
Same as 202/203: the worker logs under `WORKER-pass-N`. The incident was only traceable by grepping the transfer id and then the first `provider_ref`. Logging each attempt's provider ref and key on `provider.submit_error` would make "did the first attempt get through?" a single query.

### Remediation (not solved by code)
The fix prevents new double payouts. It doesn't recover the one that already happened. For TX-0007 the provider paid $1,200.00 twice (`PROV-0008` and `PROV-0020`). Our ledger debited the client once (amount + fee on `PROV-0020`), so the client's balance is right, and **the extra payout is our loss, not the client's**. Ops should ask the provider to reverse `PROV-0008`, or recover it from the vendor, and record the outcome against TX-0007 / TICKET-205. `EVT-0009` is already in `processed_events`, so a redelivery of the first payout's webhook won't be applied. To find other affected payouts, look for provider submissions whose `provider_ref` doesn't match any transfer, or `webhook.unknown_transfer` warnings for a transfer that also has a `provider.submit_error`.
