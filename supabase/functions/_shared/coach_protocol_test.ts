import { assertEquals } from "jsr:@std/assert@1";
import { isToolProtocol, toolRequests, toolWriteSucceeded } from "./coach_protocol.ts";

Deno.test("coach protocol: screenshot's adjacent read requests are executable, not an answer", () => {
  const names = ["get_fitness", "get_readiness", "get_recent_activities", "get_profile", "get_strength_summary"];
  const raw = names.map(tool => JSON.stringify({action:"tool",tool,args:tool === "get_recent_activities" ? {days:14} : {}})).join("\n\n");
  assertEquals(toolRequests(raw)?.map(r => r.tool), names);
  assertEquals(isToolProtocol(raw), true);
});
Deno.test("coach protocol: arrays, fences, nested args and quoted braces survive", () => {
  const action = {action:"tool" as const,tool:"get_profile",args:{note:'literal } and \"quote\"',nested:{days:[1,2]}}};
  for (const raw of [JSON.stringify(action), JSON.stringify([action]), '```json\n'+JSON.stringify(action)+'\n```']) {
    assertEquals(toolRequests(raw), [action]);
  }
  assertEquals(toolRequests(JSON.stringify(action)+'\n'+JSON.stringify(action)), [action, action]);
});
Deno.test("coach protocol: broken or mixed commands cannot partially execute", () => {
  for (const raw of [
    '{"action":"tool","tool":"get_profile","args":[]} ',
    '{"action":"tool","tool":"get_profile"} garbage',
    '[{"action":"tool","tool":"get_profile"},{"action":"final","message":"Done"}]',
    '{"action":"tool","tool":"get_profile","args":',
    Array(9).fill('{"action":"tool","tool":"get_profile"}').join('\n'),
    'Your workout uses {three sets}.',
  ]) assertEquals(toolRequests(raw), null, raw);
});
Deno.test("coach write receipts require explicit confirmed success", () => {
  assertEquals(toolWriteSucceeded('{"ok":true,"week_now":[{"date":"2026-10-27"}]}'), true);
  for (const raw of ['error: unavailable', '{}', '{"ok":false}', '{"ok":true,"error":"not saved"}', '{"status":502}', '{"message":"Unauthorized"}']) {
    assertEquals(toolWriteSucceeded(raw), false, raw);
  }
});
