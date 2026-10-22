// Fallback fitness (CTL/ATL) computed from stored TSS.
//
// Intervals.icu-synced activity rows already carry ctl/atl; rows ingested from
// Health Connect or logged manually don't. When a fetched window has no
// intervals-provided ctl at all, we reconstruct the standard EWMAs from the
// per-day TSS the app stored, so the TSB sparkline, goal tracking, and the
// prompts' fitness lines keep working for athletes without intervals.icu.
//
// Seeding: the series starts at 0 on the first activity in the window, so CTL
// (42-day time constant) reads slightly low until ~2-3 months of history exist.
// That's acceptable for a fallback signal — it's directionally right and
// converges as history accrues.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface FitnessPoint {
  ctl: number;
  atl: number;
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Standard CTL/ATL EWMAs from dated TSS values: bucket tss per calendar day,
 * walk day by day from the earliest row to `endDate` (days without activity
 * count as 0 tss), ctl += (tss - ctl)/42 and atl += (tss - atl)/7, seeded at 0.
 * Returns a per-date map; empty when there's no usable input.
 */
export function fitnessFromTss(
  rows: { date?: string | null; tss?: number | null }[],
  endDate: string,
): Map<string, FitnessPoint> {
  const out = new Map<string, FitnessPoint>();
  const byDay = new Map<string, number>();
  for (const r of rows) {
    if (!r.date || r.date > endDate) continue;
    byDay.set(r.date, (byDay.get(r.date) ?? 0) + (r.tss ?? 0));
  }
  if (!byDay.size) return out;
  const first = [...byDay.keys()].reduce((a, b) => (a < b ? a : b));
  // Noon-UTC keeps the day-by-day walk off DST/tz edges (same trick as
  // daily-summary's window arithmetic).
  const startMs = new Date(first + "T12:00:00Z").getTime();
  const endMs = new Date(endDate + "T12:00:00Z").getTime();
  let ctl = 0;
  let atl = 0;
  for (let ms = startMs; ms <= endMs; ms += DAY) {
    const date = iso(ms);
    const tss = byDay.get(date) ?? 0;
    ctl += (tss - ctl) / 42;
    atl += (tss - atl) / 7;
    out.set(date, { ctl: round1(ctl), atl: round1(atl) });
  }
  return out;
}

/**
 * Annotate fetched completed_activities rows with fallback ctl/atl.
 *
 * No-op when the window is empty or any row already has ctl (intervals data
 * wins; mixed windows are left alone). Otherwise fetches the athlete's 90-day
 * TSS series — one extra query, only for fallback users — computes the EWMAs,
 * and fills each row's ctl/atl by date. Best-effort: returns the input
 * unchanged on any failure.
 */
export async function applyFallbackFitness<
  T extends { date?: string | null; tss?: number | null; ctl?: number | null; atl?: number | null },
>(
  admin: SupabaseClient,
  userId: string,
  endDate: string,
  rows: T[],
): Promise<T[]> {
  if (!rows.length || rows.some((r) => r.ctl != null)) return rows;
  try {
    const since = iso(new Date(endDate + "T12:00:00Z").getTime() - 90 * DAY);
    const { data } = await admin.from("effective_activities")
      .select("date, tss")
      .eq("user_id", userId).gte("date", since).lte("date", endDate);
    const series = fitnessFromTss(data ?? [], endDate);
    if (!series.size) return rows;
    return rows.map((r) => {
      const p = r.date ? series.get(r.date) : undefined;
      return p ? { ...r, ctl: p.ctl, atl: p.atl } : r;
    });
  } catch (_e) {
    return rows; // best-effort — degraded fitness beats a broken endpoint
  }
}
