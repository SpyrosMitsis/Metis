create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema extensions;
create schema cron;
create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'service_role')$$;
grant usage on schema public,auth,extensions to authenticated,service_role,anon;
create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
-- Network/cron scheduling is deliberately not executed in a transaction test DB.
create table cron.job(jobid bigint, jobname text);
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant select,insert,update,delete on tables to authenticated;
alter default privileges in schema public grant usage,select on sequences to authenticated,service_role;
