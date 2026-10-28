#!/usr/bin/env bash
# Disposable database only; never the configured Supabase backend.
set -euo pipefail
cd "$(dirname "$0")/.."
container="wm-engine-test-$$"
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=local-test-only postgres:16 >/dev/null
trap 'docker stop "$container" >/dev/null' EXIT
for attempt in {1..30}; do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
for script in tests/sql/android_sync_setup.sql tests/sql/engine_setup.sql   supabase/migrations/20260607000001_init_schema.sql   supabase/migrations/20260607000002_rls.sql   supabase/migrations/20260607000007_feedback.sql   supabase/migrations/20260607000012_strength_cloud_and_actuals.sql   supabase/migrations/20260607000014_strength_custom_exercises.sql   supabase/migrations/20260612000026_skipped_workouts.sql   supabase/migrations/20261021000046_atomic_android_sync.sql   supabase/migrations/20260607000010_week_plans.sql   supabase/migrations/20260608000017_locked_workouts.sql   supabase/migrations/20260610000021_ride_type.sql   supabase/migrations/20260610000023_activity_analysis.sql   supabase/migrations/20260611000024_strength_analysis.sql   supabase/migrations/20261022000047_engine_reliability.sql; do
  docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 < "$script" >/dev/null
done
docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
grant all on all tables in schema public to authenticated;
insert into auth.users(id,email) values
 ('00000000-0000-0000-0000-000000000001','one@example.test'),
 ('00000000-0000-0000-0000-000000000002','two@example.test');
SQL
docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 < tests/sql/engine_reliability_test.sql
