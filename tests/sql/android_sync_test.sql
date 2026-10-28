\set ON_ERROR_STOP on
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
do $$
declare
 owner uuid := auth.uid();
 wid uuid := '10000000-0000-0000-0000-000000000001';
 sid uuid := '20000000-0000-0000-0000-000000000001';
 rid uuid := '30000000-0000-0000-0000-000000000001';
 pid uuid := '40000000-0000-0000-0000-000000000001';
 fid uuid := '50000000-0000-0000-0000-000000000001';
 w jsonb; r jsonb; fb jsonb; snapshot jsonb; rejected boolean;
begin
 w := jsonb_build_object('id',wid,'name','Session','started_at',1792540800000,'ended_at',1792544400000,
   'duration_sec',3600,'total_volume_kg',100,'note','workout note','sets',jsonb_build_array(
   jsonb_build_object('id',sid,'exercise_name','Squat','muscle','Quads','idx',1,'weight_kg',20,'reps',5,'rpe',7,'is_warmup',false,'note','set note')));
 r := jsonb_build_object('id',rid,'name','Routine','created_at',1,'items',jsonb_build_array(
   jsonb_build_object('id',gen_random_uuid(),'exercise_name','Squat','position',0,'target_sets',3,'target_reps','5','rest_sec',120)));
 perform sync_strength(owner,'Europe/Copenhagen',jsonb_build_array(w),jsonb_build_array(r),'[]','[]');
 assert (select count(*)=1 from strength_logs), 'coaching feed missing';
 assert (select note='set note' from strength_workout_sets where id=sid), 'notes not saved';
 -- Retry the same operation: parent, children and aggregates stay unique.
 perform sync_strength(owner,'Europe/Copenhagen',jsonb_build_array(w),jsonb_build_array(r),'[]','[]');
 assert (select count(*)=1 from strength_workout_sets), 'retry duplicated sets';
 assert (select count(*)=1 from strength_logs), 'retry duplicated feed';
 -- Removing all routine children must be reflected remotely.
 perform sync_strength(owner,'Europe/Copenhagen','[]',jsonb_build_array(r || '{"items":[]}'),'[]','[]');
 assert (select count(*)=0 from strength_routine_items), 'empty routine kept old items';
 -- A failure AFTER replacement starts rolls back the parent, child delete and feed.
 rejected := false;
 begin
   perform sync_strength(owner,'Europe/Copenhagen',jsonb_build_array(w || jsonb_build_object('name','bad','sets',jsonb_build_array(jsonb_build_object('id','not-a-uuid')))),'[]','[]','[]');
 exception when invalid_text_representation then rejected := true;
 end;
 assert rejected, 'malformed child accepted';
 assert (select name='Session' from strength_workouts where id=wid), 'parent did not roll back';
 assert (select count(*)=1 from strength_workout_sets), 'children did not roll back';
 assert (select count(*)=1 from strength_logs), 'aggregate did not roll back';
 -- Deletion resolves the original date from cloud state and clears stale totals.
 perform sync_strength(owner,'Europe/Copenhagen','[]','[]','[]',jsonb_build_array(jsonb_build_object('tbl','workout','rowId',wid)));
 assert (select count(*)=0 from strength_logs), 'deleted session still contributes volume';
 assert (select count(*)=0 from strength_workout_sets), 'orphaned sets';
 -- More than the former parent and PostgREST child limits.
 insert into strength_workouts(id,user_id,name,started_at) select gen_random_uuid(),owner,'history',n from generate_series(1,1100) n;
 insert into strength_workout_sets(id,user_id,workout_id,note) select gen_random_uuid(),owner,id,'retained' from strength_workouts;
 snapshot := strength_snapshot(owner);
 assert jsonb_array_length(snapshot->'workouts')=1100, 'parent cap';
 assert jsonb_array_length(snapshot->'sets')=1100, 'child cap';
 insert into planned_workouts(id,user_id,date,type,workout_json) values(pid,owner,current_date,'strength','{}');
 fb := jsonb_build_object('id',fid,'planned_workout_id',pid,'date',current_date,'completed',true,'actual_rpe',7,'difficulty','just_right','notes','feedback');
 perform save_workout_feedback(owner,fb);
 perform save_workout_feedback(owner,fb);
 assert (select count(*)=1 from workout_feedback), 'planned retry duplicated feedback';
 assert (select completed from planned_workouts where id=pid), 'completion missing';
 rejected := false;
 begin
   perform save_workout_feedback(owner,fb || '{"completed":false,"actual_rpe":99}');
 exception when check_violation then rejected := true;
 end;
 assert rejected, 'invalid feedback accepted';
 assert (select completed from planned_workouts where id=pid), 'completion did not roll back';
 assert (select actual_rpe=7 from workout_feedback where id=fid), 'feedback did not roll back';
 fb := fb || jsonb_build_object('id',gen_random_uuid(),'planned_workout_id',null);
 perform save_workout_feedback(owner,fb);
 perform save_workout_feedback(owner,fb);
 assert (select count(*)=2 from workout_feedback), 'unplanned retry duplicated feedback';
 -- Changing auth cannot redirect an old payload into the next account.
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
 assert jsonb_array_length(strength_snapshot(auth.uid())->'workouts')=0, 'RLS leaked account one';
 rejected := false;
 begin perform sync_strength(owner,'UTC','[]','[]','[]','[]');
 exception when raise_exception then rejected := true; end;
 assert rejected, 'owner mismatch accepted';
 rejected := false;
 begin perform save_workout_feedback(auth.uid(),fb || jsonb_build_object('planned_workout_id',pid));
 exception when raise_exception then rejected := true; end;
 assert rejected, 'foreign planned workout accepted';
end $$;
rollback;
