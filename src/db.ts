import { PGlite } from '@electric-sql/pglite';

export const SCHEMA = `
create table if not exists accounts (
  id text primary key,
  name text not null,
  currency text not null default 'USD',
  created_at timestamptz not null default now()
);
create table if not exists transfers (
  id text primary key,
  account_id text not null references accounts(id),
  direction text not null,           -- 'outbound' | 'inbound'
  rail text not null,                -- 'ach' | 'crypto'
  amount_cents bigint not null,
  fee_cents bigint not null default 0,
  status text not null,              -- created | submitted | pending | settled | failed | returned
  idempotency_key text,
  provider_ref text,
  scenario text,                     -- provider sandbox scenario code (see providers.ts)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One transfer per client idempotency key, enforced by the database so concurrent retries can't race past it.
create unique index if not exists transfers_idempotency_key_uq
  on transfers(idempotency_key) where idempotency_key is not null;
create table if not exists ledger_entries (
  id bigserial primary key,
  transfer_id text,
  account_id text not null,
  entry_type text not null,          -- 'credit' | 'debit' | 'hold' | 'release'
  amount_cents bigint not null,
  memo text,
  created_at timestamptz not null default now()
);
create table if not exists outbox (
  id bigserial primary key,
  event_type text not null,          -- 'transfer.submit'
  transfer_id text not null,
  status text not null default 'pending',   -- pending | processed | failed
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create table if not exists processed_events (
  provider_event_id text primary key,
  processed_at timestamptz not null default now()
);
`;

export async function openDb(dataDir?: string): Promise<PGlite> {
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.exec(SCHEMA);
  return db;
}
