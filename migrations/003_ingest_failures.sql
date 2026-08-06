create table if not exists ingest_failures (
  thread_id text primary key,
  count int not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);
