// Chaos hooks used by the sandbox to simulate infrastructure failures.
// (Real deployments set these via env; here the seed toggles them.)
//  - crashMidRequestFor:  idempotency key whose POST /transfers dies between the hold and the outbox insert
//  - crashApplyingEvent:  provider event id whose webhook dies after the ledger entries, before commit
export const faults: { crashMidRequestFor?: string; crashApplyingEvent?: string } = {};
