/** Sport compatibility only, not proof that the planned dose was completed.
 * Generic "Workout" and walking are deliberately ambiguous/non-running. */
export function activityMatchesPlanned(plannedType: string, actualType: string | null | undefined): boolean {
  const actual = (actualType ?? "").toLowerCase();
  switch (plannedType.toLowerCase()) {
    case "run": return actual.includes("run");
    case "ride": return actual.includes("ride") || actual.includes("bike") || actual.includes("cycl");
    case "swim": return actual.includes("swim");
    case "strength": return actual.includes("weight") || actual.includes("strength") || actual.includes("gym");
    default: return false;
  }
}
