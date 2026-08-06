create table if not exists threads (
  thread_id text primary key,
  from_addr text not null,
  subject text not null default '',
  attachments jsonb not null default '[]',
  list_id text,
  body_excerpt text not null default '',
  internal_date_ms bigint not null,
  first_seen timestamptz not null default now()
);

create table if not exists decisions (
  id bigint generated always as identity primary key,
  thread_id text not null references threads(thread_id),
  stage text not null,
  rule_hits jsonb not null default '[]',
  llm_output jsonb,
  final_tasks jsonb not null default '[]',
  confidence text,
  status text not null default 'decided'
    check (status in ('decided','needs_review','acted','failed')),
  actions_planned jsonb not null default '[]',
  actions_executed jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index if not exists decisions_thread_idx on decisions(thread_id);
create index if not exists decisions_status_idx on decisions(status);

create table if not exists reviews (
  id bigint generated always as identity primary key,
  decision_id bigint not null references decisions(id),
  corrected_tasks jsonb not null,
  reviewer text not null,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists rules (
  id bigint generated always as identity primary key,
  pattern_type text not null
    check (pattern_type in ('sender_exact','sender_domain','list_id','subject_template')),
  pattern text not null,
  label_set jsonb not null,
  forward_to text,
  complete boolean not null default true,
  purity real,
  support int,
  source text not null default 'manual',
  active boolean not null default true,
  unique (pattern_type, pattern)
);

create table if not exists app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists ingest_state (
  id int primary key,
  checkpoint_ms bigint not null,
  last_success_at timestamptz
);
insert into ingest_state (id, checkpoint_ms) values (1, 0) on conflict do nothing;
