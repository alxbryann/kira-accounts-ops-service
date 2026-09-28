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
