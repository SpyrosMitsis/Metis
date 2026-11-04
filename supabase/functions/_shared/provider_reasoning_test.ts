import { assertEquals } from "jsr:@std/assert@1";
import { deepseekBodyExtras } from "./llm.ts";
Deno.test("OpenRouter DeepSeek weekly generation disables reasoning output", () => {
  assertEquals(deepseekBodyExtras("openrouter", "deepseek/deepseek-v4.1-flash"), { reasoning: { enabled: false } });
  assertEquals(deepseekBodyExtras("openai", "gpt-5-mini"), {});
});
