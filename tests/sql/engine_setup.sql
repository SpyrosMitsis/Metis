create role service_role bypassrls;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
grant execute on function auth.role() to authenticated,service_role;
