#!/usr/bin/env python3
"""Isolated PostgreSQL tests. No project credentials, ports or external writes.
Cron/net extensions are replaced by scheduling stubs; SQL data paths are real.
"""
from pathlib import Path
import subprocess
import time
import uuid
import sys
root = Path(__file__).resolve().parents[2]
container = "workout-maker-engine-test-" + uuid.uuid4().hex[:10]

def sql(value):
    result = subprocess.run(["docker", "exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], input=value, text=True, capture_output=True)
    if result.returncode:
        print(result.stdout, end="")
        print(result.stderr, end="", file=sys.stderr)
        raise RuntimeError("PostgreSQL test failed")
    return result.stdout

try:
    subprocess.run(["docker", "run", "--rm", "-d", "--name", container, "--label", "workout-maker-test=true", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"], check=True, stdout=subprocess.DEVNULL)
    for _ in range(30):
        ready = subprocess.run(["docker", "exec", container, "pg_isready", "-U", "postgres"], capture_output=True)
        if ready.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError("Test database did not become ready")
    sql((root / "scripts/engine-tests/bootstrap.sql").read_text())
    for migration in sorted((root / "supabase/migrations").glob("*.sql")):
        source = "\n".join(line for line in migration.read_text().splitlines() if not (line.strip().lower().startswith("create extension") and ("pg_cron" in line or "pg_net" in line)))
        print("Apply", migration.name, flush=True)
        sql(source)
    for scenario in sorted((root / "scripts/engine-tests").glob("scenario*.sql")):
        print("Test", scenario.name, flush=True)
        print(sql(scenario.read_text()), end="")
    print("Database engine scenarios passed.")
finally:
    subprocess.run(["docker", "rm", "-f", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
