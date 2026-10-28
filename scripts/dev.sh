#!/usr/bin/env bash
# ============================================================================
# dev.sh — one front door for building, running, debugging & observing this app.
#
# Bakes in the environment gotchas so commands become one word:
#   - Android/Kotlin needs JDK 17 (system JDK breaks Kotlin)        -> JAVA_HOME
#   - deno lives at ~/.deno/bin                                     -> PATH
#   - function deploys/logs need the project ref                    -> PROJECT_REF
#   - one phone, wired OR wireless                                  -> ANDROID_SERIAL
#
# Usage:  scripts/dev.sh <command> [args]      (run with no args for help)
# ============================================================================
set -euo pipefail

# --- repo-rooted, runnable from anywhere ------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- personal machine defaults (untracked; see scripts/dev.local.sh) --------
# Put PROJECT_REF / ANDROID_SERIAL / any override there so the repo stays
# publishable; explicit env vars still win.
[[ -f "$SCRIPT_DIR/dev.local.sh" ]] && source "$SCRIPT_DIR/dev.local.sh"

# --- baked-in environment (override via env or dev.local.sh) ----------------
JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk}"
DENO_BIN="${DENO_BIN:-$HOME/.deno/bin}"
PROJECT_REF="${PROJECT_REF:-}"        # your Supabase project ref
APP_ID="${APP_ID:-com.workoutmaker.app}"
ANDROID_SERIAL="${ANDROID_SERIAL:-}"  # adb serial; blank = adb's default device
LOCAL_API="${LOCAL_API:-http://localhost:54321}"
# Seeded dev athlete (supabase/seed.sql) — used by fn:call for a real user JWT.
DEV_EMAIL="${DEV_EMAIL:-athlete@example.com}"
DEV_PASSWORD="${DEV_PASSWORD:-password123}"

export JAVA_HOME
[[ -n "$ANDROID_SERIAL" ]] && export ANDROID_SERIAL
export PATH="$DENO_BIN:$PATH"

# --- device resolution (wired or wireless) ----------------------------------
# Wireless debugging gives the SAME phone a different serial:
#   wired     R3CT40D46AD
#   wireless  adb-R3CT40D46AD-XAVAZP._adb-tls-connect._tcp
# so a configured ANDROID_SERIAL stops matching the moment you unplug, and
# gradle/adb silently target "no device" or the wrong one. Resolve it instead
# of trusting it: exact match, then substring (which bridges the two forms
# above), then the only attached device. Everything downstream, gradle
# included, reads the resolved value from the environment.
adb_devices() { adb devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1}'; }

resolve_device() {
  need adb
  local attached; attached="$(adb_devices)"
  [[ -n "$attached" ]] || die "no device attached (usb, or 'scripts/dev.sh android:connect <host:port>')"

  if [[ -n "$ANDROID_SERIAL" ]]; then
    if grep -qxF "$ANDROID_SERIAL" <<<"$attached"; then return 0; fi
    # Same phone over the other transport.
    local match; match="$(grep -F "$ANDROID_SERIAL" <<<"$attached" | head -1 || true)"
    if [[ -n "$match" ]]; then
      say "device $ANDROID_SERIAL is attached as $match (wireless), using that"
      ANDROID_SERIAL="$match"; export ANDROID_SERIAL; return 0
    fi
  fi

  local count; count="$(wc -l <<<"$attached")"
  if [[ "$count" -eq 1 ]]; then
    ANDROID_SERIAL="$attached"; export ANDROID_SERIAL; return 0
  fi
  die "several devices attached, set ANDROID_SERIAL to one of:"$'\n'"$attached"
}

# --- pretty output ----------------------------------------------------------
c_blue=$'\033[34m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf '%s>>%s %s\n' "$c_blue" "$c_off" "$*"; }
warn() { printf '%s!!%s %s\n' "$c_yellow" "$c_off" "$*" >&2; }
die()  { printf '%sxx%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' on PATH"; }
need_ref() { [[ -n "$PROJECT_REF" ]] || die "PROJECT_REF is unset — set it in scripts/dev.local.sh or the environment"; }

confirm() { # confirm "question"
  printf '%s?? %s [y/N] %s' "$c_yellow" "$*" "$c_off"
  read -r reply; [[ "$reply" =~ ^[Yy]$ ]]
}

# ============================================================================
# Android
# ============================================================================
gradlew() { ( cd "$ROOT/android" && ./gradlew "$@" ); }

cmd_android_build()   { say "assemblePlayDebug (JDK17)"; gradlew :app:assemblePlayDebug -q; }
cmd_android_install() {
  resolve_device
  say "installPlayDebug (JDK17) -> $ANDROID_SERIAL"
  gradlew :app:installPlayDebug -q
  say "installed."
}

cmd_android_devices() {
  need adb
  local attached; attached="$(adb_devices)"
  [[ -n "$attached" ]] || { warn "no devices attached"; return 0; }
  while read -r s; do
    local model; model="$(adb -s "$s" shell getprop ro.product.model 2>/dev/null | tr -d '\r' || true)"
    local kind="usb"; [[ "$s" == *_adb-tls-connect._tcp || "$s" == *:* ]] && kind="wireless"
    printf '  %s  %s  %s\n' "$s" "${model:-?}" "$kind"
  done <<<"$attached"
}

# Wireless debugging, once per network: pair with the code from
# Settings > Developer options > Wireless debugging > Pair device with code,
# then connect to the (different) port shown on the main wireless-debugging
# screen. After that adb reconnects on its own until the phone reboots.
cmd_android_pair() {
  need adb
  [[ $# -eq 2 ]] || die "usage: android:pair <host:port> <6-digit-code>   (the PAIRING port, not the connect one)"
  adb pair "$1" "$2"
  say "paired. now: scripts/dev.sh android:connect <host:port> (the other port)"
}

cmd_android_connect() {
  need adb
  [[ $# -eq 1 ]] || die "usage: android:connect <host:port>   (from the wireless-debugging screen)"
  adb connect "$1"
  resolve_device
  say "connected: $ANDROID_SERIAL"
}

# BOTH flavors on purpose — this is exactly what CI runs. play is what the other
# android:* commands build, so a foss-only breakage (the billing source set is
# flavor-specific) is invisible locally until CI catches it.
cmd_android_test()    { say "unit tests, both flavors (JDK17)"; gradlew testPlayDebugUnitTest testFossDebugUnitTest; }

# android:uitest — Compose UI tests, ON THE PHONE. Slower than android:test and
# needs a device, so it is a separate command: these compose real screens to
# catch what unit tests structurally cannot (layering, tap targets, gating).
#
# leaveApksInstalledAfterRun is NOT optional. Gradle uninstalls both APKs when
# the run ends, and an uninstall wipes app data: the first run of this command
# signed the phone out of the account it was testing and cleared the Room cache.
cmd_android_uitest() {
  resolve_device
  say "instrumented tests on $ANDROID_SERIAL (JDK17)"
  ANDROID_SERIAL="$ANDROID_SERIAL" gradlew connectedPlayDebugAndroidTest \
    -Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true "$@"
}

cmd_android_restart() {
  resolve_device
  say "restarting $APP_ID on $ANDROID_SERIAL"
  adb shell am force-stop "$APP_ID" || true
  adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null
}

cmd_android_logclear() { resolve_device; adb logcat -c && say "logcat buffer cleared"; }

# android:log [regex]  — stream the app's own logs (by PID), color E/W, optional grep.
cmd_android_log() {
  resolve_device
  local filter="${1:-}"
  local pid; pid="$(adb shell pidof "$APP_ID" 2>/dev/null | tr -d '\r' || true)"
  if [[ -z "$pid" ]]; then
    warn "$APP_ID not running — showing tag-filtered logs (WM*). Start the app to get full PID logs."
    if [[ -n "$filter" ]]; then
      adb logcat -v color "WM:V" "AndroidRuntime:E" "*:S" | grep --line-buffered -iE "$filter"
    else
      adb logcat -v color "WM:V" "AndroidRuntime:E" "*:S"
    fi
    return
  fi
  say "tailing pid $pid ($APP_ID)${filter:+  grep=/$filter/}   — Ctrl-C to stop"
  if [[ -n "$filter" ]]; then
    adb logcat -v color --pid "$pid" | grep --line-buffered -iE "$filter"
  else
    adb logcat -v color --pid "$pid"
  fi
}

# ============================================================================
# Device QA
# ============================================================================
# qa:device [--live] [--steps a,b]
#
# Walks the INSTALLED app on the phone and asserts what a careful manual pass
# would, resolving every tap by on-screen text instead of by coordinate. Writes
# a screenshot + hierarchy per step to qa_runs/<stamp>/ so a failure arrives
# with its evidence. Read-only unless --live, which adds one real coach turn.
cmd_qa_device() {
  need deno
  resolve_device
  say "device QA on $ANDROID_SERIAL"
  ( cd "$ROOT" && ANDROID_SERIAL="$ANDROID_SERIAL" deno run -A scripts/qa/run.ts "$@" )
}

# qa:test — the driver's own tests (parser + sweeps), no phone needed.
cmd_qa_test() { need deno; say "deno test scripts/qa/"; ( cd "$ROOT" && deno test -A scripts/qa/ "$@" ); }

# ============================================================================
# Deno / shared edge-function code
# ============================================================================
cmd_deno_test() {
  need deno
  say "deno test functions/_shared/  (PATH has $DENO_BIN)"
  ( cd "$ROOT/supabase" && deno test --allow-all functions/_shared/ "$@" )
}

# deno:check [fn ...]  — type-check named functions, or every functions/*/index.ts.
cmd_deno_check() {
  need deno
  local targets=()
  if [[ $# -gt 0 ]]; then
    for f in "$@"; do targets+=("functions/$f/index.ts"); done
  else
    while IFS= read -r p; do targets+=("$p"); done \
      < <(cd "$ROOT/supabase" && ls functions/*/index.ts)
  fi
  say "deno check: ${targets[*]}"
  ( cd "$ROOT/supabase" && deno check "${targets[@]}" )
}

# ============================================================================
# Supabase edge functions
# ============================================================================
cmd_fn_serve() {
  need supabase
  say "supabase functions serve (local, --env-file functions/.env)"
  ( cd "$ROOT/supabase" && supabase functions serve --env-file functions/.env )
}

cmd_fn_deploy() {
  need supabase; need_ref
  [[ $# -gt 0 ]] || die "usage: fn:deploy <name> [name ...]"
  say "deploy [$*] -> $PROJECT_REF"
  supabase functions deploy "$@" --project-ref "$PROJECT_REF"
}

# The Management API personal access token, WITHOUT keeping a second copy of it.
# The CLI already stores one in the OS keyring when you `supabase login`, so read
# it from there rather than asking for it again in dev.local.sh (this repo is
# public; the fewer places a token lives, the better). $SUPABASE_ACCESS_TOKEN
# still wins if it is set, which is what CI would use.
mgmt_token() {
  if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then printf '%s' "$SUPABASE_ACCESS_TOKEN"; return; fi
  command -v secret-tool >/dev/null 2>&1 || return 0
  secret-tool lookup service "Supabase CLI" username access-token 2>/dev/null || true
}

# fn:logs <name> [minutes]
#   `supabase functions logs` does not exist in the pinned CLI (2.34.3 ships
#   delete/deploy/download/list/new/serve only), so this used to fail with an
#   "unknown flag: --project-ref" wall of help text that read like a broken
#   project. Query the Management API's analytics endpoint directly instead:
#   Uses the unified logs endpoint after the September 2026 removal of logs.all.
cmd_fn_logs() {
  need curl; need jq; need_ref
  [[ $# -ge 1 ]] || die "usage: fn:logs <name> [minutes, default 60]"
  local name="$1" mins="${2:-60}"

  local token; token="$(mgmt_token)"
  [[ -n "$token" ]] || die "no Management API token: run 'supabase login', or set SUPABASE_ACCESS_TOKEN"

  [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid function name"

  # An explicit window is REQUIRED: with no timestamps the endpoint answers from
  # a window so narrow it reliably returns zero rows, which looks like "logging
  # is broken" rather than "you asked about the wrong minute".
  local start end
  start="$(date -u -d "$mins minutes ago" +%Y-%m-%dT%H:%M:%SZ)"
  end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  say "logs $name (last ${mins}m) -> $PROJECT_REF  (tip: WM_LOG=debug for verbose JSON lines)"
  curl -fsS -G "https://api.supabase.com/v1/projects/$PROJECT_REF/analytics/endpoints/logs" \
    --data-urlencode "sql=select timestamp, event_message from logs where event_message like '%\"fn\":\"$name\"%' or event_message like '%/functions/v1/$name%' order by timestamp desc limit 200" \
    --data-urlencode "iso_timestamp_start=$start" \
    --data-urlencode "iso_timestamp_end=$end" \
    -H "Authorization: Bearer $token" \
    | jq -r '
        if .error then "error: \(.error)"
        elif (.result | length) == 0 then "(no log lines in the window, try a larger \"minutes\")"
        # Oldest first, so a turn reads top to bottom like a transcript. The
        # new endpoint returns ISO timestamps rather than epoch microseconds.
        else (.result | reverse | .[] |
              "\(.timestamp | tostring | .[11:19])  \(.event_message | sub("\\s+$"; ""))")
        end'
}

# fn:call <name> [jsonBody] [--remote]
#   Drives an edge function directly with a real seeded-user JWT — exercises the
#   backend (esp. the LLM path) without the Android UI. Local by default.
cmd_fn_call() {
  need curl
  local name="${1:-}"; [[ -n "$name" ]] || die "usage: fn:call <name> [jsonBody] [--remote]"
  shift
  local body="{}" remote=0
  for a in "$@"; do
    case "$a" in
      --remote) remote=1 ;;
      *) body="$a" ;;
    esac
  done

  local base anon
  if [[ "$remote" == 1 ]]; then
    need_ref
    base="https://${PROJECT_REF}.supabase.co"
    anon="${SUPABASE_ANON_KEY:-}"
    [[ -n "$anon" ]] || die "set SUPABASE_ANON_KEY for --remote (anon key from the dashboard)"
  else
    base="$LOCAL_API"
    # Local supabase prints a stable anon key; prefer `supabase status`, fall back to env.
    if command -v supabase >/dev/null 2>&1; then
      anon="$(cd "$ROOT/supabase" && supabase status -o env 2>/dev/null | sed -n 's/^ANON_KEY=//p' | tr -d '"' || true)"
    fi
    anon="${anon:-${SUPABASE_ANON_KEY:-}}"
    [[ -n "$anon" ]] || die "no local anon key — run 'supabase start' or set SUPABASE_ANON_KEY"
  fi

  say "login $DEV_EMAIL @ $base"
  local token
  token="$(curl -fsS "$base/auth/v1/token?grant_type=password" \
    -H "apikey: $anon" -H "Content-Type: application/json" \
    -d "{\"email\":\"$DEV_EMAIL\",\"password\":\"$DEV_PASSWORD\"}" \
    | _json_field access_token || true)"
  [[ -n "$token" && "$token" != "null" ]] || die "login failed (is the DB seeded / supabase up?)"

  say "POST $base/functions/v1/$name  body=$body"
  curl -sS "$base/functions/v1/$name" \
    -H "Authorization: Bearer $token" -H "apikey: $anon" \
    -H "Content-Type: application/json" -d "$body" | _pretty_json
}

# --- tiny JSON helpers (jq if present, else python3) ------------------------
_pretty_json() {
  if command -v jq >/dev/null 2>&1; then jq .; else python3 -m json.tool 2>/dev/null || cat; fi
}
_json_field() { # _json_field key  (reads stdin)
  if command -v jq >/dev/null 2>&1; then jq -r ".$1 // empty"
  else python3 -c "import sys,json; print(json.load(sys.stdin).get('$1',''))" 2>/dev/null || true; fi
}

# ============================================================================
# Database & web
# ============================================================================
cmd_db_push() {
  need supabase
  warn "db:push runs ALL pending migrations against ${PROJECT_REF:-the linked project}."
  confirm "Push migrations now?" || { say "aborted."; return; }
  ( cd "$ROOT/supabase" && supabase db push )
}

# ============================================================================
# LLM evaluation
# ============================================================================
# eval:run [--tier smoke|full] [--models a,b] [--repeats N] [--no-judge]
#
# Drives the REAL prompts through the models in scripts/eval/models.ts and scores
# the output with the engine's own checkers. Offline: no Supabase, no edge
# functions, no DB, so it cannot touch a real training plan.
#
# Needs provider keys in scripts/dev.local.sh (untracked), e.g.
#   export GROQ_API_KEY=...  /  export DEEPSEEK_API_KEY=...
# A model with no key is skipped, not fatal.
cmd_eval_run() {
  need deno
  say "eval: real prompts -> models -> the engine's own checkers (offline)"
  # Slow reasoning models (mimo-v2.5-pro) need >60s for a week plan; production
  # keeps the 60s default, only the offline eval waits longer.
  ( cd "$ROOT" && WM_LLM_TIMEOUT_MS="${WM_LLM_TIMEOUT_MS:-180000}" deno run -A scripts/eval/run.ts "$@" )
}

# eval:notebook — open the analysis notebook on the latest run.
cmd_eval_notebook() {
  need jupyter
  local latest
  latest="$(ls -1t "$ROOT"/eval_runs/*.jsonl 2>/dev/null | head -1 || true)"
  [[ -n "$latest" ]] || warn "no eval_runs/*.jsonl yet — run 'scripts/dev.sh eval:run' first"
  [[ -n "$latest" ]] && say "latest run: $latest"
  ( cd "$ROOT" && jupyter lab notebooks/llm_eval.ipynb )
}

# ============================================================================
# LLM cost
# ============================================================================
# llm:cost [days] [--recent [n]]
#
# Where the AI money goes. Reads generation_logs (which every LLM call writes
# via _shared/generation_log.ts) and rolls it up by feature+model. `hosted` rows
# are the ones on YOUR key — the spend hosted_spend()/quota.ts meters. See
# docs/LLM_COSTS.md.
cmd_llm_cost() {
  need psql
  [[ -n "${WM_DB_URL:-}" ]] || die "WM_DB_URL is unset — put your Supabase Postgres connection string in scripts/dev.local.sh (Dashboard > Project Settings > Database > Connection string > URI). It stays untracked."

  local days="7" recent="" n="20"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --recent) recent=1; [[ "${2:-}" =~ ^[0-9]+$ ]] && { n="$2"; shift; } ;;
      *) [[ "$1" =~ ^[0-9]+$ ]] && days="$1" || die "usage: llm:cost [days] [--recent [n]]" ;;
    esac
    shift
  done

  if [[ -n "$recent" ]]; then
    say "last $n requests"
    psql "$WM_DB_URL" -P pager=off -c "
      select created_at::timestamp(0) as when, feature,
             case when hosted then 'hosted' else 'byo' end as key,
             coalesce(model, provider, '?') as model,
             prompt_tokens as in_tok, completion_tokens as out_tok,
             coalesce(cache_read_tokens, 0) as cache_rd,
             to_char(coalesce(estimated_cost_usd, 0), 'FM\$990.000000') as usd,
             case when parsed_ok then '' else 'FAIL' end as note
      from generation_logs
      order by created_at desc
      limit $n;"
    return
  fi

  say "last $days days by feature + model"
  psql "$WM_DB_URL" -P pager=off -c "
    select feature,
           case when hosted then 'hosted' else 'byo' end as key,
           coalesce(model, provider, '?') as model,
           count(*) as calls,
           count(*) filter (where not parsed_ok) as failed,
           sum(prompt_tokens) as in_tok,
           sum(completion_tokens) as out_tok,
           -- Prompt-cache health. cache_hit% is the share of the billed prompt
           -- served from cache; on 'chat' it should be high and STAY high. A
           -- feature that was caching and drops to 0 has had its prefix
           -- invalidated (a timestamp in a system prompt, a reordered tool
           -- list): same behavior, silently bigger bill. See _shared/llm_cache.ts.
           sum(coalesce(cache_read_tokens, 0)) as cache_rd,
           case when sum(prompt_tokens + coalesce(cache_write_tokens,0) + coalesce(cache_read_tokens,0)) > 0
                then round(100.0 * sum(coalesce(cache_read_tokens,0))
                     / sum(prompt_tokens + coalesce(cache_write_tokens,0) + coalesce(cache_read_tokens,0)))
                else 0 end as cache_hit_pct,
           to_char(sum(coalesce(estimated_cost_usd, 0)), 'FM\$990.000000') as usd
    from generation_logs
    where created_at > now() - interval '$days days'
    group by 1, 2, 3
    order by sum(coalesce(estimated_cost_usd, 0)) desc;"

  say "totals (hosted = your spend, the part quota.ts caps)"
  psql "$WM_DB_URL" -P pager=off -c "
    select case when hosted then 'hosted (you pay)' else 'byo (user pays)' end as key,
           count(*) as calls,
           count(distinct user_id) as users,
           sum(prompt_tokens) as in_tok,
           sum(completion_tokens) as out_tok,
           to_char(sum(coalesce(estimated_cost_usd, 0)), 'FM\$990.000000') as usd
    from generation_logs
    where created_at > now() - interval '$days days'
    group by 1
    order by 1;"
}

cmd_web_dev()   { ( cd "$ROOT/web" && npm run dev ); }
cmd_web_build() { ( cd "$ROOT/web" && npm run build ); }

# ============================================================================
# help / dispatch
# ============================================================================
cmd_help() {
  cat <<EOF
${c_blue}dev.sh${c_off} — build, run, debug & observe Workout Maker
  ${c_dim}env: JAVA_HOME=$JAVA_HOME  ref=$PROJECT_REF  device=$ANDROID_SERIAL${c_off}

${c_green}Android${c_off}
  android:install         build + install the debug APK on the phone (JDK17)
  android:devices         list attached devices (usb / wireless)
  android:pair <hp> <code>    wireless: pair once, using the PAIRING port
  android:connect <host:port> wireless: connect, using the other port
  android:build           assemblePlayDebug only
  android:test            unit tests, BOTH flavors (what CI runs)
  android:uitest          Compose UI tests on the phone (composes real screens)
  android:restart         force-stop + relaunch the app
  android:log [regex]     tail THIS app's logcat (by pid), optional grep filter
  android:logclear        clear the logcat buffer

${c_green}Edge functions (Deno)${c_off}
  deno:test [args]        run the _shared/ test suite
  deno:check [fn ...]     type-check named functions (default: all)
  fn:serve                serve functions locally (--env-file functions/.env)
  fn:deploy <name ...>    deploy named functions to the project
  fn:logs <name> [mins]   a deployed function's logs (default last 60 min)
  fn:call <name> [json] [--remote]
                          call a function with a seeded-user JWT; prints JSON

${c_green}Database & web${c_off}
  db:push                 run pending migrations (asks first)
  web:dev / web:build     Next.js dev server / production build

${c_green}Evaluation${c_off}
  eval:run [opts]         score the real prompts across models, offline
                          ${c_dim}--tier smoke|full  --models a,b  --repeats N  --no-judge
                          models live in scripts/eval/models.ts; keys in dev.local.sh${c_off}
  eval:notebook           open the analysis notebook on the latest run

${c_green}Device QA${c_off}
  qa:device [--live]      walk the installed app on the phone and assert
                          ${c_dim}taps resolve by on-screen text; artefacts in qa_runs/
                          --live also sends one real coach turn (costs an LLM call)${c_off}
  qa:test                 the QA driver's own tests (no phone needed)

${c_green}Cost${c_off}
  llm:cost [days]         AI spend by feature + model (default 7 days)
  llm:cost --recent [n]   the last n individual requests, with per-call cost
                          ${c_dim}needs WM_DB_URL in dev.local.sh; see docs/LLM_COSTS.md${c_off}

${c_dim}Examples:
  scripts/dev.sh android:install
  scripts/dev.sh android:log "WM|Exception"
  scripts/dev.sh fn:call daily-summary '{"date":"$(date +%F)"}'
  scripts/dev.sh eval:run --tier smoke
  scripts/dev.sh llm:cost 30
  WM_LOG=debug scripts/dev.sh fn:logs generate-workout${c_off}
EOF
}

main() {
  local cmd="${1:-help}"; shift || true
  case "$cmd" in
    android:install)  cmd_android_install "$@" ;;
    android:devices)  cmd_android_devices "$@" ;;
    android:pair)     cmd_android_pair "$@" ;;
    android:connect)  cmd_android_connect "$@" ;;
    android:build)    cmd_android_build "$@" ;;
    android:test)     cmd_android_test "$@" ;;
    android:uitest)   cmd_android_uitest "$@" ;;
    android:restart)  cmd_android_restart "$@" ;;
    android:log)      cmd_android_log "$@" ;;
    android:logclear) cmd_android_logclear "$@" ;;
    deno:test)        cmd_deno_test "$@" ;;
    deno:check)       cmd_deno_check "$@" ;;
    fn:serve)         cmd_fn_serve "$@" ;;
    fn:deploy)        cmd_fn_deploy "$@" ;;
    fn:logs)          cmd_fn_logs "$@" ;;
    fn:call)          cmd_fn_call "$@" ;;
    db:push)          cmd_db_push "$@" ;;
    eval:run)         cmd_eval_run "$@" ;;
    eval:notebook)    cmd_eval_notebook "$@" ;;
    llm:cost)         cmd_llm_cost "$@" ;;
    qa:device)        cmd_qa_device "$@" ;;
    qa:test)          cmd_qa_test "$@" ;;
    web:dev)          cmd_web_dev "$@" ;;
    web:build)        cmd_web_build "$@" ;;
    help|-h|--help)   cmd_help ;;
    *) warn "unknown command: $cmd"; echo; cmd_help; exit 2 ;;
  esac
}

main "$@"
