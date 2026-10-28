create table public.engine_releases(
 policy_version text primary key, mode text not null check(mode in ('disabled','shadow','canary','enabled')),
 rollout_percent int not null check(rollout_percent between 0 and 100),
 regression_passed boolean not null default false, expert_reviewed boolean not null default false, device_validated boolean not null default false,
 evidence jsonb not null default '{}', updated_at timestamptz not null default now(),
 check(mode not in ('canary','enabled') or (regression_passed and expert_reviewed and device_validated and evidence ? 'regression' and evidence ? 'expert' and evidence ? 'device'))
);
alter table public.engine_releases enable row level security;
create policy release_read on public.engine_releases for select to authenticated using(true);
revoke insert,update,delete on public.engine_releases from authenticated;
insert into public.engine_releases(policy_version,mode,rollout_percent) values('adaptation-1','shadow',0);
create function public.engine_release_allowed(p_policy text,p_owner uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce((select r.mode='enabled' or (r.mode='canary' and (('x'||substr(md5(p_owner::text||':'||p_policy),1,7))::bit(28)::bigint % 100)<r.rollout_percent) from engine_releases r where r.policy_version=p_policy),false)
$$;
revoke all on function public.engine_release_allowed(text,uuid) from public,anon,authenticated;
grant execute on function public.engine_release_allowed(text,uuid) to service_role;
-- Minimal revisioned audit for operator-controlled rollouts and rollback.
create table public.engine_release_history(id bigint generated always as identity primary key,policy_version text not null,before_state jsonb,after_state jsonb,changed_at timestamptz not null default now());
alter table public.engine_release_history enable row level security;
revoke all on public.engine_release_history from authenticated;
create function public.audit_engine_release() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin insert into engine_release_history(policy_version,before_state,after_state) values(new.policy_version,to_jsonb(old),to_jsonb(new));return null;end $$;
create trigger release_audit after update on public.engine_releases for each row execute function public.audit_engine_release();
revoke all on function public.audit_engine_release() from public,anon,authenticated;

alter table public.engine_events drop constraint engine_events_kind_check;
alter table public.engine_events add constraint engine_events_kind_check check(kind in ('preview','apply','undo','rejected','correction','feedback','sync_failure','observation'));
create function public.record_observation_metric() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if TG_OP='INSERT' then
  insert into engine_events(user_id,kind,sport,policy_version,properties) values(new.user_id,'observation',activity_sport(new.type),'adaptation-1',jsonb_build_object('source',new.source));
 elsif new.link_source='athlete' and ((coalesce(new.corrected_type,new.type),new.planned_workout_id,new.duplicate_of) is distinct from (coalesce(old.corrected_type,old.type),old.planned_workout_id,old.duplicate_of) or old.link_source='athlete' and new.session_state is distinct from old.session_state) then
  insert into engine_events(user_id,kind,sport,policy_version,properties) values(new.user_id,'correction',activity_sport(coalesce(new.corrected_type,new.type)),'adaptation-1',jsonb_build_object('state',new.session_state,'type_changed',coalesce(new.corrected_type,new.type) is distinct from coalesce(old.corrected_type,old.type),'link_changed',new.planned_workout_id is distinct from old.planned_workout_id,'duplicate_changed',new.duplicate_of is distinct from old.duplicate_of));
 end if;
 return null;
end $$;
create trigger observation_metric after insert or update on public.completed_activities for each row execute function public.record_observation_metric();
revoke all on function public.record_observation_metric() from public,anon,authenticated;
-- Every structured input that can invalidate a dose participates in freshness.
create trigger athlete_race after insert or update or delete on public.races for each row execute function public.record_athlete_change();
create trigger athlete_threshold after insert or update or delete on public.threshold_tests for each row execute function public.record_athlete_change();
create trigger athlete_strength after insert or update or delete on public.strength_workout_sets for each row execute function public.record_athlete_change();
create trigger athlete_strength_feed after insert or update or delete on public.strength_logs for each row execute function public.record_athlete_change();

grant all on public.training_holds,public.athlete_versions,public.adaptation_proposals,public.engine_events,public.engine_releases,public.engine_release_history to service_role;
