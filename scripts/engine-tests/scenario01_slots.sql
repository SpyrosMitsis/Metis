begin;
insert into auth.users(id,email) values ('11111111-1111-4111-8111-111111111111','engine-test@example.invalid');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$
declare owner uuid:='11111111-1111-4111-8111-111111111111'; request uuid:=gen_random_uuid(); result jsonb; replay jsonb; rev bigint; primary_id uuid;
 first jsonb:='{"type":"run","title":"Easy run","duration_minutes":20,"sections":[],"rpe_target":3,"tss_estimate":10,"coach_note":"fixture"}';
 second jsonb:='{"type":"ride","title":"Easy ride","duration_minutes":30,"sections":[],"rpe_target":3,"tss_estimate":15,"coach_note":"fixture"}';
begin
 rev:=plan_revision(owner);
 result:=replace_generated_plan(owner,request,'{"scenario":"slots"}',rev,'2026-10-23','2026-10-23',jsonb_build_array(jsonb_build_object('date','2026-10-23','type','run','workout_json',first,'session_slot',0,'start_minute',420,'sync_requested',true)));
 replay:=replace_generated_plan(owner,request,'{"scenario":"slots"}',999,'2026-10-23','2026-10-23','[]');
 if result<>replay or (select count(*) from planned_workouts where user_id=owner)<>1 then raise exception 'Idempotency failure'; end if;
 select id into primary_id from planned_workouts where user_id=owner and session_slot=0;
 update planned_workouts set locked=true where id=primary_id;
 rev:=plan_revision(owner);
 perform replace_generated_plan(owner,gen_random_uuid(),'{}',rev,'2026-10-23','2026-10-23',jsonb_build_array(jsonb_build_object('date','2026-10-23','type','ride','workout_json',second,'session_slot',1,'start_minute',1080,'sync_requested',true)),null,'{}',false);
 if (select count(*) from reconciled_session_plans where user_id=owner)<>2 then raise exception 'Secondary slot not preserved'; end if;
 if not exists(select 1 from planned_workouts where id=primary_id and locked) then raise exception 'Protected slot changed'; end if;
 begin
  perform replace_generated_plan(owner,gen_random_uuid(),'{}',plan_revision(owner),'2026-10-23','2026-10-23',jsonb_build_array(jsonb_build_object('date','2026-10-23','type','run','workout_json',first,'session_slot',0)));
  raise exception 'Expected protection failure';
 exception when serialization_failure then null; end;
 begin
  perform replace_generated_plan(owner,gen_random_uuid(),'{}',rev,'2026-10-23','2026-10-23',jsonb_build_array(jsonb_build_object('date','2026-10-23','type','ride','workout_json',second,'session_slot',1)));
  raise exception 'Expected revision conflict';
 exception when serialization_failure then null; end;
 begin
  perform replace_generated_plan(owner,gen_random_uuid(),'{}',plan_revision(owner),'2026-10-23','2026-10-24',jsonb_build_array(jsonb_build_object('date','2026-10-23','type','ride','workout_json',second,'session_slot',1),jsonb_build_object('date','2026-10-24','type','invalid','workout_json',first,'session_slot',0)));
  raise exception 'Expected whole-plan validation failure';
 exception when invalid_parameter_value then null; end;
 if (select count(*) from planned_workouts where user_id=owner)<>2 then raise exception 'Failed generation erased a slot'; end if;
 if (select count(distinct planned_id) from calendar_outbox where user_id=owner)<>2 then raise exception 'Outbox did not keep independent session identities'; end if;
end $$;
commit;
