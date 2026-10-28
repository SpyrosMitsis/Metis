-- Explicit strength quantities and session-scoped analysis, preserving legacy rows.
alter table public.strength_workout_sets add column quantity_unit text not null default 'reps' check(quantity_unit in ('reps','seconds','metres','minutes'));
alter table public.strength_workouts add column planned_workout_id uuid references public.planned_workouts(id) on delete set null;
alter table public.strength_logs add column workout_id uuid references public.strength_workouts(id) on delete cascade;
create table public.strength_session_analyses(
 user_id uuid not null references auth.users on delete cascade,
 workout_id uuid not null references public.strength_workouts on delete cascade,
 planned_workout_id uuid references public.planned_workouts on delete cascade,
 analysis_json jsonb not null, primary key(user_id,workout_id)
);
alter table public.strength_session_analyses enable row level security;
create policy own_analysis on public.strength_session_analyses for select to authenticated using(user_id=auth.uid());
grant select on public.strength_session_analyses to authenticated;

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
    if x->>'planned_workout_id' is not null and not exists(select 1 from planned_workouts where id=(x->>'planned_workout_id')::uuid and user_id=p_owner) then raise exception 'Invalid plan owner'; end if;
    select (to_timestamp(started_at / 1000.0) at time zone p_zone)::date into old_date
      from strength_workouts where id = wid and user_id = p_owner;
    new_date := (to_timestamp((x->>'started_at')::bigint / 1000.0) at time zone p_zone)::date;
    dates := array_append(array_append(dates, old_date), new_date);
    insert into strength_workouts(id,user_id,name,started_at,ended_at,duration_sec,total_volume_kg,note,planned_workout_id)
      values(wid,p_owner,x->>'name',(x->>'started_at')::bigint,(x->>'ended_at')::bigint,
        (x->>'duration_sec')::int,(x->>'total_volume_kg')::float8,x->>'note',(x->>'planned_workout_id')::uuid)
      on conflict(id) do update set name=excluded.name,started_at=excluded.started_at,
        ended_at=excluded.ended_at,duration_sec=excluded.duration_sec,
        total_volume_kg=excluded.total_volume_kg,note=excluded.note,planned_workout_id=excluded.planned_workout_id;
    delete from strength_workout_sets where workout_id=wid and user_id=p_owner;
    insert into strength_workout_sets(id,user_id,workout_id,exercise_name,muscle,idx,weight_kg,reps,rpe,is_warmup,note,quantity_unit)
      select s.id,p_owner,wid,s.exercise_name,s.muscle,s.idx,s.weight_kg,s.reps,s.rpe,s.is_warmup,s.note,coalesce(s.quantity_unit,'reps')
      from jsonb_to_recordset(x->'sets') as s(id uuid,exercise_name text,muscle text,idx int,
        weight_kg float8,reps int,rpe int,is_warmup boolean,note text,quantity_unit text);
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
  -- Assisted kilograms and timed/distance quantities are not lifted volume.
  with volumes as (
   select w.id,coalesce(sum(s.weight_kg*s.reps) filter(where not coalesce(s.is_warmup,false) and s.quantity_unit='reps' and s.exercise_name not ilike '%assisted%' and s.exercise_name not ilike '%band%'),0) as volume
   from strength_workouts w left join strength_workout_sets s on s.workout_id=w.id and s.user_id=p_owner
   where w.user_id=p_owner and (to_timestamp(w.started_at/1000.0) at time zone p_zone)::date=any(dates) group by w.id
  ) update strength_workouts w set total_volume_kg=v.volume from volumes v where w.id=v.id and w.total_volume_kg is distinct from v.volume;
  insert into strength_logs(user_id,date,exercise_name,muscle_groups,sets,estimated_1rm,workout_id)
    select p_owner,(to_timestamp(w.started_at/1000.0) at time zone p_zone)::date,
      s.exercise_name,array_agg(distinct s.muscle),
      jsonb_agg(jsonb_build_object('reps',s.reps,'weight_kg',s.weight_kg,'rpe',s.rpe,'quantity_unit',s.quantity_unit) order by s.idx,s.id),
      max(case when s.quantity_unit='reps' and s.exercise_name not ilike '%assisted%' and s.exercise_name not ilike '%band%' then case when s.reps <= 1 then s.weight_kg else s.weight_kg*(1+s.reps/30.0) end end),w.id
    from strength_workouts w join strength_workout_sets s on s.workout_id=w.id and s.user_id=p_owner
    where w.user_id=p_owner and not coalesce(s.is_warmup,false) and s.reps>0
      and (to_timestamp(w.started_at/1000.0) at time zone p_zone)::date=any(dates)
    group by w.id,(to_timestamp(w.started_at/1000.0) at time zone p_zone)::date,s.exercise_name;
end $$;

-- One SQL statement gives a coherent snapshot; JSON aggregation avoids the
-- PostgREST row cap on parent AND child tables without inconsistent page reads.

-- Session caches are invalidated with their source writes, never by date guesses.
create function public.invalidate_strength_session_analysis() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare owner uuid; wid uuid;
begin
 if TG_OP='DELETE' then owner:=old.user_id; else owner:=new.user_id; end if;
 if TG_TABLE_NAME='strength_workout_sets' then
  if TG_OP='DELETE' then wid:=old.workout_id; else wid:=new.workout_id; end if;
  delete from strength_session_analyses where user_id=owner and workout_id=wid;
 elsif TG_TABLE_NAME='strength_workouts' then
  if TG_OP='DELETE' then wid:=old.id; else wid:=new.id; end if;
  delete from strength_session_analyses where user_id=owner and workout_id=wid;
 elsif TG_TABLE_NAME='planned_workouts' then
  if TG_OP='DELETE' then wid:=old.id; else wid:=new.id; end if;
  delete from strength_session_analyses where user_id=owner and planned_workout_id=wid;
 else delete from strength_session_analyses where user_id=owner;
 end if;
 return null;
end $$;
create trigger invalidate_session_sets after insert or update or delete on public.strength_workout_sets for each row execute function public.invalidate_strength_session_analysis();
create trigger invalidate_session_plan after update or delete on public.planned_workouts for each row execute function public.invalidate_strength_session_analysis();
create trigger invalidate_session_observations after insert or update or delete on public.completed_activities for each row execute function public.invalidate_strength_session_analysis();
revoke all on function public.invalidate_strength_session_analysis() from public,anon,authenticated;
grant all on public.strength_session_analyses to service_role;

create trigger invalidate_session_workout after update on public.strength_workouts for each row execute function public.invalidate_strength_session_analysis();
