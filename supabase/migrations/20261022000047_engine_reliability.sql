-- P0: versioned plan replacement, durable external sync, and session evidence.
alter table public.planned_workouts drop constraint if exists planned_workouts_type_check;
alter table public.planned_workouts add constraint planned_workouts_type_check
 check(type in ('run','ride','swim','strength','rest'));
create table public.plan_versions (
 user_id uuid primary key references auth.users on delete cascade,
 revision bigint not null default 0
);
create table public.plan_history (
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users on delete cascade,
 planned_id uuid not null, operation text not null, snapshot jsonb not null,
 recorded_at timestamptz not null default now()
);
create table public.plan_requests (
 user_id uuid not null references auth.users on delete cascade,
 request_id uuid not null, request_scope jsonb not null, result jsonb not null,
 created_at timestamptz not null default now(), primary key(user_id,request_id)
);
create table public.calendar_outbox (
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users on delete cascade,
 planned_id uuid not null, event_id text, operation text not null check(operation in ('upsert','delete')),
 payload jsonb not null, attempts int not null default 0,
 available_at timestamptz not null default now(), lease_until timestamptz,
 lease_token uuid, finished_at timestamptz, last_error text,
 created_at timestamptz not null default now()
);
alter table public.planned_workouts add column engine_version text;
alter table public.planned_workouts add column generation_request_id uuid;
alter table public.planned_workouts add column sync_requested boolean not null default false;
update public.planned_workouts set sync_requested=true where intervals_event_id is not null;
create index calendar_outbox_pending on public.calendar_outbox(user_id,available_at,id) where finished_at is null;

-- RLS for read-only client inspection; writes are through trusted RPCs/triggers.
do $$ declare t text; begin
 foreach t in array array['plan_versions','plan_history','plan_requests','calendar_outbox'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy own_read on public.%I for select to authenticated using (user_id=auth.uid())',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;

create function public.engine_owner(p_owner uuid) returns void
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if auth.uid() is distinct from p_owner and coalesce(auth.role(),'') <> 'service_role' then
  raise exception 'Account changed' using errcode='42501';
 end if;
end $$;

create function public.plan_revision(p_owner uuid) returns bigint
language plpgsql security definer set search_path=public,pg_temp as $$
declare r bigint;
begin
 perform engine_owner(p_owner);
 insert into plan_versions(user_id) values(p_owner) on conflict do nothing;
 select revision into r from plan_versions where user_id=p_owner;
 return r;
end $$;

create function public.record_plan_change() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare r planned_workouts; changed boolean;
begin
 if TG_OP='DELETE' then r:=old; else r:=new; end if;
 changed := TG_OP <> 'UPDATE';
 if TG_OP='UPDATE' then
  changed := (to_jsonb(new)-array['intervals_event_id','pushed_at']) is distinct from
             (to_jsonb(old)-array['intervals_event_id','pushed_at']);
 end if;
 if not changed then return r; end if;
 insert into plan_versions(user_id,revision) values(r.user_id,1)
  on conflict(user_id) do update set revision=plan_versions.revision+1;
 insert into plan_history(user_id,planned_id,operation,snapshot)
  values(r.user_id,r.id,TG_OP,case when TG_OP='UPDATE' then jsonb_build_object('before',to_jsonb(old),'after',to_jsonb(new)) else to_jsonb(r) end);
 if r.sync_requested or r.intervals_event_id is not null then
  insert into calendar_outbox(user_id,planned_id,event_id,operation,payload)
   values(r.user_id,r.id,r.intervals_event_id,
    case when TG_OP='DELETE' or r.skipped or r.type='rest' then 'delete' else 'upsert' end,to_jsonb(r));
 end if;
 return r;
end $$;
create trigger plan_change after insert or update or delete on public.planned_workouts
 for each row execute function public.record_plan_change();

create function public.replace_generated_plan(p_owner uuid,p_request uuid,p_scope jsonb,
 p_revision bigint,p_from date,p_to date,p_rows jsonb,p_week jsonb default null,p_metadata jsonb default '{}'::jsonb,p_replace boolean default true) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare previous plan_requests; x jsonb; result jsonb; inserted jsonb:='[]'; row planned_workouts; rev bigint;
begin
 perform engine_owner(p_owner);
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,47));
 select * into previous from plan_requests where user_id=p_owner and request_id=p_request;
 if found then
  if previous.request_scope is distinct from p_scope then raise exception 'request key reused for different input' using errcode='22023'; end if;
  return previous.result;
 end if;
 insert into plan_versions(user_id) values(p_owner) on conflict do nothing;
 select revision into rev from plan_versions where user_id=p_owner for update;
 if rev<>p_revision then raise exception 'plan changed; refresh before generating again' using errcode='40001'; end if;
 if p_request is null or p_from is null or p_to is null or p_to<p_from or p_to-p_from>366
   or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)=0 then
  raise exception 'invalid replacement range or empty plan' using errcode='22023';
 end if;
 -- Validate everything before deletion. Application validation is stronger;
 -- this backstop also protects calls made directly through the RPC.
 for x in select value from jsonb_array_elements(p_rows) loop
  if (x->>'date')::date not between p_from and p_to or x->>'date' is null
   or x->>'type' not in ('run','ride','swim','strength','rest') or x->>'type' is null
   or jsonb_typeof(x->'workout_json') is distinct from 'object'
   or x->'workout_json'->>'type' is distinct from x->>'type'
   or jsonb_typeof(x->'workout_json'->'sections') is distinct from 'array' then
   raise exception 'invalid session' using errcode='22023';
  end if;
  if exists(select 1 from planned_workouts where user_id=p_owner and date=(x->>'date')::date
    and (completed or skipped or locked or not p_replace)) then
   raise exception 'protected session on requested date' using errcode='40001';
  end if;
 end loop;
 if (select count(*)<>count(distinct value->>'date') from jsonb_array_elements(p_rows)) then
  raise exception 'duplicate plan dates' using errcode='22023';
 end if;
 -- Only replace requested dates. Protected and unmentioned days are immutable.
 if p_replace then
  delete from planned_workouts where user_id=p_owner and not completed and not skipped and not locked
   and date in (select (value->>'date')::date from jsonb_array_elements(p_rows));
 end if;
 for x in select value from jsonb_array_elements(p_rows) loop
  insert into planned_workouts(user_id,date,type,workout_json,llm_provider,llm_model,locked,
    sync_requested,engine_version,generation_request_id)
   values(p_owner,(x->>'date')::date,x->>'type',x->'workout_json',x->>'llm_provider',x->>'llm_model',
    coalesce((x->>'locked')::boolean,false),coalesce((x->>'sync_requested')::boolean,false),
    coalesce(p_metadata->>'engine_version','engine-2026-10-22.1'),p_request) returning * into row;
  inserted:=inserted||jsonb_build_array(to_jsonb(row));
 end loop;
 if p_week is not null then
  insert into week_plans(user_id,start_date,focus,rationale)
   values(p_owner,(p_week->>'start_date')::date,p_week->>'focus',p_week->>'rationale')
   on conflict(user_id,start_date) do update set focus=excluded.focus,rationale=excluded.rationale;
 end if;
 result:=jsonb_build_object('rows',inserted,'revision',(select revision from plan_versions where user_id=p_owner)) || coalesce(p_metadata,'{}'::jsonb);
 insert into plan_requests values(p_owner,p_request,p_scope,result,now());
 return result;
end $$;

-- Worker lease: one outstanding operation per athlete at a time, bounded fetch
-- timeout in worker < lease duration. A token prevents stale acknowledgements.
create function public.claim_calendar_job(p_owner uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare j calendar_outbox;
begin
 perform engine_owner(p_owner);
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,48));
 if exists(select 1 from calendar_outbox where user_id=p_owner and finished_at is null and lease_until>now()) then return null; end if;
 select * into j from calendar_outbox where user_id=p_owner and finished_at is null order by id limit 1 for update;
 if not found or j.available_at>now() then return null; end if;
 update calendar_outbox set lease_until=now()+interval '2 minutes',lease_token=gen_random_uuid(),attempts=attempts+1
  where id=j.id returning * into j;
 return to_jsonb(j);
end $$;
create function public.finish_calendar_job(p_owner uuid,p_id bigint,p_token uuid,p_error text default null) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform engine_owner(p_owner);
 update calendar_outbox set finished_at=case when p_error is null then now() else null end,
  last_error=left(p_error,1000),lease_until=null,lease_token=null,
  available_at=now()+least(interval '1 hour',interval '10 seconds'*power(2,least(attempts,8)))
 where user_id=p_owner and id=p_id and lease_token=p_token;
end $$;

create function public.request_calendar_sync(p_owner uuid,p_planned uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare p planned_workouts;
begin
 perform engine_owner(p_owner);
 select * into p from planned_workouts where id=p_planned and user_id=p_owner for update;
 if not found then raise exception 'planned session not found' using errcode='P0002'; end if;
 insert into calendar_outbox(user_id,planned_id,event_id,operation,payload)
 values(p_owner,p.id,p.intervals_event_id,case when p.skipped or p.type='rest' then 'delete' else 'upsert' end,to_jsonb(p));
end $$;

revoke all on function public.engine_owner(uuid),public.plan_revision(uuid),
 public.replace_generated_plan(uuid,uuid,jsonb,bigint,date,date,jsonb,jsonb,jsonb,boolean),
 public.claim_calendar_job(uuid),public.finish_calendar_job(uuid,bigint,uuid,text) from public;
grant execute on function public.engine_owner(uuid),public.plan_revision(uuid),
 public.replace_generated_plan(uuid,uuid,jsonb,bigint,date,date,jsonb,jsonb,jsonb,boolean),
 public.claim_calendar_job(uuid),public.finish_calendar_job(uuid,bigint,uuid,text) to authenticated,service_role;
-- These mutating operations must pass through the edge-function validators and
-- outbox worker; authenticated clients cannot bypass either path via RPC.
revoke execute on function public.replace_generated_plan(uuid,uuid,jsonb,bigint,date,date,jsonb,jsonb,jsonb,boolean),
 public.claim_calendar_job(uuid),public.finish_calendar_job(uuid,bigint,uuid,text) from authenticated;
grant execute on function public.replace_generated_plan(uuid,uuid,jsonb,bigint,date,date,jsonb,jsonb,jsonb,boolean),
 public.claim_calendar_job(uuid),public.finish_calendar_job(uuid,bigint,uuid,text) to service_role;
revoke all on function public.request_calendar_sync(uuid,uuid) from public;
grant execute on function public.request_calendar_sync(uuid,uuid) to authenticated,service_role;

alter table public.completed_activities
 add column source text,
 add column source_id text,
 add column started_at timestamptz,
 add column ended_at timestamptz,
 add column start_local_date date,
 add column end_local_date date,
 add column timezone_name text,
 add column timezone_provenance text not null default 'unavailable',
 add column measurement_provenance jsonb not null default '{}',
 add column dedup_exempt boolean not null default false,
 add column received_at timestamptz not null default now(),
 add column content_revision bigint not null default 1,
 add column planned_workout_id uuid references public.planned_workouts on delete set null,
 add column link_source text check(link_source in ('inferred','athlete')),
 add column session_state text not null default 'unknown' check(session_state in
  ('completed_as_planned','modified','substituted','unplanned','unknown')),
 add column corrected_type text,
 add column duplicate_of uuid references public.completed_activities on delete restrict,
 add column session_group_id uuid;
create index activity_plan_link on completed_activities(user_id,planned_workout_id);
create index activity_source_identity on completed_activities(user_id,source,source_id);
create unique index activity_source_identity_unique on completed_activities(user_id,source,source_id)
 where source is not null and source_id is not null;
create table public.activity_sync_state (
 user_id uuid not null references auth.users on delete cascade, source text not null,
 last_attempt_at timestamptz not null default now(), last_success_at timestamptz,
 coverage_from date, coverage_to date, last_error text,
 primary key(user_id,source)
);
alter table activity_sync_state enable row level security;
create policy own_sync on activity_sync_state for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
grant select,insert,update on activity_sync_state to authenticated;

create function public.activity_sport(t text) returns text language sql immutable as $$
 select case when lower(t) like '%run%' then 'run'
 when lower(t) ~ '(ride|bike|cycl)' then 'ride'
 when lower(t) like '%swim%' then 'swim'
 when lower(t) ~ '(weight|strength|gym)' then 'strength' else null end
$$;

create function public.normalize_activity() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 new.source:=coalesce(new.source,case when new.intervals_id like 'hc:%' then 'health_connect'
  when new.intervals_id like 'manual:%' then 'manual' else 'intervals' end);
 new.source_id:=coalesce(new.source_id,new.intervals_id);
 new.session_group_id:=coalesce(new.session_group_id,new.id);
 new.start_local_date:=coalesce(new.start_local_date,new.date);
 new.end_local_date:=coalesce(new.end_local_date,new.start_local_date);
 if TG_OP='INSERT' then new.received_at:=coalesce(new.received_at,now()); end if;
 if new.planned_workout_id is not null and not exists(select 1 from planned_workouts where id=new.planned_workout_id and user_id=new.user_id) then raise exception 'invalid plan owner' using errcode='42501'; end if;
 if new.duplicate_of is not null and not exists(select 1 from completed_activities where id=new.duplicate_of and user_id=new.user_id and id<>new.id and duplicate_of is null) then raise exception 'invalid duplicate owner' using errcode='42501'; end if;
 -- Intervals timestamps are parsed before cross-source identity matching.
 if new.started_at is null and new.data_json->>'start_date' ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' then
  begin new.started_at:=(new.data_json->>'start_date')::timestamptz; exception when others then null; end;
 end if;
 if new.ended_at is null and new.started_at is not null and new.data_json->>'elapsed_time' is not null then
  begin new.ended_at:=new.started_at+make_interval(secs=>(new.data_json->>'elapsed_time')::float8); exception when others then null; end;
 end if;
 if new.duplicate_of is null and not new.dedup_exempt and new.started_at is not null and new.duration_seconds is not null then
  select a.id into new.duplicate_of from completed_activities a
   where a.user_id=new.user_id and a.id<>new.id and a.duplicate_of is null
    and not a.dedup_exempt and a.source is distinct from new.source
    and activity_sport(coalesce(a.corrected_type,a.type))=activity_sport(coalesce(new.corrected_type,new.type))
    and a.started_at is not null and abs(extract(epoch from a.started_at-new.started_at))<=10
    and a.duration_seconds is not null and abs(a.duration_seconds-new.duration_seconds)<=30
    and (a.distance_m is null or new.distance_m is null or abs(a.distance_m-new.distance_m)<=greatest(25,a.distance_m*0.01))
   order by case a.source when 'intervals' then 0 when 'health_connect' then 1 else 2 end, a.received_at,a.id limit 1;
 end if;

 if new.measurement_provenance='{}' then
  new.measurement_provenance:=jsonb_build_object(
   'duration_seconds',case when new.duration_seconds is null then 'unavailable' when new.source='manual' then 'user_reported' else 'observed' end,
   'distance_m',case when new.distance_m is null then 'unavailable' when new.source='manual' then 'user_reported' else 'observed' end,
   'avg_hr',case when new.avg_hr is null then 'unavailable' when new.source='manual' then 'user_reported' else 'observed' end,
   'tss',case when new.tss is null then 'unavailable' else 'estimated' end);
 end if;
 if new.duration_seconds<0 or new.distance_m<0 or new.tss<0 or new.ended_at<new.started_at then
  raise exception 'invalid activity measurement' using errcode='22023';
 end if;
 if TG_OP='UPDATE' and (new.type,new.date,new.duration_seconds,new.distance_m,new.avg_hr,new.tss,new.data_json,
   new.corrected_type,new.duplicate_of,new.planned_workout_id,new.session_state) is distinct from
  (old.type,old.date,old.duration_seconds,old.distance_m,old.avg_hr,old.tss,old.data_json,
   old.corrected_type,old.duplicate_of,old.planned_workout_id,old.session_state) then
  new.content_revision:=old.content_revision+1;
  new.analysis_json:=null;
 end if;
 return new;
end $$;
create trigger normalize_activity before insert or update on completed_activities for each row execute function normalize_activity();
-- Populate provenance for existing observations without inventing timestamps.
update completed_activities set source=source;

create function public.reconcile_sessions(p_owner uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,49));
 -- Only a mutually unique date/sport pair may be inferred. Double sessions
 -- stay ambiguous unless the athlete links them. Inference never sets completed.
 with candidates as (
  select a.id aid,p.id pid,count(*) over(partition by a.id) ac,count(*) over(partition by p.id) pc
  from completed_activities a join planned_workouts p on p.user_id=a.user_id
   and p.date=coalesce(a.start_local_date,a.date)
   and p.type=activity_sport(coalesce(a.corrected_type,a.type))
  where a.user_id=p_owner and a.duplicate_of is null and a.link_source is distinct from 'athlete'
   and ((a.planned_workout_id=p.id) or (not p.skipped and not p.completed)) and p.type<>'rest'
   and not exists(select 1 from completed_activities x where x.user_id=p_owner and x.planned_workout_id=p.id and x.link_source='athlete')
 ), desired as (select aid,pid from candidates where ac=1 and pc=1)
 update completed_activities a set planned_workout_id=d.pid,
   link_source=case when d.pid is not null then 'inferred' end,session_state='unknown'
 from (select x.id,y.pid from completed_activities x left join desired y on y.aid=x.id
   where x.user_id=p_owner and x.link_source is distinct from 'athlete') d
 where a.id=d.id and (a.planned_workout_id,a.link_source) is distinct from
   (d.pid,case when d.pid is not null then 'inferred'::text end);
end $$;

create function public.reconcile_after_change() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare owner uuid; d1 date; d2 date;
begin
 -- Only trusted triggers and service-role callers can invoke reconciliation.
 owner:=coalesce(new.user_id,old.user_id);
 perform reconcile_sessions(owner);
 if TG_TABLE_NAME='planned_workouts' then
  d1:=case when TG_OP='DELETE' then old.date else new.date end;
  d2:=case when TG_OP='UPDATE' then old.date end;
  delete from strength_analyses where user_id=owner and date in (d1,d2);
  update completed_activities set analysis_json=null where user_id=owner
   and coalesce(start_local_date,date) in (d1,d2) and analysis_json is not null;
 else
  d1:=case when TG_OP='DELETE' then old.date else new.date end;
  d2:=case when TG_OP='UPDATE' then old.date end;
  delete from strength_analyses where user_id=owner and date in (d1,d2);
 end if;
 return null;
end $$;
create trigger reconcile_activity after insert or delete or update of type,date,started_at,ended_at,duration_seconds,distance_m,data_json,corrected_type,duplicate_of
 on completed_activities for each row execute function reconcile_after_change();
create trigger reconcile_plan after insert or delete or update of date,type,completed,skipped
 on planned_workouts for each row execute function reconcile_after_change();

create view public.activity_duplicate_candidates with (security_invoker=true) as
 select a.user_id,a.id first_id,b.id second_id,a.source first_source,b.source second_source,
  a.type activity_type,a.date activity_date,a.duration_seconds first_duration,b.duration_seconds second_duration,
  a.distance_m first_distance,b.distance_m second_distance
 from completed_activities a join completed_activities b on b.user_id=a.user_id and a.id<>b.id
 and a.duplicate_of is null and (b.duplicate_of is not null or a.id<b.id)
 and coalesce(a.corrected_type,a.type)=coalesce(b.corrected_type,b.type)
 and (a.date=b.date or b.duplicate_of=a.id)
 and a.source is distinct from b.source
 and abs(coalesce(a.duration_seconds,0)-coalesce(b.duration_seconds,0))<=60
 and (a.distance_m is null or b.distance_m is null or abs(a.distance_m-b.distance_m)<=greatest(50,a.distance_m*0.02))
 where a.user_id=auth.uid();
grant select on activity_duplicate_candidates to authenticated;

create function public.correct_session(p_activity uuid,p_plan uuid,p_state text,p_type text default null,
 p_duplicate uuid default null,p_group uuid default null,p_revision bigint default null,p_unmerge uuid default null) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare owner uuid:=auth.uid(); a completed_activities;
begin
 if owner is null then raise exception 'unauthorized' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,49));
 select * into a from completed_activities where id=p_activity and user_id=owner for update;
 if not found then raise exception 'activity not found' using errcode='42501'; end if;
 if p_revision is not null and a.content_revision<>p_revision then raise exception 'activity changed; refresh' using errcode='40001'; end if;
 if p_state not in ('completed_as_planned','modified','substituted','unplanned','unknown') or p_state is null then raise exception 'invalid state'; end if;
 if p_plan is not null and not exists(select 1 from planned_workouts where id=p_plan and user_id=owner and not skipped and type<>'rest') then raise exception 'plan not available' using errcode='42501'; end if;
 if p_state in ('completed_as_planned','modified','substituted') and p_plan is null then raise exception 'plan required'; end if;
 if p_state='unplanned' and p_plan is not null then raise exception 'unplanned cannot have a plan'; end if;
 if p_duplicate is not null and (p_plan is not null or p_state not in ('unknown','unplanned') or p_duplicate=p_activity or not exists(select 1 from completed_activities where id=p_duplicate and user_id=owner and duplicate_of is null)
  or exists(select 1 from completed_activities where duplicate_of=p_activity)) then raise exception 'invalid duplicate identity'; end if;
 if p_group is not null and not exists(select 1 from completed_activities where id=p_group and user_id=owner and duplicate_of is null) then raise exception 'invalid group'; end if;
 if p_unmerge is not null and not exists(select 1 from completed_activities where id=p_unmerge and user_id=owner and duplicate_of=p_activity) then raise exception 'invalid duplicate correction'; end if;
 if p_unmerge is not null then update completed_activities set duplicate_of=null,dedup_exempt=true where id=p_unmerge and user_id=owner; end if;
 update completed_activities set planned_workout_id=p_plan,session_state=p_state,link_source='athlete',
  corrected_type=nullif(trim(p_type),''),duplicate_of=p_duplicate,
  dedup_exempt=case when p_duplicate is not null then true else dedup_exempt end,session_group_id=coalesce(p_group,id)
  where id=p_activity and user_id=owner;
 perform reconcile_sessions(owner);
end $$;

-- Reads use effective observations; raw source records remain intact for audit
-- and reversible duplicate correction. Views retain the invoker's RLS.
create view public.effective_activities with (security_invoker=true) as
 select id,user_id,intervals_id,coalesce(corrected_type,type) type,date,duration_seconds,distance_m,avg_hr,tss,ctl,atl,data_json,
 analysis_json,source,source_id,started_at,ended_at,start_local_date,end_local_date,timezone_name,timezone_provenance,
 measurement_provenance,received_at,content_revision,planned_workout_id,link_source,session_state,session_group_id,
 coalesce((select jsonb_agg(x.id order by x.id) from completed_activities x
  where x.user_id=completed_activities.user_id and x.duplicate_of=completed_activities.id),'[]'::jsonb) duplicate_candidate_ids
 from completed_activities where duplicate_of is null;
create view public.reconciled_plans with (security_invoker=true) as
 select p.*,case when p.skipped then 'skipped' when p.completed then 'completed_as_planned'
  when exists(select 1 from effective_activities a where a.planned_workout_id=p.id and a.link_source='athlete' and a.session_state='substituted') then 'substituted'
  when exists(select 1 from effective_activities a where a.planned_workout_id=p.id and a.link_source='athlete' and a.session_state='modified') then 'modified'
  when exists(select 1 from effective_activities a where a.planned_workout_id=p.id and a.link_source='athlete' and a.session_state='completed_as_planned') then 'completed_as_planned'
  else 'unknown' end reconciliation_status,
  coalesce((select jsonb_agg(a.id order by a.id) from effective_activities a where a.planned_workout_id=p.id),'[]'::jsonb) activity_ids
 from planned_workouts p;
grant select on effective_activities,reconciled_plans to authenticated,service_role;
revoke all on function public.reconcile_sessions(uuid), public.correct_session(uuid,uuid,text,text,uuid,uuid,bigint,uuid) from public;
grant execute on function public.reconcile_sessions(uuid) to service_role;
grant execute on function public.correct_session(uuid,uuid,text,text,uuid,uuid,bigint,uuid) to authenticated;

-- Retry pending calendar operations even if the request that queued them has
-- ended or the provider was temporarily unavailable.
create or replace function public.trigger_sync_calendar_outbox() returns void
language plpgsql security definer set search_path=public,extensions as $$
declare base_url text:=current_setting('app.functions_base_url',true); srk text:=current_setting('app.service_role_key',true);
begin
 if base_url is null or srk is null then return; end if;
 perform net.http_post(url:=base_url||'/sync-calendar',
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||srk),
  body:=jsonb_build_object('source','cron','all_users',true));
end $$;
select cron.schedule('sync-calendar-outbox-every-5m','*/5 * * * *',
 '$$ select public.trigger_sync_calendar_outbox(); $$')
where not exists(select 1 from cron.job where jobname='sync-calendar-outbox-every-5m');
