set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
set request.jwt.claim.role='authenticated';
select plan_revision(auth.uid());
select replace_generated_plan(auth.uid(),'11111111-1111-1111-1111-111111111111','{"test":1}',0,'2026-10-22','2026-10-22',
 '[{"date":"2026-10-22","type":"run","sync_requested":true,"workout_json":{"type":"run","sections":[]}}]');
do $$ declare r bigint; original uuid; begin
 select revision into r from plan_versions where user_id=auth.uid();
 select id into original from planned_workouts where user_id=auth.uid();
 -- Retry returns the original identity, even with the old revision.
 perform replace_generated_plan(auth.uid(),'11111111-1111-1111-1111-111111111111','{"test":1}',0,'2026-10-22','2026-10-22','[]');
 if (select count(*) from planned_workouts where user_id=auth.uid())<>1 then raise exception 'duplicate retry'; end if;
 begin
  perform replace_generated_plan(auth.uid(),'22222222-2222-2222-2222-222222222222','{}',0,'2026-10-22','2026-10-22','[]');
  raise exception 'conflict accepted';
 exception when serialization_failure then null; end;
 begin
  perform replace_generated_plan(auth.uid(),'33333333-3333-3333-3333-333333333333','{}',r,'2026-10-22','2026-10-22',
   '[{"date":"2026-10-22","type":"nonsense","workout_json":{}}]');
  raise exception 'bad plan accepted';
 exception when invalid_parameter_value then null; end;
 if not exists(select 1 from planned_workouts where id=original) then raise exception 'old plan lost'; end if;
end $$;
insert into completed_activities(user_id,intervals_id,type,date,duration_seconds)
 values(auth.uid(),'test-run','Run','2026-10-22',1800);
do $$ declare a completed_activities; begin
 select * into a from completed_activities where intervals_id='test-run';
 if a.planned_workout_id is null or a.link_source<>'inferred' or a.session_state<>'unknown' then raise exception 'inference failed'; end if;
 if (select completed from planned_workouts where id=a.planned_workout_id) then raise exception 'inference asserted completion'; end if;
 perform correct_session(a.id,a.planned_workout_id,'modified',null,null,null,a.content_revision);
end $$;
-- A resync must not erase the athlete's correction.
update completed_activities set duration_seconds=1500 where intervals_id='test-run';
do $$ begin
 if not exists(select 1 from effective_activities where intervals_id='test-run' and session_state='modified' and link_source='athlete') then raise exception 'correction lost'; end if;
end $$;
-- Double-session ambiguity never auto-links both records to one plan.
insert into planned_workouts(user_id,date,type,workout_json) values(auth.uid(),'2026-10-23','run','{"type":"run","sections":[]}');
insert into completed_activities(user_id,intervals_id,type,date) values(auth.uid(),'double1','Run','2026-10-23'),(auth.uid(),'double2','Run','2026-10-23');
do $$ begin
 if exists(select 1 from completed_activities where intervals_id like 'double%' and planned_workout_id is not null) then raise exception 'ambiguous pair matched'; end if;
end $$;
-- Claim lease prevents concurrent delivery, stale acknowledgements do nothing.
do $$ declare j jsonb; begin
 j:=claim_calendar_job(auth.uid());
 if j is null then raise exception 'no queued job'; end if;
 if claim_calendar_job(auth.uid()) is not null then raise exception 'double claim'; end if;
 perform finish_calendar_job(auth.uid(),(j->>'id')::bigint,gen_random_uuid());
 if exists(select 1 from calendar_outbox where id=(j->>'id')::bigint and finished_at is not null) then raise exception 'stale ack'; end if;
 perform finish_calendar_job(auth.uid(),(j->>'id')::bigint,(j->>'lease_token')::uuid);
end $$;
select 'engine reliability regressions passed' as result;
