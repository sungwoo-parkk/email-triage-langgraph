create table if not exists observations (
  id          bigint generated always as identity primary key,
  thread_id   text not null,
  decision_id bigint not null references decisions(id),
  category_id text not null,
  source      text not null default 'sent-forward',
  observed_at timestamptz not null default now(),
  unique (decision_id, category_id)
);
create index if not exists observations_decision_idx on observations(decision_id);

create or replace view v_agreement as
select d.id as decision_id,
       d.thread_id,
       d.created_at,
       d.confidence,
       coalesce(p.predicted, array[]::text[]) as predicted,
       o.observed,
       coalesce(p.predicted, array[]::text[]) = o.observed as agreed
from decisions d
cross join lateral (
  select array_agg(distinct (t->>'categoryId') order by (t->>'categoryId')) as predicted
  from jsonb_array_elements(d.final_tasks) as t
) p
cross join lateral (
  select array_agg(distinct obs.category_id order by obs.category_id) as observed
  from observations obs
  where obs.decision_id = d.id
) o
where o.observed is not null;

create or replace view v_category_stats as
with predicted as (
  select d.id as decision_id, (t->>'categoryId') as category_id
  from decisions d, jsonb_array_elements(d.final_tasks) as t
  where exists (select 1 from observations o where o.decision_id = d.id)
),
observed as (
  select o.decision_id, o.category_id from observations o
)
select coalesce(p.category_id, ob.category_id) as category_id,
       count(p.category_id) as predicted_n,
       count(ob.category_id) as observed_n,
       count(*) filter (where p.category_id is not null and ob.category_id is not null) as match_n
from predicted p
full outer join observed ob
  on ob.decision_id = p.decision_id and ob.category_id = p.category_id
group by 1;
