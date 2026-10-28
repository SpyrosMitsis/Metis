begin;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$
declare owner uuid:='11111111-1111-4111-8111-111111111111'; item planned_workouts; rev bigint; request uuid:=gen_random_uuid(); result jsonb; moved jsonb;
begin
 select * into item from planned_workouts where user_id=owner and session_slot=1 limit 1;
 rev:=plan_revision(owner);
 moved:=jsonb_set(item.workout_json,'{prescription}', '{"scheduled_date":"2026-10-24"}');
 result:=move_planned_session(owner,item.id,rev,'2026-10-24',1,1080,moved,request,'{"test":"move"}');
 if result->'row'->>'id'<>item.id::text or result->'row'->>'session_slot'<>'1' then raise exception 'Move lost session identity or slot'; end if;
 if not exists(select 1 from planned_workouts where id=item.id and date='2026-10-24') then raise exception 'Move did not persist'; end if;
 if move_planned_session(owner,item.id,0,'2026-10-24',1,1080,moved,request,'{"test":"move"}') <> result then raise exception 'Move retry was not idempotent'; end if;
 begin
  perform move_planned_session(owner,item.id,rev,'2026-10-25',1,1080,moved,gen_random_uuid(),'{}');
  raise exception 'Stale move accepted';
 exception when serialization_failure then null; end;
 begin
  perform move_planned_session(owner,item.id,plan_revision(owner),'2026-10-23',0,420,jsonb_set(moved,'{prescription,scheduled_date}','"2026-10-23"'),gen_random_uuid(),'{}');
  raise exception 'Occupied destination accepted';
 exception when serialization_failure then null; end;
 if not exists(select 1 from calendar_outbox where planned_id=item.id and operation='upsert' and payload->>'date'='2026-10-24') then raise exception 'Moved calendar event was not queued'; end if;
end $$;
rollback;
