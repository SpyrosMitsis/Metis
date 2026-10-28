import { assert, assertEquals } from "jsr:@std/assert@1";
import { dailyPlanReply, dailyPlanToolAllowed, failedCoachActionReply, isDailyPlanQuestion, PLAN_MUTATION_TOOLS } from "./coach_turn.ts";
import { nativeToolDefs, TOOL_CATALOG, toolCatalogPrompt } from "./coach_tools.ts";

Deno.test("daily information questions cannot reuse old planning intent", () => {
  for (const text of ["What should I do today?", "Today?", "Today’s workout?", "Can I train today?", "What do I need to do today?", "What's my workout today?", "Show today's plan", "Explain today's workout", "What should I train this evening?", "Why did you generate a workout today?", "What should I do today? Do not create a workout."]) assert(isDailyPlanQuestion(text), text);
  for (const text of ["Make me today's workout", "Generate a cycling workout today", "What should I do today? Please replace my workout", "Move today's workout to Friday", "Adjust my workout today for less available time", "Plan my full week", "Yes, apply that", "Continue"]) assertEquals(isDailyPlanQuestion(text), false, text);
});

Deno.test("both tool transports omit calendar edits for daily explanations, with an executor backstop", () => {
  const catalog = TOOL_CATALOG.filter(t => dailyPlanToolAllowed(t.name, true));
  const native = nativeToolDefs(catalog).map(t => t.name);
  const protocol = toolCatalogPrompt(catalog);
  assert(native.includes("get_today_plan"));
  assert(native.includes("report_injury"), "a volunteered injury must still be recordable");
  assertEquals(dailyPlanToolAllowed("set_goal_race", true), false);
  assertEquals(dailyPlanToolAllowed("update_profile", true), false);
  for (const name of PLAN_MUTATION_TOOLS) {
    assert(!native.includes(name), name);
    assert(!protocol.includes(`- ${name}(`), name);
    assertEquals(dailyPlanToolAllowed(name, true), false);
    assertEquals(dailyPlanToolAllowed(name, false), true);
  }
});

Deno.test("daily fallback respects rest, completion, skipped work, doubles and unreadable calendars", () => {
  const session={type:"run",workout:{title:"Easy run",duration_minutes:20}};
  assert(dailyPlanReply(JSON.stringify({sessions:[session]})).includes("Easy run"));
  assert(dailyPlanReply(JSON.stringify({sessions:[{type:"rest"}]})).includes("recovery day"));
  assert(dailyPlanReply(JSON.stringify({sessions:[{...session,completed:true}]})).includes("no remaining"));
  assert(dailyPlanReply(JSON.stringify({sessions:[{...session,skipped:true}]})).includes("no remaining"));
  const double=dailyPlanReply(JSON.stringify({sessions:[session,{type:"strength",workout:{title:"Strength training",duration_minutes:30}}]}));
  assert(double.includes("Easy run") && double.includes("Strength training"));
  assert(dailyPlanReply(JSON.stringify({sessions:[]})).includes("haven't created"));
  assert(dailyPlanReply(JSON.stringify({error:"offline",sessions:[]})).includes("couldn't read"));
});

Deno.test("failed action summaries explain relevant constraints without leaking raw diagnostics", () => {
  const raw='{"error":"Unavailable implements for Elliptical","headers":"secret"}';
  const message=failedCoachActionReply([raw]);
  assert(message.includes("saved equipment"));assert(!message.includes("secret"));
  assert(failedCoachActionReply(['{"error":"injury restriction"}']).includes("training restrictions"));
});
