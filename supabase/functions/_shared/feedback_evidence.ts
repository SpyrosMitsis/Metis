/** Keep both sources. Taking the higher conflicting effort is a conservative
 * planning policy, not a conclusion that either source is correct. */
export function combineEffort(reported: unknown, provider: unknown) {
  const valid = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 10;
  const report = valid(reported) ? reported : null,
    remote = valid(provider) ? provider : null;
  return {
    reported_effort: report,
    provider_effort: remote,
    effort: report == null
      ? remote
      : remote == null
      ? report
      : Math.max(report, remote),
    effort_conflict: report != null && remote != null &&
      Math.abs(report - remote) >= 3,
  };
}
