-- P2: athlete reports remain distinct from raw device observations.
alter table public.workout_feedback
 add column activity_id uuid references public.completed_activities(id) on delete set null,
 add column reason text not null default 'unknown' check(reason in ('time','fatigue','pain','illness','equipment','conditions','preference','other','unknown')),
 add column outcome text not null default 'unknown' check(outcome in ('as_planned','skipped','shortened','easier','harder','substituted','unknown')),
 add column actual_minutes numeric check(actual_minutes between 0 and 1440),
 add column if not exists pain_area text,
 add column soreness_area text check(length(soreness_area)<=100),
 add column enjoyment int check(enjoyment between 1 and 5),
 add column usefulness int check(usefulness between 1 and 5),
 add column unwanted_change boolean,
 add column is_retraction boolean not null default false;
create index feedback_latest_plan on public.workout_feedback(user_id,planned_workout_id,created_at desc);

create table public.training_holds(
 id uuid primary key references public.workout_feedback(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 reason text not null check(reason in ('pain','illness')), sport text, area text,
 start_date date not null, until_date date check(until_date>=start_date), active boolean not null default true,
 resolved_at timestamptz, created_at timestamptz not null default now()
);
alter table public.training_holds enable row level security;
create policy holds_owner on public.training_holds for select to authenticated using(user_id=auth.uid());
grant select on public.training_holds to authenticated;
revoke insert,update,delete on public.training_holds from authenticated;

create table public.athlete_versions(user_id uuid primary key references auth.users(id) on delete cascade, revision bigint not null default 0);
alter table public.athlete_versions enable row level security;
create policy athlete_version_owner on public.athlete_versions for select to authenticated using(user_id=auth.uid());
revoke insert,update,delete on public.athlete_versions from authenticated;
create function public.record_athlete_change() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare owner uuid;
begin
 if TG_TABLE_NAME='user_profiles' then
  if (to_jsonb(new)-array['updated_at','last_lat','last_lon','coach_knowledge','training_memory','coach_soul']) is not distinct from (to_jsonb(old)-array['updated_at','last_lat','last_lon','coach_knowledge','training_memory','coach_soul']) then return new; end if;
  owner:=new.id;
 elsif TG_OP='DELETE' then owner:=old.user_id; else owner:=new.user_id; end if;
 insert into athlete_versions values(owner,1) on conflict(user_id) do update set revision=athlete_versions.revision+1;
 return null;
end $$;
create trigger athlete_activity after insert or update or delete on public.completed_activities for each row execute function public.record_athlete_change();
create trigger athlete_feedback after insert or update or delete on public.workout_feedback for each row execute function public.record_athlete_change();
create trigger athlete_wellness after insert or update or delete on public.wellness_checkins for each row execute function public.record_athlete_change();
create trigger athlete_hold after insert or update or delete on public.training_holds for each row execute function public.record_athlete_change();
create trigger athlete_profile after update on public.user_profiles for each row execute function public.record_athlete_change();
create trigger athlete_sync after insert or update or delete on public.activity_sync_state for each row execute function public.record_athlete_change();
revoke all on function public.record_athlete_change() from public,anon,authenticated;

create or replace function public.save_workout_feedback(p_owner uuid,p_feedback jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare planned uuid:=(p_feedback->>'planned_workout_id')::uuid; aid uuid:=(p_feedback->>'activity_id')::uuid;
 fid uuid:=(p_feedback->>'id')::uuid; item planned_workouts; outcome text; prior workout_feedback;
begin
 perform engine_owner(p_owner);
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,47));
 select * into prior from workout_feedback where id=fid;
 if found then
  if prior.user_id<>p_owner then raise exception 'Feedback belongs to another account' using errcode='42501'; end if;
  -- An uncertain retry cannot overwrite the first committed report.
  if not (to_jsonb(prior) @> (p_feedback-array['id','user_id'])) then raise exception 'Feedback request ID reused with different input' using errcode='22023'; end if;
  return;
 end if;
 if planned is not null then
  select * into item from planned_workouts where id=planned and user_id=p_owner for update;
  if not found then raise exception 'Planned workout not found' using errcode='42501'; end if;
 end if;
 if aid is not null and not exists(select 1 from completed_activities where id=aid and user_id=p_owner) then raise exception 'Activity not found' using errcode='42501'; end if;
 outcome:=coalesce(p_feedback->>'outcome',case when (p_feedback->>'completed')::boolean then 'as_planned' else 'skipped' end);
 insert into workout_feedback(id,user_id,planned_workout_id,date,completed,actual_rpe,difficulty,notes,activity_id,reason,outcome,actual_minutes,pain_area,soreness_area,enjoyment,usefulness,unwanted_change)
 values(fid,p_owner,planned,(p_feedback->>'date')::date,(p_feedback->>'completed')::boolean,(p_feedback->>'actual_rpe')::int,p_feedback->>'difficulty',left(p_feedback->>'notes',2000),
 aid,coalesce(p_feedback->>'reason','unknown'),outcome,(p_feedback->>'actual_minutes')::numeric,left(p_feedback->>'pain_area',100),left(p_feedback->>'soreness_area',100),(p_feedback->>'enjoyment')::int,(p_feedback->>'usefulness')::int,(p_feedback->>'unwanted_change')::boolean);
 if planned is not null and outcome<>'unknown' then
  update planned_workouts set completed=outcome='as_planned',skipped=outcome='skipped' where id=planned;
 end if;
 if aid is not null and planned is not null and outcome<>'unknown' then
  update completed_activities set planned_workout_id=planned, link_source='athlete',
   session_state=case outcome when 'as_planned' then 'completed_as_planned' when 'substituted' then 'substituted' when 'skipped' then 'unknown' else 'modified' end
   where id=aid and user_id=p_owner;
 end if;
 if p_feedback->>'reason' in ('pain','illness') then
  insert into training_holds(id,user_id,reason,sport,area,start_date) values(fid,p_owner,p_feedback->>'reason',
   case when p_feedback->>'reason'='pain' then item.type else null end,p_feedback->>'pain_area',(p_feedback->>'date')::date);
 end if;
end $$;
grant execute on function public.save_workout_feedback(uuid,jsonb) to service_role;

create function public.resolve_training_hold(p_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null then raise exception 'unauthorized' using errcode='42501'; end if;
 update training_holds set active=false,resolved_at=now() where id=p_id and user_id=auth.uid();
 if not found then raise exception 'hold not found' using errcode='42501'; end if;
end $$;
revoke all on function public.resolve_training_hold(uuid) from public,anon;
grant execute on function public.resolve_training_hold(uuid) to authenticated;

create table public.adaptation_proposals(
 id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
 state text not null default 'preview' check(state in ('preview','applied','undone')),
 plan_revision bigint not null, athlete_revision bigint not null, apply_revision bigint,
 changes jsonb not null, explanation text not null, next_action text not null,
 uncertainties jsonb not null default '[]', alternatives jsonb not null default '[]', clarification text,
 policy_version text not null, provenance jsonb not null, created_at timestamptz not null default now(), applied_at timestamptz, undone_at timestamptz
);
alter table public.adaptation_proposals enable row level security;
create policy adaptation_owner on public.adaptation_proposals for select to authenticated using(user_id=auth.uid());
grant select on public.adaptation_proposals to authenticated;
revoke insert,update,delete on public.adaptation_proposals from authenticated;
create index adaptation_history on public.adaptation_proposals(user_id,created_at desc);

create function public.apply_adaptation(p_owner uuid,p_id uuid,p_undo boolean default false) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare proposal adaptation_proposals; change jsonb; item planned_workouts; rev bigint; workout jsonb;
begin
 perform engine_owner(p_owner);
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,47));
 select * into proposal from adaptation_proposals where id=p_id and user_id=p_owner for update;
 if not found then raise exception 'proposal not found' using errcode='42501'; end if;
 if (not p_undo and proposal.state='applied') or (p_undo and proposal.state='undone') then return to_jsonb(proposal); end if;
 if (not p_undo and proposal.state<>'preview') or (p_undo and proposal.state<>'applied') then raise exception 'invalid proposal state'; end if;
 if not p_undo and proposal.created_at<now()-interval '30 minutes' then raise exception 'preview expired; preview again' using errcode='40001'; end if;
 if not p_undo and not public.engine_release_allowed(proposal.policy_version,p_owner) then raise exception 'Adaptation is in preview-only rollout; applying is not enabled for this cohort' using errcode='55000'; end if;
 if jsonb_array_length(proposal.changes)=0 then raise exception 'No changes to apply' using errcode='22023'; end if;
 if proposal.clarification is not null then raise exception 'clarification required'; end if;
 select coalesce(revision,0) into rev from plan_versions where user_id=p_owner for update;
 if coalesce(rev,0)<>(case when p_undo then proposal.apply_revision else proposal.plan_revision end) then raise exception 'plan changed; preview again' using errcode='40001'; end if;
 if not p_undo and coalesce((select revision from athlete_versions where user_id=p_owner),0)<>proposal.athlete_revision then raise exception 'athlete observations changed; preview again' using errcode='40001'; end if;
 for change in select value from jsonb_array_elements(proposal.changes) loop
  select * into item from planned_workouts where id=(change->>'id')::uuid and user_id=p_owner for update;
  if not found or item.completed or item.skipped or item.locked or exists(select 1 from effective_activities where user_id=p_owner and planned_workout_id=item.id) then raise exception 'session is protected' using errcode='40001'; end if;
  if item.combined_group is not null and exists(select 1 from planned_workouts p where p.user_id=p_owner and p.combined_group=item.combined_group and not exists(select 1 from jsonb_array_elements(proposal.changes) c where c->>'id'=p.id::text)) then raise exception 'combined session must change together'; end if;
  workout:=change->(case when p_undo then 'before' else 'after' end);
  if workout->'prescription'->>'scheduled_date' is distinct from item.date::text or workout->>'type' not in ('run','ride','swim','strength','rest') then raise exception 'invalid candidate'; end if;
  if workout->>'type'<>'rest' and exists(select 1 from training_holds h where h.user_id=p_owner and h.active and h.start_date<=item.date and (h.until_date is null or h.until_date>=item.date) and (h.sport is null or h.sport=workout->>'type')) then raise exception 'active training hold'; end if;
 end loop;
 for change in select value from jsonb_array_elements(proposal.changes) loop
  workout:=change->(case when p_undo then 'before' else 'after' end);
  update planned_workouts set workout_json=workout,type=workout->>'type',transition_before_seconds=coalesce((change->>(case when p_undo then 'before_transition_seconds' else 'after_transition_seconds' end))::int,0) where id=(change->>'id')::uuid and user_id=p_owner;
 end loop;
 update adaptation_proposals set state=case when p_undo then 'undone' else 'applied' end,
  apply_revision=case when p_undo then apply_revision else coalesce((select revision from plan_versions where user_id=p_owner),0) end,
  applied_at=case when p_undo then applied_at else now() end,undone_at=case when p_undo then now() else null end where id=p_id returning * into proposal;
 return to_jsonb(proposal);
end $$;
revoke all on function public.apply_adaptation(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.apply_adaptation(uuid,uuid,boolean) to service_role;

-- Pseudonymous, owner-accessible observability. No raw health text or auth data.
create table public.engine_events(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check(kind in ('preview','apply','undo','rejected','correction','feedback','sync_failure')),sport text,policy_version text not null,properties jsonb not null default '{}',created_at timestamptz not null default now());
alter table public.engine_events enable row level security;
create policy event_owner on public.engine_events for select to authenticated using(user_id=auth.uid());
revoke insert,update,delete on public.engine_events from authenticated;
create index engine_events_window on public.engine_events(user_id,created_at desc);
-- Apply decisions retain minimal provenance for 180 days; metrics for 90 days.
create function public.prune_engine_observability() returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin delete from engine_events where created_at<now()-interval '90 days'; delete from adaptation_proposals where created_at<now()-interval '180 days'; end $$;
revoke all on function public.prune_engine_observability() from public,anon,authenticated;
grant execute on function public.prune_engine_observability() to service_role;
select cron.schedule('engine-retention','31 3 * * *','select public.prune_engine_observability()');

revoke insert,update,delete on public.workout_feedback from authenticated;
create function public.undo_session_feedback(p_plan uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare item planned_workouts; owner uuid:=auth.uid();
begin
 if owner is null then raise exception 'unauthorized' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,47));
 select * into item from planned_workouts where id=p_plan and user_id=owner for update;
 if not found then raise exception 'plan not found' using errcode='42501'; end if;
 update planned_workouts set completed=false,skipped=false where id=p_plan;
 update completed_activities set session_state='unknown' where user_id=owner and planned_workout_id=p_plan and link_source='athlete';
 insert into workout_feedback(user_id,planned_workout_id,date,completed,reason,outcome,is_retraction) values(owner,p_plan,item.date,false,'unknown','unknown',true);
end $$;
revoke all on function public.undo_session_feedback(uuid) from public,anon;
grant execute on function public.undo_session_feedback(uuid) to authenticated;

create function public.record_feedback_metric() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into engine_events(user_id,kind,policy_version,properties) values(new.user_id,'feedback','adaptation-1',jsonb_build_object('reason',new.reason,'outcome',new.outcome,'usefulness',new.usefulness,'unwanted_change',new.unwanted_change));
 return null;
end $$;
create trigger feedback_metric after insert on public.workout_feedback for each row execute function public.record_feedback_metric();
revoke all on function public.record_feedback_metric() from public,anon,authenticated;
create view public.engine_metric_summary with(security_invoker=true) as
 select user_id,kind,sport,policy_version,count(*) events,count(*) filter(where properties->>'unwanted_change'='true') unwanted_changes,
 avg((properties->>'usefulness')::numeric) filter(where properties ? 'usefulness') usefulness, date_trunc('day',created_at) as metric_day
 from public.engine_events group by user_id,kind,sport,policy_version,date_trunc('day',created_at);
grant select on public.engine_metric_summary to authenticated,service_role;
