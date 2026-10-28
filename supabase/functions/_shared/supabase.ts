// ============================================================================
// Server-side Supabase clients + secret encryption helpers.
//
// `adminClient()` uses the service_role key and bypasses RLS — use it only in
// trusted server code after you have resolved the acting user id.
//
// Secrets (Intervals + LLM keys) are encrypted/decrypted via the SQL helpers
// `encrypt_secret` / `decrypt_secret`, which read the symmetric key from the
// `app.encryption_key` GUC. We set that GUC per-call from the ENCRYPTION_KEY
// Edge Function secret so the key never lives in the database.
// ============================================================================

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

// Resolve the user id from the caller's JWT (Authorization: Bearer <jwt>).
export async function getUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}

function encKey(): string {
  const k = Deno.env.get("ENCRYPTION_KEY");
  if (!k) throw new Error("ENCRYPTION_KEY env var is not set");
  return k;
}

// Encrypt a plaintext secret via the DB (pgcrypto). Returns base64 ciphertext.
export async function encryptSecret(admin: SupabaseClient, plaintext: string): Promise<string> {
  const { data, error } = await admin.rpc("encrypt_for_app", {
    p_key: encKey(),
    p_plaintext: plaintext,
  });
  if (error) throw new Error(`encryptSecret: ${error.message}`);
  return data as string;
}

export async function decryptSecret(admin: SupabaseClient, ciphertext: string): Promise<string | null> {
  if (!ciphertext) return null;
  const { data, error } = await admin.rpc("decrypt_for_app", {
    p_key: encKey(),
    p_ciphertext: ciphertext,
  });
  if (error) throw new Error(`decryptSecret: ${error.message}`);
  return data as string | null;
}

// ---------------------------------------------------------------------------
// Vetted user_profiles column sets.
//
// Three functions used to `select("*")` this row. That pulls every column the
// table has ever grown, including ones the caller never reads: the Play
// purchase token, the Intervals API-key hint, billing state, and the unbounded
// coach_soul / training_memory / coach_knowledge text that grows with use. It
// is bandwidth on every generation, and it puts a payment secret in the memory
// of five functions that have no business holding one.
//
// These lists are shared rather than written per call site on purpose: the risk
// with narrowing a select is missing a field, and the failure mode is a silent
// `undefined` rather than an error. One vetted list means one place to audit
// and no per-file drift. Note the columns are NOT optional extras: they are the
// union of what each caller reads directly AND what the shared helpers it
// passes the row to read (llmAccess, memoryFromProfile, intervalsPhysiology,
// customPriceFromProfile, knowledgeBlock, logLlmResult).
//
// ADDING A FIELD: if you make a generator read a new profile column, add it
// here too, or it will read as undefined at runtime with nothing to catch it.
// ---------------------------------------------------------------------------

/**
 * The row these column sets select.
 *
 * Deliberately loose, and only partly for convenience: `select("*")` gave the
 * callers an untyped row and they already cast per field, so tightening this
 * would be a separate change. What it is really for is supabase-js, which
 * infers a row shape only from an INLINE literal select string. Handed a shared
 * constant it infers `GenericStringError` instead and every downstream use
 * fails to compile, which is the price of not duplicating the column list five
 * times. This is that price, paid once.
 */
// deno-lint-ignore no-explicit-any
export type ProfileRow = Record<string, any>;

/** Everything the workout/week generators and their shared helpers read. */
export const PROFILE_COLUMNS_GENERATION = [
  "id",
  "display_name",
  "onboarding",
  // Intervals.icu push + physiology (intervalsPhysiology, createEvent/deleteEvent).
  "intervals_athlete_id",
  "intervals_api_key_encrypted",
  // Hosted entitlement must survive the narrowed projection passed to llmAccess.
  "plan",
  "plan_expires_at",
  "use_hosted_ai",
  // Provider selection and BYO pricing (llmAccess, customPriceFromProfile).
  "active_llm_provider",
  "llm_fallback_chain",
  "llm_models",
  "llm_custom_input_per_1m",
  "llm_custom_output_per_1m",
  // Agent memory documents (memoryFromProfile, knowledgeBlock).
  "coach_knowledge",
  "training_memory",
  "coach_soul",
  "coach_soul_updated_at",
  // Structured overrides that outrank the prompt.
  "training_paused_until",
  "training_pause_reason",
  "injury_backoff",
  // Weather lookups for outdoor sessions.
  "last_lat",
  "last_lon",
].join(", ");

/** What the post-session analyzer reads: onboarding, Intervals, LLM access. */
export const PROFILE_COLUMNS_ANALYSIS = [
  "id",
  "onboarding",
  "intervals_athlete_id",
  "intervals_api_key_encrypted",
  "active_llm_provider",
  "llm_fallback_chain",
  "llm_models",
  "llm_custom_input_per_1m",
  "llm_custom_output_per_1m",
].join(", ");
