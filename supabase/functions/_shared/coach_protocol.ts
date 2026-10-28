// Models sometimes emit the JSON tool protocol as native-tool prose. Treat
// whole protocol payloads as control messages, never as a finished answer.
export interface CoachToolRequest {
  action: "tool";
  tool: string;
  args: Record<string, unknown>;
}

export function toolRequests(text: string): CoachToolRequest[] | null {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!/^[{[]/.test(raw)) return null;
  let entries: unknown[];
  try {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Adjacent objects / JSONL, including nested arguments and escaped quotes.
    entries = [];
    let start = 0, depth = 0, quoted = false, escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (--depth < 0) return null;
        if (depth === 0) {
          try { entries.push(JSON.parse(raw.slice(start, i + 1))); } catch { return null; }
          start = i + 1;
        }
      } else if (depth === 0 && !/\s/.test(c)) return null;
    }
    if (depth !== 0 || quoted || raw.slice(start).trim()) return null;
  }
  if (!entries.length || entries.length > 8) return null;
  const requests: CoachToolRequest[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const o = entry as Record<string, unknown>;
    if (o.action !== "tool" || typeof o.tool !== "string" || !o.tool.trim()) return null;
    const args = o.args ?? {};
    if (typeof args !== "object" || !args || Array.isArray(args)) return null;
    requests.push({ action: "tool", tool: o.tool, args: args as Record<string, unknown> });
  }
  return requests;
}

export function isToolProtocol(text: string): boolean {
  return /"action"\s*:\s*"tool"/.test(text);
}

/** Attempts, errors, raw HTTP bodies and empty observations prove no write. */
export function toolWriteSucceeded(observation: string): boolean {
  try {
    const o = JSON.parse(observation);
    return o?.ok === true && !o.error;
  } catch { return false; }
}
