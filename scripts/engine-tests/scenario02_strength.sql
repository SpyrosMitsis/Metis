begin;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$
declare owner uuid:='11111111-1111-4111-8111-111111111111'; one uuid:=gen_random_uuid(); two uuid:=gen_random_uuid(); set_one uuid:=gen_random_uuid(); plan uuid;
begin
 select id into plan from planned_workouts where user_id=owner and session_slot=0 limit 1;
 perform sync_strength(owner,'Europe/Copenhagen',jsonb_build_array(
  jsonb_build_object('id',one,'name','Timed session','started_at',1792742400000,'ended_at',1792743600000,'duration_sec',1200,'total_volume_kg',0,'note','','planned_workout_id',plan,
   'sets',jsonb_build_array(jsonb_build_object('id',set_one,'exercise_name','Plank','muscle','Core','idx',1,'weight_kg',0,'reps',30,'quantity_unit','seconds','is_warmup',false))),
  jsonb_build_object('id',two,'name','Carry session','started_at',1792771200000,'ended_at',1792772400000,'duration_sec',1200,'total_volume_kg',0,'note','',
   'sets',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'exercise_name','Farmer''s Walk','muscle','Forearms','idx',1,'weight_kg',20,'reps',40,'quantity_unit','metres','is_warmup',false)))
 ),'[]','[]','[]');
 if (select count(distinct workout_id) from strength_logs where user_id=owner)<>2 then raise exception 'Date aggregation lost a strength session'; end if;
 if not exists(select 1 from strength_logs where workout_id=one and sets->0->>'quantity_unit'='seconds' and estimated_1rm is null) then raise exception 'Timed work became repetition/1RM data'; end if;
 if not exists(select 1 from strength_logs where workout_id=two and sets->0->>'quantity_unit'='metres' and estimated_1rm is null) then raise exception 'Carries became repetition/1RM data'; end if;
 insert into strength_session_analyses values(owner,one,plan,'{"fixture":1}'),(owner,two,null,'{"fixture":2}');
 update strength_workout_sets set reps=40 where id=set_one;
 if exists(select 1 from strength_session_analyses where workout_id=one) or not exists(select 1 from strength_session_analyses where workout_id=two) then raise exception 'Session cache invalidation used the wrong session'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$begin
 if exists(select 1 from strength_session_analyses) then raise exception 'Session analysis leaked across owners'; end if;
 if exists(select 1 from reconciled_session_plans) then raise exception 'Plan view leaked across owners'; end if;
end $$;
rollback;
