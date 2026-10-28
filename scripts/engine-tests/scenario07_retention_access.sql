begin;
insert into auth.users(id,email) values('22222222-2222-4222-8222-222222222222','retention-other@example.invalid') on conflict(id) do nothing;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.role','authenticated',true);
insert into adaptation_proposals(id,user_id,plan_revision,athlete_revision,changes,explanation,next_action,policy_version,provenance,created_at)
 values('77777777-7777-4777-8777-777777777771','11111111-1111-4111-8111-111111111111',0,0,'[]','retention fixture','fixture','adaptation-1','{}',now()-interval '200 days');
insert into engine_events(id,user_id,kind,policy_version,created_at) values
 ('77777777-7777-4777-8777-777777777772','11111111-1111-4111-8111-111111111111','preview','adaptation-1',now()-interval '100 days'),
 ('77777777-7777-4777-8777-777777777773','22222222-2222-4222-8222-222222222222','preview','adaptation-1',now());
insert into workout_feedback(id,user_id,date,completed,outcome) values('77777777-7777-4777-8777-777777777774','11111111-1111-4111-8111-111111111111',current_date-200,false,'unknown');
set local role authenticated;
do $$begin
 if exists(select 1 from engine_events where user_id<>auth.uid()) then raise exception 'Cross-owner metrics visible';end if;
 if exists(select 1 from adaptation_proposals where user_id<>auth.uid()) then raise exception 'Cross-owner proposal visible';end if;
 begin perform prune_engine_observability();raise exception 'Owner could invoke service pruning';exception when insufficient_privilege then null;end;
 begin update engine_releases set mode='enabled';raise exception 'Owner could change rollout';exception when insufficient_privilege then null;end;
end $$;
reset role;
select prune_engine_observability();
do $$begin
 if exists(select 1 from adaptation_proposals where id='77777777-7777-4777-8777-777777777771') then raise exception 'Old proposal not pruned';end if;
 if exists(select 1 from engine_events where id='77777777-7777-4777-8777-777777777772') then raise exception 'Old event not pruned';end if;
 if not exists(select 1 from workout_feedback where id='77777777-7777-4777-8777-777777777774') then raise exception 'Pruning deleted athlete history';end if;
 if not exists(select 1 from engine_events where id='77777777-7777-4777-8777-777777777773') then raise exception 'Fresh metrics were pruned';end if;
end $$;
rollback;
