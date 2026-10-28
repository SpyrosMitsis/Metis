/** Questions about the current plan must not become calendar-edit requests.
 * This guard is deliberately narrow; explicit changes still use the agent. */
export function isDailyPlanQuestion(message: string): boolean {
  const text = message.toLowerCase().replace(/[’]/g, "'");
  if (!/\b(today|tonight|this morning|this afternoon|this evening)\b/.test(text)) return false;
  if (/^\s*(today|tonight|today'?s (workout|session|plan)|(my )?(workout|plan|session)( for)? today)\s*[?.!]*$/.test(text)) return true;
  if (/\b(don't|do not|without)\b.{0,30}\b(create|generat|replac|chang|schedul|replan)/.test(text)) return true;
  if (/^\s*(why|how|what)\b.{0,35}\b(did|have|was|were)\b/.test(text) && !/\b(and|please|can you)\s+(create|generate|replace|change|move|adjust)\b/.test(text)) return true;
  if (/\b(create|generate|regenerate|replace|reschedule|replan|move|swap|shorten|cancel|delete)\b|\b(make (me|my|it)|plan (my|me)|put .{0,30}calendar|apply (it|that|the|these)|adjust (it|my|the)|change (it|my|the)|make .{0,20}(easier|harder))\b/.test(text)) return false;
  return /\b(what|which|why|how|explain|show|tell|check|review|do i|am i|can i|should i)\b/.test(text);
}

export const PLAN_MUTATION_TOOLS = new Set([
  "plan_week", "generate_workout", "move_workout", "set_rest_day", "make_easier",
  "apply_adaptation", "undo_adaptation", "set_training_pause", "resume_training",
]);

export function dailyPlanToolAllowed(name: string, readOnly: boolean): boolean {
  // Safety disclosures still need structured recording; ordinary informational
  // turns have no permission to edit goals, preferences or the calendar.
  return !readOnly || name.startsWith("get_") || name === "preview_adaptation" || name === "assess_goal" ||
    ["report_injury", "update_injury_status", "set_injury_backoff", "clear_injury_backoff"].includes(name);
}

/** Grounded fallback when a provider stalls, emits tool prose, or claims a write. */
export function dailyPlanReply(observation: string): string {
  try {
    const result = JSON.parse(observation);
    if (result.error) return "I couldn't read today's calendar. I haven't changed it. Please refresh the calendar before deciding what to train.";
    const sessions = Array.isArray(result.sessions) ? result.sessions : [];
    const remaining = sessions.filter((s: { completed?: boolean; skipped?: boolean }) => !s.completed && !s.skipped);
    if (!remaining.length) return sessions.length
      ? "Today's scheduled sessions are already completed or skipped. There is no remaining planned workout; I haven't added another session."
      : "There is no workout scheduled for today. I haven't created one. I can build one if you ask me to.";
    return remaining.map((s: { type?: string; workout?: { title?: string; duration_minutes?: number; coach_note?: string } }) => {
      if (s.type === "rest") return "Today is a planned recovery day. You don't need to add a workout.";
      const w = s.workout;
      return `Today: ${w?.title || s.type || "your scheduled workout"}${w?.duration_minutes ? `, about ${Math.round(w.duration_minutes)} minutes` : ""}. Follow the saved warm-up and main work in your calendar.`;
    }).join("\n\n");
  } catch { return "I couldn't read today's plan reliably. I haven't changed your calendar."; }
}

/** Keep failure messages useful without exposing raw SQL, headers or secrets. */
export function failedCoachActionReply(observations: string[]): string {
  const text = observations.join(" ");
  if (/unavailable implements|equipment|catalog/i.test(text)) return "I couldn't build the requested workout using your saved equipment and exercises. I haven't confirmed a replacement; your existing workout is still available in the calendar.";
  if (/locked|protected|completed/i.test(text)) return "The requested change conflicts with a protected or completed session. I haven't confirmed a replacement; check the existing session in your calendar.";
  if (/injur|pain|hold|contraindicat/i.test(text)) return "The requested workout didn't pass your recorded training restrictions. I haven't confirmed a replacement; review the restriction before changing the plan.";
  return "I couldn't confirm the requested calendar change. Check your existing calendar before retrying so you don't replace a session unnecessarily.";
}
