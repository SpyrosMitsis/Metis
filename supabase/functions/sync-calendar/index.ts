import { adminClient, getUserId } from "../_shared/supabase.ts";
import { handleOptions, json } from "../_shared/cors.ts";
import { drainCalendarOutbox } from "../_shared/calendar_outbox.ts";
Deno.serve(async req => {
  const pre = handleOptions(req); if (pre) return pre;
  const owner = await getUserId(req); if (!owner) return json({error:"unauthorized"},401);
  return json(await drainCalendarOutbox(adminClient(),owner));
});
