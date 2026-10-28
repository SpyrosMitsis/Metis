// Canonical strength-exercise catalog — a server-side mirror of the Android
// app's bundled ExerciseCatalog (the list the athlete sees in the logger's
// picker). The AI generators inject this so every prescribed strength exercise
// matches a bundled entry by exact name. Manual custom exercises remain valid
// for logging history, but generation cannot create or prescribe custom entries.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Workout } from "./types.ts";

export interface CatalogExercise {
  name: string;
  muscle: string;
  category: string; // Barbell | Dumbbell | Machine | Cable | Bodyweight | Kettlebell | Cardio
  compound: boolean;
}

const E = (name: string, muscle: string, category: string, compound = false): CatalogExercise =>
  ({ name, muscle, category, compound });

export const EXERCISE_CATALOG: CatalogExercise[] = [
  E("Wall Push-Up", "Chest", "Bodyweight", true),
  E("Resistance Band Row", "Back", "Band", true),
  E("Resistance Band Chest Press", "Chest", "Band", true),
  E("Resistance Band Pull-Apart", "Shoulders", "Band", false),
  E("Resistance Band Bicep Curl", "Biceps", "Band", false),
  E("Resistance Band Lateral Raise", "Shoulders", "Band", false),

  // Additional home and gym variations (mirrored on server and Android).
  E("Incline Push-Up", "Chest", "Bodyweight", true),
  E("Dumbbell Floor Press", "Chest", "Dumbbell", true),
  E("Chest-Supported Dumbbell Row", "Back", "Dumbbell", true),
  E("Assisted Pull-Up", "Back", "Machine", true),
  E("Inverted Row", "Back", "Bodyweight", true),
  E("Pike Push-Up", "Shoulders", "Bodyweight", true),
  E("Dumbbell Shrug", "Shoulders", "Dumbbell"),
  E("Bodyweight Squat", "Quads", "Bodyweight", true),
  E("Reverse Lunge (Bodyweight)", "Quads", "Bodyweight", true),
  E("Split Squat (Bodyweight)", "Quads", "Bodyweight", true),
  E("Reverse Lunge (Dumbbell)", "Quads", "Dumbbell", true),
  E("Romanian Deadlift (Dumbbell)", "Hamstrings", "Dumbbell", true),
  E("Single-Leg Romanian Deadlift (Dumbbell)", "Hamstrings", "Dumbbell", true),
  E("Glute Bridge (Bodyweight)", "Glutes", "Bodyweight", true),
  E("Single-Leg Glute Bridge", "Glutes", "Bodyweight", true),
  E("Hip Thrust (Dumbbell)", "Glutes", "Dumbbell", true),
  E("Standing Calf Raise (Bodyweight)", "Calves", "Bodyweight"),
  E("Single-Leg Calf Raise (Bodyweight)", "Calves", "Bodyweight"),
  E("Standing Calf Raise (Dumbbell)", "Calves", "Dumbbell"),
  E("Side Plank", "Core", "Bodyweight"),
  E("Dead Bug", "Core", "Bodyweight"),
  E("Bird Dog", "Core", "Bodyweight"),
  E("Pallof Press", "Core", "Cable"),
  E("Reverse Crunch", "Core", "Bodyweight"),
  E("Kettlebell Goblet Squat", "Quads", "Kettlebell", true),
  E("Kettlebell Deadlift", "Hamstrings", "Kettlebell", true),
  // ---- Chest ----
  E("Barbell Bench Press", "Chest", "Barbell", true),
  E("Incline Barbell Bench Press", "Chest", "Barbell", true),
  E("Decline Barbell Bench Press", "Chest", "Barbell", true),
  E("Dumbbell Bench Press", "Chest", "Dumbbell", true),
  E("Incline Dumbbell Bench Press", "Chest", "Dumbbell", true),
  E("Dumbbell Fly", "Chest", "Dumbbell"),
  E("Cable Crossover", "Chest", "Cable"),
  E("Pec Deck", "Chest", "Machine"),
  E("Machine Chest Press", "Chest", "Machine", true),
  E("Push-Up", "Chest", "Bodyweight", true),
  E("Dips (Chest)", "Chest", "Bodyweight", true),
  // ---- Back ----
  E("Deadlift", "Back", "Barbell", true),
  E("Barbell Row", "Back", "Barbell", true),
  E("Pendlay Row", "Back", "Barbell", true),
  E("T-Bar Row", "Back", "Barbell", true),
  E("Dumbbell Row", "Back", "Dumbbell", true),
  E("Pull-Up", "Back", "Bodyweight", true),
  E("Chin-Up", "Back", "Bodyweight", true),
  E("Lat Pulldown", "Back", "Cable", true),
  E("Seated Cable Row", "Back", "Cable", true),
  E("Straight-Arm Pulldown", "Back", "Cable"),
  E("Machine Row", "Back", "Machine", true),
  E("Rack Pull", "Back", "Barbell", true),
  // ---- Shoulders ----
  E("Overhead Press", "Shoulders", "Barbell", true),
  E("Seated Dumbbell Press", "Shoulders", "Dumbbell", true),
  E("Arnold Press", "Shoulders", "Dumbbell", true),
  E("Lateral Raise", "Shoulders", "Dumbbell"),
  E("Cable Lateral Raise", "Shoulders", "Cable"),
  E("Front Raise", "Shoulders", "Dumbbell"),
  E("Rear Delt Fly", "Shoulders", "Dumbbell"),
  E("Reverse Pec Deck", "Shoulders", "Machine"),
  E("Face Pull", "Shoulders", "Cable"),
  E("Barbell Shrug", "Shoulders", "Barbell"),
  E("Upright Row", "Shoulders", "Barbell", true),
  // ---- Biceps ----
  E("Barbell Curl", "Biceps", "Barbell"),
  E("EZ-Bar Curl", "Biceps", "Barbell"),
  E("Dumbbell Curl", "Biceps", "Dumbbell"),
  E("Hammer Curl", "Biceps", "Dumbbell"),
  E("Incline Dumbbell Curl", "Biceps", "Dumbbell"),
  E("Preacher Curl", "Biceps", "Machine"),
  E("Cable Curl", "Biceps", "Cable"),
  E("Concentration Curl", "Biceps", "Dumbbell"),
  // ---- Triceps ----
  E("Close-Grip Bench Press", "Triceps", "Barbell", true),
  E("Triceps Pushdown", "Triceps", "Cable"),
  E("Rope Pushdown", "Triceps", "Cable"),
  E("Overhead Cable Extension", "Triceps", "Cable"),
  E("Skullcrusher", "Triceps", "Barbell"),
  E("Dumbbell Overhead Extension", "Triceps", "Dumbbell"),
  E("Dips (Triceps)", "Triceps", "Bodyweight", true),
  E("Bench Dip", "Triceps", "Bodyweight"),
  // ---- Quads ----
  E("Back Squat", "Quads", "Barbell", true),
  E("Front Squat", "Quads", "Barbell", true),
  E("Hack Squat", "Quads", "Machine", true),
  E("Leg Press", "Quads", "Machine", true),
  E("Goblet Squat", "Quads", "Dumbbell", true),
  E("Bulgarian Split Squat", "Quads", "Dumbbell", true),
  E("Walking Lunge", "Quads", "Dumbbell", true),
  E("Leg Extension", "Quads", "Machine"),
  E("Step-Up", "Quads", "Dumbbell", true),
  // ---- Hamstrings ----
  E("Romanian Deadlift", "Hamstrings", "Barbell", true),
  E("Lying Leg Curl", "Hamstrings", "Machine"),
  E("Seated Leg Curl", "Hamstrings", "Machine"),
  E("Nordic Curl", "Hamstrings", "Bodyweight"),
  E("Good Morning", "Hamstrings", "Barbell", true),
  E("Stiff-Leg Deadlift", "Hamstrings", "Barbell", true),
  // ---- Glutes ----
  E("Hip Thrust", "Glutes", "Barbell", true),
  E("Glute Bridge", "Glutes", "Barbell"),
  E("Cable Kickback", "Glutes", "Cable"),
  E("Hip Abduction", "Glutes", "Machine"),
  // ---- Calves ----
  E("Standing Calf Raise", "Calves", "Machine"),
  E("Seated Calf Raise", "Calves", "Machine"),
  E("Leg Press Calf Raise", "Calves", "Machine"),
  // ---- Core ----
  E("Plank", "Core", "Bodyweight"),
  E("Hanging Leg Raise", "Core", "Bodyweight"),
  E("Cable Crunch", "Core", "Cable"),
  E("Ab Wheel Rollout", "Core", "Bodyweight"),
  E("Russian Twist", "Core", "Bodyweight"),
  E("Decline Sit-Up", "Core", "Bodyweight"),
  E("Mountain Climber", "Core", "Bodyweight"),
  // ---- Forearms ----
  E("Wrist Curl", "Forearms", "Barbell"),
  E("Reverse Wrist Curl", "Forearms", "Barbell"),
  E("Farmer's Walk", "Forearms", "Dumbbell", true),
  // ---- Olympic / full body ----
  E("Power Clean", "Full Body", "Barbell", true),
  E("Clean and Jerk", "Full Body", "Barbell", true),
  E("Snatch", "Full Body", "Barbell", true),
  E("Kettlebell Swing", "Full Body", "Kettlebell", true),
  E("Thruster", "Full Body", "Barbell", true),
  E("Burpee", "Full Body", "Bodyweight", true),
  // ---- Cardio ----
  E("Treadmill Run", "Cardio", "Cardio"),
  E("Rowing Machine", "Cardio", "Cardio"),
  E("Assault Bike", "Cardio", "Cardio"),
  E("Stair Climber", "Cardio", "Cardio"),
  E("Elliptical", "Cardio", "Cardio"),
];

export const MUSCLES = [
  "Chest", "Back", "Shoulders", "Biceps", "Triceps",
  "Quads", "Hamstrings", "Glutes", "Calves", "Core", "Forearms", "Full Body", "Cardio",
];

export const CATEGORIES = [
  "Barbell", "Dumbbell", "Machine", "Cable", "Bodyweight", "Kettlebell", "Band", "Cardio",
];

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const catalogByNorm = new Map(EXERCISE_CATALOG.map((e) => [normName(e.name), e]));

// Map the athlete's equipment preference (onboarding.equipment) to the catalog
// CATEGORIES they can actually train with. Returns null for an unknown/blank
// value → callers then DON'T filter (fail open). Equipment tiers are inclusive.
const EQUIPMENT_CATEGORIES: Record<string, string[]> = {
  "resistance bands": ["Bodyweight", "Band"],
  "bodyweight": ["Bodyweight"],
  "dumbbells": ["Bodyweight", "Dumbbell"],
  "barbell + rack": ["Bodyweight", "Dumbbell", "Kettlebell", "Barbell"],
  "full gym": ["Barbell", "Dumbbell", "Machine", "Cable", "Bodyweight", "Kettlebell", "Cardio"],
};

export function allowedCategories(equipment: string | null | undefined): Set<string> | null {
  if (!equipment || !equipment.trim()) return null;
  const cats = EQUIPMENT_CATEGORIES[equipment.trim().toLowerCase()];
  return cats ? new Set(cats) : null;
}

// The catalog category for a (possibly reworded) exercise name, or null if the
// name isn't a known catalog lift — unknown names are not equipment-filtered.
export function categoryOfExercise(name: string): string | null {
  return catalogByNorm.get(normName(name))?.category ?? null;
}

// Fuzzy form: drop equipment/grip qualifier words so an invented name like
// "Machine Lat Pulldown" / "Cable Lat Pulldown" collapses onto the catalog's
// "Lat Pulldown". Equipment words DO distinguish real catalog entries (Barbell
// Row vs Dumbbell Row), so a fuzzy key is only usable for snapping when exactly
// ONE catalog entry maps to it — ambiguous keys are dropped below.
const QUALIFIER = /\b(machine|cable|barbell|dumbbell|db|smith|seated|standing|bench|lying|kneeling|assisted|weighted|wide|close|narrow|neutral|grip|single|onearm|one|alternating|alt)\b/g;
const fuzzName = (s: string) =>
  normName(s.toLowerCase().replace(/[-_]/g, " ").replace(QUALIFIER, " "));
const fuzzCount = new Map<string, number>();
for (const e of EXERCISE_CATALOG) fuzzCount.set(fuzzName(e.name), (fuzzCount.get(fuzzName(e.name)) ?? 0) + 1);
const catalogByFuzz = new Map<string, CatalogExercise>();
for (const e of EXERCISE_CATALOG) {
  const f = fuzzName(e.name);
  if (f && fuzzCount.get(f) === 1) catalogByFuzz.set(f, e);
}

const catalogMuscleByNorm = new Map(EXERCISE_CATALOG.map((e) => [normName(e.name), e.muscle]));

/**
 * Resolve the primary muscle for an exercise name: the athlete's customs first,
 * then the catalog by exact normalised name, then the fuzzy (equipment-stripped)
 * key. Returns null when nothing maps — callers treat that as "unknown muscle".
 */
export function muscleForName(name: string, custom: CatalogExercise[] = []): string | null {
  const n = normName(name);
  if (!n) return null;
  for (const c of custom) if (normName(c.name) === n) return c.muscle || null;
  const direct = catalogMuscleByNorm.get(n);
  if (direct) return direct;
  return catalogByFuzz.get(fuzzName(name))?.muscle ?? null;
}

/** Compound flag for an exercise (customs → catalog → fuzzy), false if unknown
 *  — mirrors the Android fallback so progression rep windows match the app. */
export function compoundForName(name: string, custom: CatalogExercise[] = []): boolean {
  const n = normName(name);
  if (!n) return false;
  for (const c of custom) if (normName(c.name) === n) return c.compound === true;
  return catalogByNorm.get(n)?.compound ?? catalogByFuzz.get(fuzzName(name))?.compound ?? false;
}

/** Enforce the bundled library without guessing equipment or movement variants.
 * Returns removed names so generation can request a repair. Manual custom
 * exercises and historical logs are deliberately unaffected. */
export function enforceStrengthCatalog(workout: Workout): string[] {
  if (workout.type !== "strength") return [];
  const removed: string[] = [];
  for (const section of workout.sections) {
    section.exercises = section.exercises.filter((exercise) => {
      const entry = catalogByNorm.get(normName(exercise.name));
      if (!entry) {
        removed.push(exercise.name);
        return false;
      }
      Object.assign(exercise, entry);
      return true;
    });
  }
  workout.sections = workout.sections.filter((section) => section.exercises.length > 0);
  return removed;
}

/** The athlete's custom exercises (best-effort; empty on any failure). */
export async function customExercises(
  admin: SupabaseClient,
  userId: string,
): Promise<CatalogExercise[]> {
  try {
    const { data } = await admin
      .from("strength_custom_exercises")
      .select("name, muscle, category, compound")
      .eq("user_id", userId);
    return (data ?? []) as CatalogExercise[];
  } catch (_e) {
    return [];
  }
}

/** Distinct exercises the athlete has actually logged recently (~4 months) —
 *  a proxy for the machines/implements their gym really has. Best-effort. */
async function loggedRepertoire(
  admin: SupabaseClient,
  userId: string,
): Promise<string[]> {
  try {
    const since = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
    const { data } = await admin
      .from("strength_logs")
      .select("exercise_name")
      .eq("user_id", userId)
      .gte("date", since)
      .limit(1000);
    return [...new Set((data ?? []).map((r) => (r.exercise_name ?? "").trim()).filter(Boolean))];
  } catch (_e) {
    return [];
  }
}

// Prompt block: pins strength exercise names to the loggable catalog and sets
// the rules for cardio entries. Generation is restricted to bundled entries.
export async function exerciseCatalogBlock(
  admin: SupabaseClient,
  userId: string,
): Promise<string> {
  const repertoire = (await loggedRepertoire(admin, userId)).filter((name) => catalogByNorm.has(normName(name)));
  const byMuscle = new Map<string, string[]>();
  for (const e of EXERCISE_CATALOG) {
    byMuscle.set(e.muscle, [...(byMuscle.get(e.muscle) ?? []), e.name]);
  }
  const lines = [...byMuscle.entries()].map(([m, names]) => `- ${m}: ${names.join(", ")}`);
  const repertoireBlock = repertoire.length
    ? `\n\nTHE ATHLETE'S OWN REPERTOIRE, exercises they actually log (this is what their gym's ` +
      `machines and their preferences support): ${repertoire.join(", ")}.\n` +
      `STRONGLY prefer these over other library entries: an unfamiliar variation (e.g. a different ` +
      `leg-curl machine) usually just means equipment they don't have. Go outside the repertoire only ` +
      `when it has nothing for a muscle/pattern the session needs.`
    : "";
  return `\n\nSTRENGTH EXERCISE LIBRARY (the athlete logs sessions against this list, names must match EXACTLY):\n` +
    lines.join("\n") + repertoireBlock + `\n` +
    `Rules for strength exercises:\n` +
    `- Every strength exercise "name" MUST be copied character-for-character from the library above.\n` +
    `- Never invent exercises or prescribe custom entries. Choose an appropriate library alternative; if none fits the constraints, omit it.\n` +
    `- For any cardio / conditioning / warm-up cardio block you MUST pick one of the Cardio library entries by exact name (${
      EXERCISE_CATALOG.filter((e) => e.muscle === "Cardio").map((e) => e.name).join(", ")
    }). NEVER invent a generic name like "Light Cardio", "Cardio", "Conditioning" or "HIIT".\n` +
    `- Cardio entries are logged in MINUTES: set "reps" to the duration like "10 min", sets to the number of intervals, and "weight_kg" to null.`;
}
