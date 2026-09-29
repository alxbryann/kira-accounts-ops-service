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
- An unmodeled status can no longer be silently swallowed: it can't reach `applyProviderResult`, it doesn't burn the event id, and it leaves a parked row plus an error-level log. `tests/provider-status.test.ts` covers the normalization, a status in a different case being applied, and an unknown status being parked (not consumed, redeliveries counted) and then applied exactly once when redelivered with a supported status. The ops monitor's "stuck / non-terminal transfers" check stays as the backstop that catches it by age.

### Ambiguity calls
- **Final status `returned` vs a new `reversed` status.** I chose `returned`. It is an existing terminal status, so the schema, the dashboard and reconciliation don't change, and the ledger effect is identical. The ledger memo still records that the provider said `reversed`. Trade-off: the client and the provider call it "reversed", and in payments "returned" often means the receiving bank bounced it. A separate status would read closer to the provider's own wording.
- **Release, not debit + credit.** Before settlement our ledger only has a `hold`, so a `release` undoes it exactly. Posting a debit and a credit would record a payment and a refund that never happened. A reversal that arrives **after** `settled` (a real-world clawback) is different: the debit already happened, so it needs a `credit`. Which transitions are legal from which state is the state machine TICKET-203 introduces. **Until 203 lands, `reversed` after `settled` would release the money a second time.** That is the same bug class as 203, not a regression from this change.
- **Unknown status: park, don't throw.** Throwing looks stricter but causes harm here. The worker delivers webhooks inside the outbox `try`: a throw lands in its `catch`, which puts the row back to `pending`, and the next pass calls `provider.submit` again with no idempotency key. That pays the vendor twice. Parking the event keeps it recoverable without touching the outbox.
- **`200` for an unknown status, not `422`.** The event is safely parked, so asking the provider to retry would only add a retry storm on something we can't process yet. Trade-off: recovery depends on the provider redelivering the event, or on a replay tool over `unhandled_provider_events`, which doesn't exist yet (follow-up). If we'd rather lean on the provider's retries, switching the endpoint to `422` is a one-line change.
- **No provider aliases yet.** `normalizeProviderStatus` only normalizes case and whitespace. Mapping e.g. `completed → settled` without the provider's docs would be guessing what money movement a word means, so aliases are added only once confirmed.
- **We don't know *why* it was reversed.** The provider sent only the status, with no reason code. Client comms should say the payout was reversed by the provider and the funds are released, without guessing a cause.

### Follow-up (observability)
The worker logs under `WORKER-pass-N` instead of the request's `correlation_id`, so the ticket's own grep hides the webhook that explains the incident. Persisting `correlation_id` on the transfer (or the outbox row) and logging worker/webhook lines with it would make this a one-grep diagnosis.

### Remediation (not solved by code)
TX-0004 in the seeded data stays `submitted` with its hold, because `EVT-0004` was already consumed and is in `processed_events`. Ops should confirm with the provider that the reversal is final, then either replay the outcome (`applyProviderResult(tx, 'reversed')`) or ask the provider to resend it with a fresh event id.
