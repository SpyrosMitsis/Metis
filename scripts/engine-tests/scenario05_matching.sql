begin;
insert into auth.users(id,email) values('55555555-5555-4555-8555-555555555555','matching-fixture@example.invalid');
select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',true);
select set_config('request.jwt.claim.role','authenticated',true);
create temporary table labeled_matches(activity uuid,expected uuid,sport text);
do $$
declare owner uuid:='55555555-5555-4555-8555-555555555555'; p1 uuid:=gen_random_uuid();p2 uuid:=gen_random_uuid();p3 uuid:=gen_random_uuid();p4 uuid:=gen_random_uuid();a uuid;item record;
begin
 insert into planned_workouts(id,user_id,date,type,workout_json,session_slot) values
 (p1,owner,'2026-10-26','run','{"type":"run","sections":[]}',0),
 (p2,owner,'2026-10-27','swim','{"type":"swim","sections":[]}',0),
 (p3,owner,'2026-10-28','strength','{"type":"strength","sections":[]}',0),
 (p4,owner,'2026-10-29','ride','{"type":"ride","sections":[]}',0);
 insert into completed_activities(user_id,intervals_id,date,type) values(owner,'fixture-walk','2026-10-26','Walk') returning id into a;
 insert into labeled_matches values(a,null,'run');
 insert into completed_activities(user_id,intervals_id,date,type) values(owner,'fixture-swim','2026-10-27','Swim') returning id into a;
 insert into labeled_matches values(a,p2,'swim');
 insert into completed_activities(user_id,intervals_id,date,type) values(owner,'fixture-generic','2026-10-28','Workout') returning id into a;
 insert into labeled_matches values(a,null,'strength');
 insert into completed_activities(user_id,intervals_id,date,type) values(owner,'fixture-ride','2026-10-29','VirtualRide') returning id into a;
 insert into labeled_matches values(a,p4,'ride');
 -- Late arrival changes a possible one-to-one match into ambiguity.
 insert into planned_workouts(user_id,date,type,workout_json,session_slot) values(owner,'2026-10-29','ride','{"type":"ride","sections":[]}',1);
 update labeled_matches set expected=null where sport='ride';
 perform reconcile_sessions(owner);
 for item in select l.*,a.planned_workout_id,a.session_state from labeled_matches l join completed_activities a on a.id=l.activity loop
  if item.planned_workout_id is distinct from item.expected then raise exception 'Labeled matching failure for %',item.sport;end if;
  if item.session_state='completed_as_planned' then raise exception 'False completion from inferred match';end if;
 end loop;
 if exists(select 1 from planned_workouts where user_id=owner and completed) then raise exception 'Import marked a workout complete';end if;
end $$;
select sport,count(*) labeled_records,count(*) filter(where expected is null) expected_abstentions from labeled_matches group by sport order by sport;
rollback;
