-- Android sync boundaries: every replacement and its coaching feed commit together.
-- SECURITY INVOKER retains table RLS. Owner is mandatory to reject stale sessions.
alter table public.strength_workout_sets add column if not exists note text default '';

create or replace function public.sync_strength(p_owner uuid, p_zone text, p_workouts jsonb,
  p_routines jsonb, p_custom jsonb, p_deletes jsonb) returns void
language plpgsql security invoker set search_path = public, pg_temp as $$
declare x jsonb; wid uuid; rid uuid; old_date date; new_date date; dates date[] := '{}';
begin
  if auth.uid() is null or auth.uid() <> p_owner then raise exception 'Account changed'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text, 0));
  -- Validate timezone before any writes.
  perform now() at time zone p_zone;
  for x in select value from jsonb_array_elements(p_workouts) loop
    wid := (x->>'id')::uuid;
    select (to_timestamp(started_at / 1000.0) at time zone p_zone)::date into old_date
      from strength_workouts where id = wid and user_id = p_owner;
    new_date := (to_timestamp((x->>'started_at')::bigint / 1000.0) at time zone p_zone)::date;
    dates := array_append(array_append(dates, old_date), new_date);
    insert into strength_workouts(id,user_id,name,started_at,ended_at,duration_sec,total_volume_kg,note)
      values(wid,p_owner,x->>'name',(x->>'started_at')::bigint,(x->>'ended_at')::bigint,
        (x->>'duration_sec')::int,(x->>'total_volume_kg')::float8,x->>'note')
      on conflict(id) do update set name=excluded.name,started_at=excluded.started_at,
        ended_at=excluded.ended_at,duration_sec=excluded.duration_sec,
        total_volume_kg=excluded.total_volume_kg,note=excluded.note;
    delete from strength_workout_sets where workout_id=wid and user_id=p_owner;
    insert into strength_workout_sets(id,user_id,workout_id,exercise_name,muscle,idx,weight_kg,reps,rpe,is_warmup,note)
      select s.id,p_owner,wid,s.exercise_name,s.muscle,s.idx,s.weight_kg,s.reps,s.rpe,s.is_warmup,s.note
      from jsonb_to_recordset(x->'sets') as s(id uuid,exercise_name text,muscle text,idx int,
        weight_kg float8,reps int,rpe int,is_warmup boolean,note text);
  end loop;
  for x in select value from jsonb_array_elements(p_routines) loop
    rid := (x->>'id')::uuid;
    insert into strength_routines(id,user_id,name,created_at)
      values(rid,p_owner,x->>'name',(x->>'created_at')::bigint)
      on conflict(id) do update set name=excluded.name,created_at=excluded.created_at;
    delete from strength_routine_items where routine_id=rid and user_id=p_owner;
    insert into strength_routine_items(id,user_id,routine_id,exercise_name,position,target_sets,target_reps,rest_sec)
      select i.id,p_owner,rid,i.exercise_name,i.position,i.target_sets,i.target_reps,i.rest_sec
      from jsonb_to_recordset(x->'items') as i(id uuid,exercise_name text,position int,target_sets int,target_reps text,rest_sec int);
  end loop;
  for x in select value from jsonb_array_elements(p_custom) loop
    insert into strength_custom_exercises(user_id,name,muscle,category,compound)
      values(p_owner,x->>'name',x->>'muscle',x->>'category',(x->>'compound')::boolean)
      on conflict(user_id,name) do update set muscle=excluded.muscle,category=excluded.category,compound=excluded.compound;
  end loop;
  for x in select value from jsonb_array_elements(p_deletes) loop
    case x->>'tbl'
      when 'workout' then
        wid := (x->>'rowId')::uuid;
        select (to_timestamp(started_at / 1000.0) at time zone p_zone)::date into old_date
          from strength_workouts where id=wid and user_id=p_owner;
        dates := array_append(dates,old_date);
        delete from strength_workouts where id=wid and user_id=p_owner;
      when 'routine' then delete from strength_routines where id=(x->>'rowId')::uuid and user_id=p_owner;
      when 'custom' then delete from strength_custom_exercises where name=x->>'rowId' and user_id=p_owner;
      else raise exception 'Unknown tombstone type';
    end case;
  end loop;
  -- Same per-day feed as the original Android sync, but derived from complete
  -- server truth (including other devices) and committed with source changes.
  delete from strength_logs where user_id=p_owner and date=any(dates);
  insert into strength_logs(user_id,date,exercise_name,muscle_groups,sets,estimated_1rm)
    select p_owner,(to_timestamp(w.started_at/1000.0) at time zone p_zone)::date,
      s.exercise_name,array_agg(distinct s.muscle),
      jsonb_agg(jsonb_build_object('reps',s.reps,'weight_kg',s.weight_kg,'rpe',s.rpe) order by s.idx,s.id),
      max(case when s.reps <= 1 then s.weight_kg else s.weight_kg*(1+s.reps/30.0) end)
    from strength_workouts w join strength_workout_sets s on s.workout_id=w.id and s.user_id=p_owner
    where w.user_id=p_owner and not coalesce(s.is_warmup,false) and s.reps>0
      and (to_timestamp(w.started_at/1000.0) at time zone p_zone)::date=any(dates)
    group by w.id,(to_timestamp(w.started_at/1000.0) at time zone p_zone)::date,s.exercise_name;
end $$;

-- One SQL statement gives a coherent snapshot; JSON aggregation avoids the
-- PostgREST row cap on parent AND child tables without inconsistent page reads.
create or replace function public.strength_snapshot(p_owner uuid) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_owner then raise exception 'Account changed'; end if;
  return jsonb_build_object(
    'workouts',coalesce((select jsonb_agg(to_jsonb(w)) from strength_workouts w where user_id=p_owner),'[]'::jsonb),
    'sets',coalesce((select jsonb_agg(to_jsonb(s)) from strength_workout_sets s where user_id=p_owner),'[]'::jsonb),
    'routines',coalesce((select jsonb_agg(to_jsonb(r)) from strength_routines r where user_id=p_owner),'[]'::jsonb),
    'items',coalesce((select jsonb_agg(to_jsonb(i)) from strength_routine_items i where user_id=p_owner),'[]'::jsonb),
    'custom',coalesce((select jsonb_agg(to_jsonb(c)) from strength_custom_exercises c where user_id=p_owner),'[]'::jsonb));
end $$;

create or replace function public.save_workout_feedback(p_owner uuid,p_feedback jsonb) returns void
language plpgsql security invoker set search_path = public, pg_temp as $$
declare planned uuid := (p_feedback->>'planned_workout_id')::uuid;
begin
  if auth.uid() is null or auth.uid() <> p_owner then raise exception 'Account changed'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text, 0));
  if planned is not null then
    update planned_workouts set completed=(p_feedback->>'completed')::boolean,
      skipped=not (p_feedback->>'completed')::boolean where id=planned and user_id=p_owner;
    if not found then raise exception 'Planned workout not found'; end if;
    delete from workout_feedback where planned_workout_id=planned and user_id=p_owner;
  end if;
  insert into workout_feedback(id,user_id,planned_workout_id,date,completed,actual_rpe,difficulty,notes)
    values((p_feedback->>'id')::uuid,p_owner,planned,(p_feedback->>'date')::date,
      (p_feedback->>'completed')::boolean,(p_feedback->>'actual_rpe')::int,
      p_feedback->>'difficulty',p_feedback->>'notes')
    on conflict(id) do update set completed=excluded.completed,actual_rpe=excluded.actual_rpe,
      difficulty=excluded.difficulty,notes=excluded.notes;
end $$;
revoke all on function public.sync_strength(uuid,text,jsonb,jsonb,jsonb,jsonb) from public,anon;
revoke all on function public.strength_snapshot(uuid) from public,anon;
revoke all on function public.save_workout_feedback(uuid,jsonb) from public,anon;
grant execute on function public.sync_strength(uuid,text,jsonb,jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.strength_snapshot(uuid) to authenticated;
grant execute on function public.save_workout_feedback(uuid,jsonb) to authenticated;
