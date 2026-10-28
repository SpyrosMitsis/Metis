begin;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare owner uuid:='11111111-1111-4111-8111-111111111111'; p0 uuid:=gen_random_uuid();p1 uuid:=gen_random_uuid();proposal uuid:=gen_random_uuid();before0 jsonb;before1 jsonb;rest jsonb;candidate_changes jsonb;
begin
 before0:='{"type":"ride","duration_minutes":20,"sections":[],"prescription":{"scheduled_date":"2026-10-27"}}';
 before1:='{"type":"run","duration_minutes":20,"sections":[],"prescription":{"scheduled_date":"2026-10-27"}}';
 rest:='{"type":"rest","duration_minutes":0,"sections":[],"prescription":{"scheduled_date":"2026-10-27"}}';
 insert into planned_workouts(id,user_id,date,type,workout_json,session_slot,combined_group,transition_before_seconds) values(p0,owner,'2026-10-27','ride',before0,0,'fixture-brick',0),(p1,owner,'2026-10-27','run',before1,1,'fixture-brick',300);
 update engine_releases set mode='enabled',regression_passed=true,expert_reviewed=true,device_validated=true,evidence='{"regression":"fixture","expert":"fixture","device":"fixture"}' where policy_version='adaptation-1';
 candidate_changes:=jsonb_build_array(jsonb_build_object('id',p0,'before',before0,'after',rest,'before_transition_seconds',0,'after_transition_seconds',0));
 insert into adaptation_proposals(id,user_id,plan_revision,athlete_revision,changes,explanation,next_action,policy_version,provenance) values(proposal,owner,plan_revision(owner),coalesce((select revision from athlete_versions where user_id=owner),0),candidate_changes,'fixture','fixture','adaptation-1','{}');
 begin perform apply_adaptation(owner,proposal);raise exception 'Partial combined edit accepted';exception when raise_exception then if sqlerrm='Partial combined edit accepted' then raise;end if;end;
 -- Explicit parameter qualification avoids a PL/pgSQL variable/column collision.
 update adaptation_proposals ap set changes=jsonb_build_array(jsonb_build_object('id',p0,'before',before0,'after',rest,'before_transition_seconds',0,'after_transition_seconds',0),jsonb_build_object('id',p1,'before',before1,'after',rest,'before_transition_seconds',300,'after_transition_seconds',0)) where ap.id=proposal;
 perform apply_adaptation(owner,proposal);
 if exists(select 1 from planned_workouts where id in(p0,p1) and (type<>'rest' or transition_before_seconds<>0)) then raise exception 'Rest retained transition dose';end if;
 perform apply_adaptation(owner,proposal,true);
 if not exists(select 1 from planned_workouts where id=p1 and type='run' and transition_before_seconds=300 and combined_group='fixture-brick') then raise exception 'Undo lost combined-session identity or transition';end if;
end $$;
rollback;
