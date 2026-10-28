-- Disposable PostgreSQL harness only. Never apply this fixture to a real backend.
create schema auth;
create schema extensions;
create role anon;
create role authenticated;
create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema public,auth to authenticated;
grant execute on function auth.uid() to authenticated;
