create table if not exists corrections (
  id bigint generated always as identity primary key,
  thread_id text not null,
  decision_id bigint references decisions(id),
  category_id text not null,
  observed_from text not null default 'sent-forward',
  sent_message_id text,
  created_at timestamptz not null default now()
);
create index if not exists corrections_thread_idx on corrections(thread_id);

create table if not exists exemplars (
  id bigint generated always as identity primary key,
  category_id text not null,
  from_addr text not null default '',
  subject text not null default '',
  body_excerpt text not null default '',
  tier text not null check (tier in ('gold','llm')),
  created_at timestamptz not null default now()
);

alter table decisions add column if not exists config_hash text;

insert into ingest_state (id, checkpoint_ms) values (2, 0) on conflict do nothing;
