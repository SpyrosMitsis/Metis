import { adminClient, getUserId } from "../_shared/supabase.ts";
import { handleOptions, json } from "../_shared/cors.ts";
import { drainCalendarOutbox } from "../_shared/calendar_outbox.ts";
Deno.serve(async req => {
  const pre = handleOptions(req); if (pre) return pre;
  const body=await req.json().catch(()=>({}));
  const admin=adminClient();
  if (body?.all_users) {
    if (req.headers.get("Authorization") !== `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) return json({error:"unauthorized"},401);
    const {data: rows,error}=await admin.from("calendar_outbox").select("user_id").is("finished_at",null).limit(500);
    if (error) return json({error:error.message},500);
    const owners=[...new Set((rows??[]).map(r=>r.user_id))];
    const results=[];
    for (const id of owners) results.push({user_id:id,...await drainCalendarOutbox(admin,id)});
    return json({processed:results.length,results});
  }
  const owner = await getUserId(req); if (!owner) return json({error:"unauthorized"},401);
  return json(await drainCalendarOutbox(admin,owner));
});
