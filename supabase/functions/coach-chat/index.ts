// coach-chat — conversational sport-science coach.
//
// POST {
//   messages: [{ role: 'user'|'assistant', content }],
//   mode: 'chat' | 'finalize',
//   finalizeKind?: 'workout' | 'plan',
//   conversationId?: uuid,         // persist the thread
//   purpose?: 'setup'|'plan'|'workout',
//   save?: boolean                 // on finalize, store a workout_template
// }
//
// chat     → returns { reply } (free-form prose) and saves the thread.
// finalize → returns { template } (structured JSON) and optionally saves it.

import { errorStatus, handleOptions, json } from "../_shared/cors.ts";
import { logger } from "../_shared/log.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";
import { llmAccess } from "../_shared/llm_keys.ts";
import {
  type ChatMessage,
  customPriceFromProfile,
  estimateCostUsd,
  extractJson,
  llmGenerateWithFallback,
} from "../_shared/llm.ts";
import { logGeneration, logLlmResult } from "../_shared/generation_log.ts";
import { computeRecovery } from "../_shared/recovery.ts";
import { applyFallbackFitness } from "../_shared/load.ts";
import {
  compressThread,
  memoryDocsBlock,
  memoryFromProfile,
  summarizeDropped,
  updateUserDoc,
} from "../_shared/agent_memory.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { injuriesText, profileFactsBlock } from "../_shared/profile.ts";
import { goalRaceLine, pickGoalRace, upcomingGoals, weeksBetween } from "../_shared/context.ts";
import {
  COACH_SYSTEM_PROMPT,
  effortWord,
  finalizeInstruction,
  freshnessWord,
  loadWord,
  recoveryWord,
  trainingPhase,
} from "../_shared/prompt.ts";
import type { LlmProvider } from "../_shared/types.ts";
import {
  type AppSettingChange,
  executeTool,
  nativeToolDefs,
  toolCatalogPrompt,
  validateAppSettings,
} from "../_shared/coach_tools.ts";
import {
  callBudget,
  cleanReply,
  talksWithoutActing,
  shouldUpdateKnowledge,
  stripDashes,
} from "../_shared/coach_eval.ts";
import { dashScrubber, finalLegStream } from "../_shared/coach_stream.ts";
import { runNativeToolLoop, supportsNativeTools } from "../_shared/llm_native_tools.ts";

// Tool-use protocol appended to the coach system prompt for chat mode. The
// coach reads real data and takes real actions through a JSON tool channel —
// provider-agnostic so it works on every LLM the user might configure.
// Behavioral rules shared by both tool channels (native + JSON protocol).
const TOOL_RULES = `
RULES:
- Before giving training advice or a plan, READ the relevant data first (get_fitness, get_planned_week, get_recent_activities, get_strength_summary, get_readiness, get_execution_analysis, get_profile). Ground every claim in what you read.
- NEVER ask the athlete to describe past workouts, sessions, or numbers you can look up yourself. Questions like "how did my last workouts go?" mean: call get_recent_activities and get_execution_analysis (plus get_strength_summary for lifting), then answer from the data.
- DRIVE the task to completion in this turn. When the athlete's message already asks for or agrees to an action (e.g. "plan my week and put it on my calendar", "make me today's workout", "apply that"), TAKE the action (plan_week, generate_workout, move_workout, set_goal_race) now, don't stop to ask "shall I?" again. Then confirm what you did and why.
- NEVER promise an action instead of performing it. There is only THIS turn, the athlete cannot grant you a "next turn", so phrases like "I'll adjust your plan", "let me review your week", "I will proceed with these adjustments", "I'm going to update…", or "give me a moment" are FORBIDDEN unless you call the matching tool in this same turn. If you intend to change the plan, call plan_week / generate_workout / move_workout / set_goal_race NOW, read back the result, and report what you DID in the past tense, never what you will do.
- REPORT WHAT THE TOOL RETURNED, NOT WHAT YOU ASKED FOR. Every write tool returns week_now: the athlete's calendar AS IT STANDS AFTER that write. Describe the LAST week_now you were given, never an earlier one and never what you intended. If you scheduled sessions and then cleared days, week_now shows what actually survived. set_rest_day also returns cleared, naming the sessions it deleted: if it names something you just created, say so instead of describing the plan you meant to leave behind. If the result differs from what you intended, say what really happened, do not describe your intention as though it came true. The athlete is looking at the same calendar you just wrote.
- A request that signals intent IS consent to act. "I have an exam until June 30, adjust my plan", "lighten this week", "move my long run" all mean: do it now. Don't re-ask. For a destructive overwrite (regenerating an existing/partly-locked week, changing a goal-race date) just give a one-line heads-up of what you replaced as part of the report, don't stop to ask first.
- Only pause to ask first when the action is genuinely ambiguous AND unsignalled. When you do ask, ask once and propose a specific default.
- Don't end a turn by handing trivial work back ("want me to schedule it?") when the request already implied yes, just do it and report.
- GOALS AND RACES. When the athlete names an event and a date, call set_goal_race with everything they gave you: name, date, sport, distance, priority and any target. ALWAYS send distance as a plain event distance ("Marathon", "Half marathon", "10K", "70.3", "Ironman"), never a target time: it is what the feasibility check reads, and "sub 4 hours" tells it nothing. Use priority A for the goal they are actually training for, B or C for tune-up events. Saving a goal is one call, not a conversation about which field goes where.
- A goal with NO firm date ("a marathon next spring", "sometime in the autumn") cannot be saved, because the date drives phase, taper and every week you plan. Ask them for the date in one short question and stop there. Do not narrate that you are about to go and look something up, and never invent a plausible date.
- HONESTY ABOUT WHAT IS ACHIEVABLE. set_goal_race returns a feasibility verdict computed from their real volume, longest recent session and chronic load; assess_goal gives the same verdict without saving anything. If push_back is true, DO NOT plan a training block, do not call plan_week, and do not congratulate them on the goal. Tell them plainly that the timeline does not work, quote the specific evidence (their weekly volume against what the event needs, their longest run against its long day, the weeks available against the weeks required), and offer the suggested alternative. Be warm and direct, never preachy: you are the coach who tells them the truth, not the one who lets them get hurt. If they hear you out and still want it, respect that, say once that you think it is a bad idea, then help them do it as safely as possible.
- A "stretch" verdict is not a veto. Mention the risk in one clause and carry on.
- DROPPING A GOAL. When the athlete says they are not doing an event any more, call remove_goal_race. Never say a goal is gone without having called it: there is no other way to remove one, and a goal you only said you deleted stays on their Home screen and comes back. Read what it returns. If removed_count is 0, tell them nothing matched instead of confirming, and check the name with get_profile.
- Call remember when the athlete shares a durable preference or constraint. NEVER use remember for pain or an injury: it only writes coach notes and does not appear in the Injuries section or enforce safer training.
- Call set_training_pause when the athlete says they're stopping/pausing training for a stretch WITH a return date (travel, illness, work crunch, "I'm going to X until Y"). This is what actually stops plan_week from scheduling sessions in that window, do not rely on remember alone for this. Call resume_training if they say they're back early.
- PAIN AND INJURIES. The FIRST time the athlete mentions a new pain or injury, call report_injury immediately, even if you only know the body area. This is mandatory: it creates the structured injury shown in the Injuries section and applies a reversible safety backoff. Include a 1-10 pain score, exact side/location, and trigger/onset when the athlete already gave them. Do NOT wait for every detail and do NOT use remember instead.
- After recording it, be conversational: acknowledge it, then ask only the 1-2 most useful missing questions. Prioritize (1) exact location/side and pain 1-10, then (2) when it began/what loads it; ask about inability to bear weight, major swelling, deformity, numbness, or a traumatic pop when relevant. When the athlete answers with new injury details, call report_injury again for the same area so the structured entry is enriched. Sharp, worsening, or 7-10 pain is avoid-level protection; advise prompt clinical assessment for red flags or pain that persists/worsens, without diagnosing.
- For an already-known injury, use update_injury_status only for better/resolved/present updates; use report_injury if they provide new location, severity, or trigger detail.
- When they volunteer how a known injury is doing, call update_injury_status so the app stops asking about it. Use 'resolved' ONLY when they say it is genuinely gone: it takes the injury off the list and sessions stop being built around it. Call clear_injury_backoff if an area is fine again before its window ends. Backoffs expire on their own, so never promise to "remember to lift it later".
- Be efficient: a few targeted reads, then act/answer. You have at most 6 tool calls per turn.
- Your final message follows the Voice and Shape rules already given in the system prompt.`;

// System prompt suffix when the provider has native tool calling.
const NATIVE_TOOL_PREAMBLE = `

YOU ARE AN AGENTIC COACH WITH TOOLS. You can read the athlete's real training data and act on their plan. Don't invent numbers, read them.
${TOOL_RULES}`;

const TOOL_PROTOCOL = `

YOU ARE AN AGENTIC COACH WITH TOOLS. You can read the athlete's real training data and act on their plan. Don't invent numbers, read them.

TOOLS:
${toolCatalogPrompt()}

RESPONSE FORMAT, output ONLY one JSON object, nothing else:
• Use a tool:  {"action":"tool","tool":"<name>","args":{ ... }}
• Reply to athlete:  {"action":"final","message":"<concise, specific reply>"}
${TOOL_RULES}`;

const DAY = 86_400_000;

// How often the SSE stream emits a keepalive comment while the agentic loop is
// still thinking. Well under any client read timeout or proxy idle timeout.
const HEARTBEAT_MS = 10_000;

// One coach turn can fan out across three legs: the native tool loop, the
// JSON-protocol fallback when that yields no text, and one anti-stall retry that
// replays BOTH. Left to themselves those stack to ~24 sequential provider calls,
// double the ~12 that docs/LLM_COSTS.md prices the hosted caps against. The
// budget below is per TURN and shared by every leg, so the documented worst case
// is the real one.
const NATIVE_MAX_STEPS = 6;
const PROTOCOL_MAX_STEPS = 6;
const MAX_LLM_CALLS_PER_TURN = 12;

// callBudget/cleanReply live in _shared/coach_eval.ts (tested there) alongside
// the other pure coach-quality helpers, instead of trapped here untested.

// Tools that mutate the athlete's plan/calendar. The anti-stall guard uses this
// to tell "the coach actually acted" from "the coach only talked about acting".
const WRITE_TOOLS = new Set([
  "plan_week",
  "generate_workout",
  "move_workout",
  "set_goal_race",
  "remove_goal_race",
  "set_rest_day",
  "make_easier",
  "log_stretch_session",
  "set_training_pause",
  "resume_training",
  "report_injury",
  "set_injury_backoff",
  "clear_injury_backoff",
  "update_injury_status",
  // Mutates the profile, not the calendar: counts as "acted" for the
  // anti-stall guard and write-dedup, but the CLIENT's write set deliberately
  // excludes it (no calendar result card for saving an FTP).
  "update_profile",
  // Applied on the device, not the DB, but it's still "the coach acted".
  "update_app_settings",
]);

// The stall heuristic ("promised a plan change instead of calling the tool")
// lives in _shared/coach_eval.ts so the golden-set eval scores models with the
// exact same rule the runtime guard uses.

const STALL_NUDGE =
  "You described an action but did not perform it, no tool was called this turn. " +
  "Saying you already did it is worse than promising to: the athlete's plan is unchanged and they now believe otherwise. " +
  "If the change should happen, call the tool NOW (plan_week / generate_workout / move_workout / set_rest_day / make_easier / set_goal_race / remove_goal_race), read the result, and report what you DID. " +
  "If no change is actually needed, answer plainly, and do not claim or promise one.";

// Supabase Edge runtime keeps the worker alive for promises passed to
// EdgeRuntime.waitUntil even if the client disconnects mid-stream — without it
// the post-stream thread save can be killed on disconnect.
declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void };
function waitUntil(p: Promise<unknown>) {
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
  } catch { /* local dev runtime without EdgeRuntime */ }
}

// Active window sent to the model on long threads: the opening message (anchors
// the thread's purpose) plus the most recent turns within a budget. The FULL
// thread is still persisted, and the dropped turns are folded into a running
// summary (see persistThread), so old context is COMPRESSED, not lost.
const trimThread = (msgs: ChatMessage[]): ChatMessage[] => compressThread(msgs).kept;

// shouldUpdateKnowledge (+ its KNOWLEDGE_HINTS/SELF_STATEMENT regexes) lives in
// _shared/coach_eval.ts (tested there) — decides whether to run the
// background, LLM-backed knowledge maintainer this turn.

const log = logger("coach-chat");

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);

    const admin = adminClient();
    const body = await req.json().catch(() => ({}));
    const messages: ChatMessage[] = Array.isArray(body.messages) ? body.messages : [];
    const mode: string = body.mode ?? "chat";
    if (!messages.length) return json({ error: "messages required" }, 400);
    // Cost guard for every user (thread totals are trimmed later, but a single
    // giant message would ride through as the anchor turn).
    if (messages.some((m) => typeof m?.content === "string" && m.content.length > 8000)) {
      return json({ error: "Message too long." }, 400);
    }
    log.info("request", { mode, turns: messages.length, purpose: body.purpose, finalizeKind: body.finalizeKind });

    // --- athlete context so the coach grounds advice in real data ----------
    const { data: profile } = await admin
      .from("user_profiles")
      .select("display_name, onboarding, active_llm_provider, llm_fallback_chain, coach_knowledge, training_memory, coach_soul, coach_soul_updated_at, llm_custom_input_per_1m, llm_custom_output_per_1m, plan, plan_expires_at, use_hosted_ai")
      .eq("id", userId)
      .single();
    const onboarding = (profile?.onboarding ?? {}) as Record<string, unknown>;
    const agentMemory = memoryFromProfile(profile);

    // Running summary of earlier turns archived out of the active window — lets
    // long threads stay coherent without resending every token.
    let convSummary = "";
    if (body.conversationId) {
      const { data: conv } = await admin
        .from("coach_conversations")
        .select("summary")
        .eq("id", body.conversationId)
        .eq("user_id", userId)
        .single();
      convSummary = ((conv?.summary ?? "") as string).trim();
    }
    const summaryBlock = convSummary
      ? `\n\nCONVERSATION SO FAR (summary of earlier turns archived from context, rely on it; don't re-ask what it already covers):\n${convSummary}`
      : "";

    const since28 = new Date(Date.now() - 28 * DAY).toISOString().slice(0, 10);
    const since7 = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
    // CLAUDE.md: "today" is the CLIENT's local date, never UTC. This function
    // runs in UTC and the athlete does not, so a server-computed today is the
    // wrong day for part of every 24 hours. Clients send theirs; fall back to
    // UTC only for older ones that do not.
    const clientToday = typeof body.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today)
      ? body.today
      : null;
    const today = clientToday ?? new Date().toISOString().slice(0, 10);
    // Monday of the current week, for the inline adherence line.
    const weekStart = (() => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
    const [{ data: acts }, { data: todayPlanned }, { data: wellness }, { data: weekPlanned }, goalRows] = await Promise.all([
      admin.from("effective_activities")
        .select("type, date, distance_m, tss, ctl, atl, planned_workout_id, link_source")
        .eq("user_id", userId).gte("date", since28).order("date", { ascending: false }),
      admin.from("planned_workouts")
        .select("type, completed, workout_json, created_at")
        .eq("user_id", userId).eq("date", today),
      admin.from("wellness_checkins")
        .select("date, energy, soreness, sleep_score, hrv_rmssd, resting_hr, zepp_sleep_minutes")
        .eq("user_id", userId).gte("date", since7).order("date", { ascending: false }),
      admin.from("planned_workouts")
        .select("type, completed, date")
        .eq("user_id", userId).gte("date", weekStart).lte("date", today),
      upcomingGoals(admin, userId, today),
    ]);
    // No intervals-provided CTL in the window? Fill estimated values from
    // stored TSS so the coach still sees a fitness signal without intervals.icu.
    const a = await applyFallbackFitness(admin, userId, today, acts ?? []);
    const fitnessRow = a.find((r) => r.ctl != null);
    const ctl = fitnessRow?.ctl ?? 0;
    const atl = fitnessRow?.atl ?? 0;
    const weeklyKm = a.filter((r) => (r.type ?? "").toLowerCase().includes("run"))
      .reduce((s, r) => s + (r.distance_m ?? 0) / 1000, 0) / 4;

    // The anchor is a DATE pointing into `races`, so resolve it to the row and
    // count from that. The old arithmetic compared midnight-UTC against
    // Date.now(), half a day out for a tz-ahead athlete, and an anchor left
    // pointing at a deleted race kept driving the phase from nothing.
    const goalRace = pickGoalRace(goalRows, today, onboarding.goal_date as string | undefined);
    const weeksToGoal = goalRace?.date ? weeksBetween(today, goalRace.date) : null;
    const goalRaceClause = goalRaceLine(goalRace, today);

    // Today's primary session (same rule as Home/Calendar) + readiness — so the
    // coach can answer the most common first questions with zero tool calls.
    const primaryToday = [...(todayPlanned ?? [])].sort((x, y) => {
      if (!!x.completed !== !!y.completed) return x.completed ? 1 : -1;
      const xr = x.type === "rest" ? 1 : 0, yr = y.type === "rest" ? 1 : 0;
      if (xr !== yr) return xr - yr;
      return String(y.created_at ?? "").localeCompare(String(x.created_at ?? ""));
    })[0] ?? null;
    const todayLine = primaryToday
      ? `${(primaryToday.workout_json as { title?: string })?.title ?? primaryToday.type} (${primaryToday.type}${primaryToday.completed ? ", already completed" : ""})`
      : "nothing planned yet";
    const isNum = (v: unknown): v is number => typeof v === "number";
    const wells = wellness ?? [];
    const chrono = [...wells].reverse();
    const recovery = computeRecovery(
      wells,
      chrono.map((w) => (w as { hrv_rmssd?: number }).hrv_rmssd).filter(isNum),
      chrono.map((w) => (w as { resting_hr?: number }).resting_hr).filter(isNum),
    );
    const weeklyTss = Math.round(a.filter((r) => (r.date ?? "") >= since7).reduce((s2, r) => s2 + (r.tss ?? 0), 0));

    // Week adherence + recovery direction, as words (voice rule: the coach
    // interprets, it doesn't recite numbers).
    const weekSessions = (weekPlanned ?? []).filter((p) => p.type !== "rest");
    const weekDone = weekSessions.filter((p) => p.completed).length;
    const adherenceLine = weekSessions.length
      ? `completed ${weekDone} of ${weekSessions.length} planned sessions so far`
      : "no sessions planned yet";
    const recoveryTrendWord = (() => {
      const h = recovery.hrv?.deltaPct ?? 0;
      const r = recovery.rhr?.deltaPct ?? 0;
      const up = (h > 0.03 ? 1 : 0) + (r < -0.02 ? 1 : 0);
      const down = (h < -0.03 ? 1 : 0) + (r > 0.02 ? 1 : 0);
      return up > down ? "improving" : down > up ? "declining" : "steady";
    })();

    // Digest of the most recent sessions so "how did my workouts go?" never
    // gets "I can't see your workouts" — deeper detail still comes from tools.
    // Distance stays a number (athletes ask about it directly and it is
    // actionable); per-session TSS becomes a word, because six raw load figures
    // per turn is exactly the metric dump the voice rule then has to argue the
    // model out of reciting.
    const recentLines = a.slice(0, 6).map((r) => {
      const km = r.distance_m ? ` ${(r.distance_m / 1000).toFixed(1)} km` : "";
      const effort = effortWord(r.tss);
      return `${r.date} ${r.type ?? "session"}${km}${effort ? `, ${effort}` : ""}`;
    });

    // The overarching training goal is stated ONCE, by profileFactsBlock below
    // ("Goals: ..."). This block used to state it a second time from
    // onboarding.goal, which set_goal_race overwrote with a race NAME, so the
    // same prompt could say the goal was "Athens Marathon" and, nine lines
    // later, "Run 42.2 km at 5:33 /km + Build muscle". The dated goal is a
    // different fact and gets its own clause on the phase line.
    const context =
      `ATHLETE CONTEXT (background for your reasoning only):
- Name: ${profile?.display_name ?? "athlete"}; today is ${today}
- Experience: ${onboarding.experience ?? "unknown"}
- Available days: ${(onboarding.days as string[] | undefined)?.join(", ") ?? "unknown"}; session length: ${onboarding.session_duration ?? "?"} min
- Equipment: ${onboarding.equipment ?? "unknown"}; injuries: ${injuriesText(onboarding) || "none noted"}
- Form/freshness: ${freshnessWord(ctl - atl)}
- Recovery today: ${recoveryWord(recovery.band)}, trend ${recoveryTrendWord}; load so far ${loadWord(weeklyTss, onboarding.weekly_tss_target as number | undefined)}
- This week: ${adherenceLine}
- Today's plan: ${todayLine}
- Last completed sessions (newest first): ${recentLines.join(" | ") || "none recorded in the last 28 days"}
- ~${weeklyKm.toFixed(0)} km/week recently; training phase: ${trainingPhase(weeksToGoal)}${goalRaceClause ? `; next goal: ${goalRaceClause}` : ""}` +
      profileFactsBlock(onboarding, profile?.display_name as string | undefined) +
      memoryDocsBlock(agentMemory) +
      summaryBlock;

    const systemPrompt = `${COACH_SYSTEM_PROMPT}\n\n${context}`;

    // --- resolve provider keys (fallback chain) ----------------------------
    const { chain, resolveKey, resolveModel, resolveBaseUrl, hosted } = await llmAccess(admin, userId, profile);

    // --- build the turn list -----------------------------------------------
    const turns: ChatMessage[] = trimThread(messages);
    if (mode === "finalize") {
      const kind = body.finalizeKind === "plan" ? "plan" : "workout";
      turns.push({ role: "user", content: finalizeInstruction(kind) });
    }

    // --- agentic chat: tool-use loop over the athlete's real data ----------
    // One engine for both transports: plain JSON response, or SSE when
    // body.stream is true (emits {tool} progress events while the loop runs,
    // then the reply, then {done}).
    if (mode === "chat") {
      const auth = req.headers.get("Authorization") ?? "";

      const runAgentic = async (
        onTool?: (name: string) => void,
        // Present only on the streaming transport with a client new enough to
        // understand resets (streamProtocol >= 2). Absent means today's
        // behaviour: buffer the whole turn, emit one token event at the end.
        stream?: { onDelta: (t: string) => void; onToolStart: () => void },
      ) => {
        const toolsUsed: string[] = [];
        // A remember call is a stronger signal a durable fact just changed than
        // any regex on the user's message text — see rememberCalled below.
        let rememberCalledThisTurn = false;
        // update_app_settings changes ride back to the device with the reply
        // (they live in the phone's DataStore, so only the app can apply them).
        const settingsChanges: AppSettingChange[] = [];
        let provider: LlmProvider | string = chain[0] ?? "";
        // Token usage summed across every LLM call this turn made (native loop +
        // JSON-protocol steps + the anti-stall retry) → logged for cost tracking.
        let promptTokens = 0;
        let completionTokens = 0;
        // The agentic loop is where prompt caching pays off (one turn resends
        // the same ~4,800-token system+tools prefix on every step), so its
        // cache totals ride along to generation_logs with the rest of usage.
        let cacheWriteTokens = 0;
        let cacheReadTokens = 0;
        let model = "";
        // Shared by every leg of this turn, including the anti-stall replay.
        const spendGuard = callBudget(MAX_LLM_CALLS_PER_TURN);
        // State-changing tools are made idempotent within a turn: the native
        // loop can fire a write tool and then exhaust maxSteps (returning empty
        // text), which makes generateOnce replay the JSON protocol from the
        // original thread and call the same tool again. Returning the first
        // observation instead of re-executing prevents the double-write.
        const writeCache = new Map<string, Promise<string>>();
        // Reads are memoized for the turn too. Measured across 69 real turns,
        // 28 of 181 read calls were EXACT duplicates within a single turn (the
        // same get_profile or get_fitness twice), and each one costs a provider
        // round trip plus roughly 6k prompt tokens, because every later leg
        // re-sends the whole observation list.
        //
        // Cleared by any write: a cached get_planned_week served after plan_week
        // ran would hand the model a week that no longer exists, which is the
        // exact class of bug this session has been chasing. Correctness first,
        // saving second.
        const readCache = new Map<string, Promise<string>>();
        const exec = (name: string, targs: Record<string, unknown>) => {
          const isWrite = WRITE_TOOLS.has(name);
          const writeKey = isWrite ? `${name}:${JSON.stringify(targs)}` : null;
          if (writeKey) {
            const prior = writeCache.get(writeKey);
            if (prior) { log.warn("dedup_write", { tool: name }); return prior; }
          }
          const readKey = name.startsWith("get_") ? `${name}:${JSON.stringify(targs)}` : null;
          if (readKey) {
            const prior = readCache.get(readKey);
            if (prior) {
              log.info("dedup_read", { tool: name });
              // Still counted as used: it is what the coach consulted, and the
              // progress row and follow-up chips both read this list.
              toolsUsed.push(name);
              try { onTool?.(name); } catch { /* never block on UI events */ }
              return prior;
            }
          }
          // A write invalidates everything read before it.
          if (isWrite) readCache.clear();
          toolsUsed.push(name);
          if (name === "remember") rememberCalledThisTurn = true;
          try { onTool?.(name); } catch { /* never block on UI events */ }
          // Device-applied settings: validate here, queue for the reply, and
          // hand the model an observation it can report as done.
          const obs = name === "update_app_settings"
            ? (() => {
              const { changes, rejected } = validateAppSettings(targs);
              settingsChanges.push(...changes);
              return Promise.resolve(JSON.stringify({
                ok: changes.length > 0,
                applied_on_device: changes,
                ...(rejected.length ? { rejected } : {}),
              }));
            })()
            // clientToday, not today: a write must only be refused for being in
            // the past when we KNOW the athlete's date. With the UTC fallback,
            // executeTool applies a day of slack instead.
            : executeTool(admin, userId, auth, name, targs, clientToday ?? undefined);
          if (writeKey) writeCache.set(writeKey, obs);
          if (readKey) readCache.set(readKey, obs);
          return obs;
        };

        // Resolve the native-tool provider once — independent of the thread, so
        // the stall retry reuses it without re-resolving keys.
        let keyedProvider: LlmProvider | null = null;
        let keyedKey: string | null = null;
        for (const pr of chain) {
          const k = await resolveKey(pr);
          if (k) { keyedProvider = pr; keyedKey = k; break; }
        }

        // One full agentic pass over a thread → the model's reply text. Prefers
        // the provider's NATIVE tool-calling API (far more reliable than the JSON
        // action protocol); Gemini/custom and any native-loop error fall through
        // to the JSON protocol. Tool side effects accumulate into toolsUsed.
        const generateOnce = async (thread: ChatMessage[]): Promise<string> => {
          let replyText = "";
          if (keyedProvider && keyedKey && supportsNativeTools(keyedProvider) && !spendGuard.exhausted()) {
            try {
              const out = await runNativeToolLoop({
                provider: keyedProvider,
                apiKey: keyedKey,
                model: resolveModel(keyedProvider),
                systemPrompt: `${COACH_SYSTEM_PROMPT}\n\n${context}${NATIVE_TOOL_PREAMBLE}`,
                messages: trimThread(thread),
                tools: nativeToolDefs(),
                exec,
                // Never let this leg alone outspend what's left of the turn.
                maxSteps: Math.min(NATIVE_MAX_STEPS, spendGuard.remaining()),
                hosted,
                feature: "chat",
                stream: !!stream,
                onDelta: stream?.onDelta,
                onToolStart: stream?.onToolStart,
              });
              spendGuard.spend(out.steps);
              provider = keyedProvider;
              replyText = out.text;
              promptTokens += out.promptTokens;
              completionTokens += out.completionTokens;
              cacheWriteTokens += out.cacheWriteTokens ?? 0;
              cacheReadTokens += out.cacheReadTokens ?? 0;
              model = out.model;
            } catch (e) {
              // Native tool-calling silently degrading to the JSON protocol is a
              // real quality cliff — surface why instead of swallowing it.
              log.warn("native_tools_failed", {
                provider: keyedProvider,
                err: e instanceof Error ? e.message : String(e),
              });
            }
          }

          const chatSystem = `${COACH_SYSTEM_PROMPT}\n\n${context}${TOOL_PROTOCOL}`;
          const work: ChatMessage[] = trimThread(thread);
          for (let step = 0; !replyText.trim() && step < PROTOCOL_MAX_STEPS; step++) {
            if (spendGuard.exhausted()) break;
            const step_out = await llmGenerateWithFallback(
              chain, { messages: work, systemPrompt: chatSystem, jsonMode: true, hosted, feature: "chat" }, resolveKey, resolveModel, resolveBaseUrl,
            );
            spendGuard.spend();
            provider = step_out.provider;
            promptTokens += step_out.promptTokens;
            completionTokens += step_out.completionTokens;
            cacheWriteTokens += step_out.cacheWriteTokens ?? 0;
            cacheReadTokens += step_out.cacheReadTokens ?? 0;
            model = step_out.model;
            let parsed: Record<string, unknown> | null = null;
            try { parsed = extractJson<Record<string, unknown>>(step_out.text); } catch { parsed = null; }

            // Model replied (or returned non-JSON prose) → that's the answer.
            if (!parsed || parsed.action === "final" || typeof parsed.message === "string") {
              replyText = (parsed?.message as string) ?? (parsed?.reply as string) ?? step_out.text;
              break;
            }
            // Tool call → run it and feed back the observation.
            if (parsed.action === "tool" && typeof parsed.tool === "string") {
              const obs = await exec(parsed.tool, (parsed.args ?? {}) as Record<string, unknown>);
              work.push({ role: "assistant", content: JSON.stringify(parsed) });
              work.push({ role: "user", content: `OBSERVATION from ${parsed.tool}: ${obs}` });
              continue;
            }
            // Unknown shape — surface whatever text came back.
            replyText = step_out.text;
            break;
          }
          return replyText;
        };

        let replyText = await generateOnce(messages);

        // Anti-stall guard: the model sometimes PROMISES a change ("I'll adjust
        // your plan") or, worse, REPORTS one it never made ("I moved tomorrow's
        // run to Saturday"), and ends the turn without calling any write tool.
        // Both are the "it talks but never does it" failure; the past-tense one
        // is the more damaging, since the athlete believes their plan changed.
        // Give it ONE corrective turn to act now or finalize cleanly. Capped at
        // a single retry and gated on no write-tool having run, so it can't loop
        // or pile onto rate limits.
        if (
          !toolsUsed.some((t) => WRITE_TOOLS.has(t)) && talksWithoutActing(replyText) &&
          !spendGuard.exhausted()
        ) {
          const corrected: ChatMessage[] = [
            ...messages,
            { role: "assistant", content: replyText },
            { role: "user", content: STALL_NUDGE },
          ];
          const retry = await generateOnce(corrected);
          if (retry.trim()) replyText = retry;
        }

        replyText = cleanReply(replyText);
        if (!replyText.trim()) replyText = "I gathered your data but need a bit more to act, what would you like me to do?";

        // Log this turn's LLM spend (feature=chat) — the agentic loop's calls were
        // previously invisible in the diagnostics. Background; never blocks the reply.
        log.info("turn_done", {
          llmCalls: spendGuard.used(),
          budget: MAX_LLM_CALLS_PER_TURN,
          tools: toolsUsed.length,
          promptTokens,
          completionTokens,
        });
        if (promptTokens + completionTokens > 0) {
          waitUntil(logGeneration(admin, userId, {
            feature: "chat",
            hosted,
            provider,
            model,
            promptTokens,
            completionTokens,
            cacheWriteTokens,
            cacheReadTokens,
            profile,
            toolsUsed,
          }));
        }
        return { replyText, toolsUsed, provider, settingsChanges, rememberCalledThisTurn };
      };

      // Incognito turns leave no trace: no conversation row, no knowledge
      // update, no summary. The reply itself still uses the full profile.
      const incognito = body.incognito === true;

      const persistThread = async (replyText: string, rememberCalled: boolean): Promise<string | null> => {
        if (incognito) return null;
        const fullThread = [...messages, { role: "assistant", content: replyText }];
        let convId: string | null = body.conversationId ?? null;
        try {
          if (convId) {
            await admin.from("coach_conversations").update({ messages: fullThread }).eq("id", convId).eq("user_id", userId);
          } else {
            const { data: conv } = await admin.from("coach_conversations").insert({
              user_id: userId, title: messages[0]?.content?.slice(0, 60) ?? "Coaching chat",
              messages: fullThread, purpose: body.purpose ?? "setup",
            }).select("id").single();
            convId = conv?.id ?? null;
          }
        } catch { /* best effort */ }
        // hosted + pricing must ride along: these fire real LLM calls on the
        // same key this turn used, and hosted_spend() meters what they cost.
        const bundle = { chain, resolveKey, resolveModel, resolveBaseUrl, hosted, pricing: profile };
        const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
        const userTurns = (fullThread as ChatMessage[]).filter((m) => m.role === "user").length;
        // A remember call this turn forces reconciliation too, regardless of
        // whether the user's message text happens to match a hint/self-
        // statement regex — otherwise a contradicting fact saved via `remember`
        // can sit unreconciled in coach_knowledge (injected as "HARD RULES" into
        // every future prompt) until an unrelated trigger next fires.
        if (shouldUpdateKnowledge(lastUser, userTurns) || rememberCalled) {
          // Slow secondary LLM call — never block the response on it.
          waitUntil(updateUserDoc(admin, userId, fullThread as ChatMessage[], bundle));
        }
        // Fold any turns now archived out of the active window into the running
        // summary — background, so the next turn stays coherent for free.
        const { dropped } = compressThread(fullThread as ChatMessage[]);
        if (dropped.length && convId) {
          waitUntil((async () => {
            const s = await summarizeDropped(admin, userId, dropped, bundle);
            if (s) await admin.from("coach_conversations").update({ summary: s }).eq("id", convId).eq("user_id", userId);
          })());
        }
        return convId;
      };

      if (body.stream) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (obj: unknown) => {
              try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { /* disconnected */ }
            };
            // The agentic loop can think for a long time before it has anything
            // to say, and to a socket "quiet" is indistinguishable from "dead" —
            // that silence is what tripped the client's read timeout. An SSE
            // comment keeps the connection warm and costs nothing: clients skip
            // every line that isn't "data:", so old builds ignore it too.
            const ping = setInterval(() => {
              try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* disconnected */ }
            }, HEARTBEAT_MS);
            try {
              // Protocol 1 clients concatenate {token} events but silently
              // ignore {reset}, which the invariant below can still emit. So
              // this stays opt-in by version: an old APK keeps exactly the
              // buffer-then-one-token behaviour, and this function can deploy
              // before the app ships.
              const proto = Number(body.streamProtocol) || 1;
              const spec = proto >= 2
                ? finalLegStream((e) => send(e.reset ? { reset: true } : { token: e.text }))
                : null;
              // Deltas go through the same dash rule cleanReply applies to the
              // finished reply. Without this the two disagree on almost every
              // reply and the invariant below resets each one, which would make
              // streaming visibly worse than not streaming.
              const scrub = dashScrubber(stripDashes);

              const { replyText, toolsUsed, provider, settingsChanges, rememberCalledThisTurn } =
                await runAgentic(
                  (name) => send({ tool: name }),
                  spec
                    ? {
                      onDelta: (t) => spec.onDelta(scrub.push(t)),
                      onToolStart: () => spec.onToolStart(),
                    }
                    : undefined,
                );

              if (spec) {
                spec.onDelta(scrub.flush());
                spec.endMessage();
                // INVARIANT: what the client displays must equal what gets
                // persisted. replyText has been through cleanReply (fence
                // stripping, JSON unwrapping, dash removal) and the empty-reply
                // fallback, none of which the raw deltas went through, so the
                // two can legitimately differ. Reconcile rather than hope.
                if (spec.committed() !== replyText) {
                  send({ reset: true });
                  send({ token: replyText });
                }
                if (spec.discarded() > 0) log.info("stream_discarded", { chars: spec.discarded() });
              } else {
                send({ token: replyText });
              }
              const saveAndFinish = (async () => {
                const convId = await persistThread(replyText, rememberCalledThisTurn);
                send({
                  done: true,
                  conversation_id: convId,
                  provider,
                  tools_used: toolsUsed,
                  ...(settingsChanges.length ? { settings_changes: settingsChanges } : {}),
                });
                try { controller.close(); } catch { /* already closed */ }
              })();
              waitUntil(saveAndFinish);
              await saveAndFinish;
            } catch (e) {
              send({ error: String(e instanceof Error ? e.message : e) });
              try { controller.close(); } catch { /* already closed */ }
            } finally {
              clearInterval(ping);
            }
          },
        });
        return new Response(stream, {
          headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }

      const { replyText, toolsUsed, provider, settingsChanges, rememberCalledThisTurn } = await runAgentic();
      const convId = await persistThread(replyText, rememberCalledThisTurn);
      return json({
        reply: replyText,
        conversation_id: convId,
        provider,
        tools_used: toolsUsed,
        ...(settingsChanges.length ? { settings_changes: settingsChanges } : {}),
      });
    }

    const outcome = await llmGenerateWithFallback(
      chain,
      { messages: turns, systemPrompt, jsonMode: mode === "finalize", hosted, feature: mode === "finalize" ? "finalize" : "chat" },
      resolveKey,
      resolveModel,
      resolveBaseUrl,
    );
    // Logged by the helper; also recomputed here because the response reports it.
    const cost = estimateCostUsd(
      outcome.provider, outcome.promptTokens, outcome.completionTokens,
      customPriceFromProfile(outcome.provider, profile), outcome.model,
    );
    waitUntil(logLlmResult(admin, userId, mode === "finalize" ? "finalize" : "chat", hosted, outcome, profile));

    // --- persist the conversation thread -----------------------------------
    const fullThread = [...messages, { role: "assistant", content: outcome.text }];
    let conversationId: string | null = body.conversationId ?? null;
    if (conversationId) {
      await admin.from("coach_conversations")
        .update({ messages: fullThread })
        .eq("id", conversationId).eq("user_id", userId);
    } else {
      const { data: conv } = await admin.from("coach_conversations")
        .insert({
          user_id: userId,
          title: messages[0]?.content?.slice(0, 60) ?? "Coaching chat",
          messages: fullThread,
          purpose: body.purpose ?? "plan",
        })
        .select("id").single();
      conversationId = conv?.id ?? null;
    }

    if (mode !== "finalize") {
      // Maintain durable knowledge when the latest turn plausibly carries a fact.
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const userTurns = (fullThread as ChatMessage[]).filter((m) => m.role === "user").length;
      if (shouldUpdateKnowledge(lastUser, userTurns)) {
        // Slow secondary LLM call — don't block the reply on it.
        waitUntil(updateUserDoc(admin, userId, fullThread as ChatMessage[], { chain, resolveKey, resolveModel, resolveBaseUrl, hosted, pricing: profile }));
      }
      return json({ reply: outcome.text, conversation_id: conversationId, provider: outcome.provider, estimated_cost_usd: cost });
    }

    // --- finalize: parse + (optionally) save the template ------------------
    let template;
    try {
      template = extractJson<Record<string, unknown>>(outcome.text);
    } catch (e) {
      return json({ error: "could not parse template", detail: String(e), raw: outcome.text }, 422);
    }

    let templateId: string | null = null;
    if (body.save) {
      const { data: saved } = await admin.from("workout_templates").insert({
        user_id: userId,
        name: String(template.name ?? "Coaching template"),
        description: String(template.description ?? ""),
        kind: String(template.kind ?? "workout"),
        structure: template.structure ?? template,
        source_conversation_id: conversationId,
      }).select("id").single();
      templateId = saved?.id ?? null;
    }

    return json({
      template,
      template_id: templateId,
      conversation_id: conversationId,
      provider: outcome.provider,
      estimated_cost_usd: cost,
    });
  } catch (e) {
    log.error("failed", { err: e instanceof Error ? e.message : String(e) });
    return json({ error: e instanceof Error ? e.message : String(e) }, errorStatus(e));
  }
});
