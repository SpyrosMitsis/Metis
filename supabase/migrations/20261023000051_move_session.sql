-- Preserve the workout ID, linked execution and calendar event on a move.
create or replace function public.move_planned_session(p_owner uuid,p_id uuid,p_revision bigint,p_date date,p_slot int,p_start int,p_workout jsonb,p_request uuid,p_scope jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare item planned_workouts; rev bigint; prior plan_requests; result jsonb;
begin
 perform engine_owner(p_owner);
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,47));
 select * into prior from plan_requests where user_id=p_owner and request_id=p_request;
 if found then
  if prior.request_scope is distinct from p_scope then raise exception 'request key reused for different input' using errcode='22023'; end if;
  return prior.result;
 end if;
 select revision into rev from plan_versions where user_id=p_owner for update;
 if rev is distinct from p_revision then raise exception 'plan changed; refresh before moving' using errcode='40001'; end if;
 select * into item from planned_workouts where id=p_id and user_id=p_owner for update;
 if not found then raise exception 'session not found' using errcode='22023'; end if;
 if item.completed or item.skipped or item.combined_group is not null then raise exception 'completed, skipped or combined sessions cannot be moved individually' using errcode='22023'; end if;
 if p_date is null or p_slot not between 0 and 1 or p_slot is null or p_start not between 0 and 1439
   or p_workout->>'type' is distinct from item.type or jsonb_typeof(p_workout->'sections') is distinct from 'array'
   or p_workout->'prescription'->>'scheduled_date' is distinct from p_date::text then raise exception 'invalid moved session' using errcode='22023'; end if;
 if exists(select 1 from planned_workouts where user_id=p_owner and date=p_date and session_slot=p_slot and id<>p_id) then raise exception 'destination slot occupied' using errcode='40001'; end if;
 update planned_workouts set date=p_date,session_slot=p_slot,start_minute=p_start,workout_json=p_workout where id=p_id returning * into item;
 result:=jsonb_build_object('row',to_jsonb(item),'revision',(select revision from plan_versions where user_id=p_owner));
 insert into plan_requests values(p_owner,p_request,p_scope,result,now());
 return result;
end $$;
revoke all on function public.move_planned_session(uuid,uuid,bigint,date,int,int,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.move_planned_session(uuid,uuid,bigint,date,int,int,jsonb,uuid,jsonb) to service_role;
