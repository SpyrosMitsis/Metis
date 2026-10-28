-- Program decisions are saved in the same transaction as their plan request.
-- This view exposes an owner-filtered timeline without duplicating snapshots
-- or maintaining a second, eventually inconsistent program-state write path.
create view public.training_program_history with (security_invoker=true) as
 select user_id,request_id,created_at,
  coalesce(result->'program_state',result->'programs'->0) as program_state,
  result->>'engine_version' as engine_version
 from public.plan_requests
 where result ? 'program_state' or case when jsonb_typeof(result->'programs')='array' then jsonb_array_length(result->'programs')>0 else false end;
grant select on public.training_program_history to authenticated;
