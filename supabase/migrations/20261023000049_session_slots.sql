-- Explicit slots preserve IDs and allow independently reconciled double sessions.
alter table public.planned_workouts add column session_slot smallint not null default 0 check(session_slot between 0 and 1);
alter table public.planned_workouts add column start_minute smallint check(start_minute between 0 and 1439);
alter table public.planned_workouts add column combined_group text;
alter table public.planned_workouts add column transition_before_seconds int not null default 0 check(transition_before_seconds between 0 and 1800);
drop index if exists public.planned_workouts_one_open_ai_plan;
create unique index planned_workouts_one_open_ai_plan on public.planned_workouts(user_id,date,session_slot)
 where not completed and not locked and llm_provider is not null and llm_provider<>'template';
-- Keep the old view contract available for old clients; append the new fields.
create view public.reconciled_session_plans with (security_invoker=true) as
 select r.*,p.session_slot,p.start_minute,p.combined_group,p.transition_before_seconds from public.reconciled_plans r join public.planned_workouts p on p.id=r.id;
grant select on public.reconciled_session_plans to authenticated, service_role;

create or replace function public.replace_generated_plan(p_owner uuid,p_request uuid,p_scope jsonb,
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
   or x->>'type' not in ('run','ride','swim','strength','rest') or x->>'type' is null or coalesce((x->>'session_slot')::int,0) not between 0 and 1
   or jsonb_typeof(x->'workout_json') is distinct from 'object'
   or x->'workout_json'->>'type' is distinct from x->>'type'
   or jsonb_typeof(x->'workout_json'->'sections') is distinct from 'array' then
   raise exception 'invalid session' using errcode='22023';
  end if;
  if exists(select 1 from planned_workouts where user_id=p_owner and date=(x->>'date')::date and session_slot=coalesce((x->>'session_slot')::int,0)
    and (completed or skipped or locked or not p_replace)) then
   raise exception 'protected session on requested date' using errcode='40001';
  end if;
 end loop;
 if (select count(*)<>count(distinct (value->>'date',coalesce((value->>'session_slot')::int,0))) from jsonb_array_elements(p_rows)) then
  raise exception 'duplicate plan dates' using errcode='22023';
 end if;
 -- Only replace requested dates. Protected and unmentioned days are immutable.
 if p_replace then
  delete from planned_workouts where user_id=p_owner and not completed and not skipped and not locked
   and (date,session_slot) in (select (value->>'date')::date,coalesce((value->>'session_slot')::int,0) from jsonb_array_elements(p_rows));
 end if;
 for x in select value from jsonb_array_elements(p_rows) loop
  insert into planned_workouts(user_id,date,type,workout_json,llm_provider,llm_model,locked,
    sync_requested,engine_version,generation_request_id,session_slot,start_minute,combined_group,transition_before_seconds)
   values(p_owner,(x->>'date')::date,x->>'type',x->'workout_json',x->>'llm_provider',x->>'llm_model',
    coalesce((x->>'locked')::boolean,false),coalesce((x->>'sync_requested')::boolean,false),
    coalesce(p_metadata->>'engine_version','engine-2026-10-22.1'),p_request,coalesce((x->>'session_slot')::int,0),(x->>'start_minute')::int,x->>'combined_group',coalesce((x->>'transition_before_seconds')::int,0)) returning * into row;
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


create or replace function public.record_plan_change() returns trigger
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
    case when TG_OP='DELETE' or r.skipped or (r.type='rest' and coalesce((r.workout_json->>'duration_minutes')::numeric,0)=0) then 'delete' else 'upsert' end,to_jsonb(r));
 end if;
 return r;
end $$;
