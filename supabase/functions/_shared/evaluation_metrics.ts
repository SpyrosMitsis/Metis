export interface MatchLabel {
  sport: string;
  expected: string | null;
  predicted: string | null;
  athlete_confirmed: boolean;
  corrected?: boolean;
}
/** Independent expected links must come from labeled evidence, never from the
 * same matcher being evaluated. No labels means no accuracy claim. */
export function matchingMetrics(labels: MatchLabel[]) {
  return Object.fromEntries(
    [...new Set(labels.map((l) => l.sport))].sort().map((sport) => {
      const rows = labels.filter((l) => l.sport === sport),
        matched = rows.filter((l) => l.predicted !== null),
        expected = rows.filter((l) => l.expected !== null);
      const correct = rows.filter((l) =>
        l.predicted !== null && l.predicted === l.expected
      ).length;
      return [sport, {
        n: rows.length,
        correct_links: correct,
        false_completion: rows.filter((l) =>
          l.athlete_confirmed && l.predicted !== l.expected
        ).length,
        wrong_links: matched.length - correct,
        missed_matches: expected.filter((l) =>
          l.predicted !== l.expected
        ).length,
        abstentions: rows.filter((l) => l.predicted === null).length,
        corrections: rows.filter((l) => l.corrected).length,
        precision: matched.length ? correct / matched.length : null,
        recall: expected.length ? correct / expected.length : null,
        correction_rate: rows.length
          ? rows.filter((l) => l.corrected).length / rows.length
          : null,
      }];
    }),
  );
}
export interface PrescriptionLabel {
  sport: string;
  catalog_ok: boolean;
  equipment_ok: boolean;
  dose_ok: boolean;
  availability_ok: boolean;
  replacement_failed: boolean | null;
}
export function prescriptionMetrics(labels: PrescriptionLabel[]) {
  return {
    n: labels.length,
    replacement_attempts:
      labels.filter((l) => l.replacement_failed !== null).length,
    catalog_violations: labels.filter((l) => !l.catalog_ok).length,
    equipment_violations: labels.filter((l) => !l.equipment_ok).length,
    dose_inconsistencies: labels.filter((l) => !l.dose_ok).length,
    availability_violations: labels.filter((l) => !l.availability_ok).length,
    failed_replacements: labels.filter((l) => l.replacement_failed).length,
  };
}
export function releaseGate(
  metrics: ReturnType<typeof prescriptionMetrics>,
  matching: ReturnType<typeof matchingMetrics>,
  reviews: {
    case_id: string;
    reviewer: string;
    source: "independent_coach";
    approved: boolean;
    evidence: string;
  }[],
  requiredCases: string[],
  deviceEvidence?: string,
  transactionEvidence?: string,
) {
  const reviewed = new Set(
    reviews.filter((r) =>
      r.source === "independent_coach" && r.reviewer.trim() && r.approved &&
      r.evidence.trim()
    ).map((r) => r.case_id),
  );
  const missing = requiredCases.filter((id) => !reviewed.has(id));
  const failures = [
    ...([
        metrics.catalog_violations,
        metrics.equipment_violations,
        metrics.dose_inconsistencies,
        metrics.availability_violations,
        metrics.failed_replacements,
      ].some((n) => n > 0)
      ? ["Prescription invariants failed"]
      : []),
    ...(Object.values(matching).some((m) =>
        m.false_completion > 0 || m.wrong_links > 0
      )
      ? ["Matching errors require review"]
      : []),
    ...(missing.length ? ["Independent coach review is incomplete"] : []),
    ...(!transactionEvidence
      ? ["Database transaction evidence is missing"]
      : []),
    ...(!deviceEvidence ? ["Real device/export validation is missing"] : []),
  ];
  return {
    allowed: !failures.length && metrics.n > 0 &&
      Object.keys(matching).length > 0,
    failures,
    unreviewed_cases: missing,
  };
}
