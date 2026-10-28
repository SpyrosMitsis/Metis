begin;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare owner uuid:='11111111-1111-4111-8111-111111111111'; pid uuid:=gen_random_uuid(); proposal uuid:=gen_random_uuid(); feedback uuid:=gen_random_uuid(); before jsonb; after jsonb; rev bigint; version bigint; result jsonb;
begin
 before:='{"type":"run","title":"Familiar run","duration_minutes":20,"sections":[],"prescription":{"scheduled_date":"2026-10-26"}}';
 after:='{"type":"run","title":"Reduced run","duration_minutes":15,"sections":[],"prescription":{"scheduled_date":"2026-10-26"}}';
 insert into planned_workouts(id,user_id,date,type,workout_json) values(pid,owner,'2026-10-26','run',before);
 rev:=plan_revision(owner);version:=coalesce((select revision from athlete_versions where user_id=owner),0);
 insert into adaptation_proposals(id,user_id,plan_revision,athlete_revision,changes,explanation,next_action,policy_version,provenance)
 values(proposal,owner,rev,version,jsonb_build_array(jsonb_build_object('id',pid,'date','2026-10-26','session_slot',0,'before',before,'after',after)),'Less dose after fatigue','Use familiar easy work','adaptation-1','{}');
 begin perform apply_adaptation(owner,proposal);raise exception 'Shadow release applied';exception when object_not_in_prerequisite_state then null;end;
 begin update engine_releases set mode='enabled' where policy_version='adaptation-1';raise exception 'Unreviewed release enabled';exception when check_violation then null;end;
 -- Evidence below belongs only to this isolated transaction fixture.
 update engine_releases set mode='enabled',regression_passed=true,expert_reviewed=true,device_validated=true,evidence='{"regression":"test fixture","expert":"test fixture","device":"test fixture"}' where policy_version='adaptation-1';
 update engine_releases set mode='canary',rollout_percent=0 where policy_version='adaptation-1';
 if engine_release_allowed('adaptation-1',owner) then raise exception 'Zero-percent canary exposed user';end if;
 update engine_releases set rollout_percent=100 where policy_version='adaptation-1';
 if not engine_release_allowed('adaptation-1',owner) then raise exception 'Full canary excluded user';end if;
 result:=apply_adaptation(owner,proposal);
 if (select workout_json->>'title' from planned_workouts where id=pid)<>'Reduced run' then raise exception 'Apply failed';end if;
 if apply_adaptation(owner,proposal)<>result then raise exception 'Apply was not idempotent';end if;
 update engine_releases set mode='disabled' where policy_version='adaptation-1';
 perform apply_adaptation(owner,proposal,true);
 update engine_releases set mode='enabled' where policy_version='adaptation-1';
 if (select workout_json from planned_workouts where id=pid)<>before then raise exception 'Undo failed';end if;
 if (select count(*) from adaptation_proposals where id=proposal and state='undone')<>1 then raise exception 'History was lost';end if;
 perform save_workout_feedback(owner,jsonb_build_object('id',gen_random_uuid(),'planned_workout_id',pid,'date','2026-10-26','completed',true,'outcome','as_planned'));
 perform save_workout_feedback(owner,jsonb_build_object('id',gen_random_uuid(),'planned_workout_id',pid,'date','2026-10-26','completed',false,'outcome','unknown','enjoyment',4));
 if not (select completed from planned_workouts where id=pid) then raise exception 'Optional feedback cleared completion';end if;
 perform undo_session_feedback(pid);
 perform save_workout_feedback(owner,jsonb_build_object('id',feedback,'planned_workout_id',pid,'date','2026-10-26','completed',false,'outcome','skipped','reason','illness','actual_minutes',0,'enjoyment',2));
 perform save_workout_feedback(owner,jsonb_build_object('id',feedback,'planned_workout_id',pid,'date','2026-10-26','completed',false,'outcome','skipped','reason','illness','actual_minutes',0,'enjoyment',2));
 if (select count(*) from workout_feedback where id=feedback)<>1 then raise exception 'Feedback retry duplicated report';end if;
 if not exists(select 1 from training_holds where id=feedback and active and sport is null) then raise exception 'Illness did not create hold';end if;
 if not exists(select 1 from engine_events where user_id=owner and kind='feedback' and properties->>'reason'='illness') then raise exception 'Feedback metric missing';end if;
 perform undo_session_feedback(pid);
 if (select skipped from planned_workouts where id=pid) then raise exception 'Undo skip failed';end if;
 if not exists(select 1 from workout_feedback where id=feedback) then raise exception 'Undo deleted source feedback';end if;
 perform resolve_training_hold(feedback);
 if exists(select 1 from training_holds where id=feedback and active) then raise exception 'Explicit hold resolution failed';end if;
 -- A preview becomes stale when observations change, even without a plan edit.
 proposal:=gen_random_uuid();rev:=plan_revision(owner);version:=(select revision from athlete_versions where user_id=owner);
 insert into adaptation_proposals(id,user_id,plan_revision,athlete_revision,changes,explanation,next_action,policy_version,provenance) values(proposal,owner,rev,version,jsonb_build_array(jsonb_build_object('id',pid,'before',before,'after',after)),'fixture','fixture','adaptation-1','{}');
 insert into workout_feedback(user_id,date,completed,outcome) values(owner,'2026-10-26',false,'unknown');
 begin perform apply_adaptation(owner,proposal);raise exception 'Stale observations accepted';exception when serialization_failure then null;end;
 -- Refresh versions, then verify a locked commitment and whole-request rollback.
 update adaptation_proposals set athlete_revision=(select revision from athlete_versions where user_id=owner) where id=proposal;
 update planned_workouts set locked=true where id=pid;
 update adaptation_proposals set plan_revision=plan_revision(owner) where id=proposal;
 begin perform apply_adaptation(owner,proposal);raise exception 'Locked session changed';exception when serialization_failure then null;end;
 if (select workout_json from planned_workouts where id=pid)<>before then raise exception 'Rejected candidate modified plan';end if;
 begin perform resolve_training_hold('22222222-2222-4222-8222-222222222222');raise exception 'Cross-owner hold accessible';exception when insufficient_privilege then null;end;
end $$;
rollback;
