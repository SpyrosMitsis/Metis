# P2 adaptation, feedback and evaluation — 2026-10-26

P2 engineering covers bounded plan adaptation, structured feedback, readiness context, reversible changes and an evaluation/release workflow. Independent coach review and end-to-end trainer/watch validation remain external requirements. The new adaptation rollout starts in **shadow/preview-only mode**; code and fixtures do not certify coaching suitability. Nothing in this task deploys production migrations or enables production rollout.

## Codebase map

| Concern | Entry points |
|---|---|
| Feedback and proposal contracts | `shared/adaptation.ts`, Android `data/AdaptationModels.kt` and `CoachModels.kt` |
| Adaptation decisions and material clarification | `supabase/functions/_shared/adaptation_policy.ts` |
| Bounded preview, independent validation and input snapshots | `_shared/adaptation_service.ts` |
| HTTP preview/apply/undo/history | `supabase/functions/adapt-plan/index.ts` |
| Validated feedback ingestion | `supabase/functions/session-feedback/index.ts` |
| Subjective/provider conflict evidence | `_shared/feedback_evidence.ts`, `_shared/readiness_context.ts` |
| Athlete observations, holds and progression | `_shared/session_context.ts`, existing `program_state.ts` |
| Atomic operations, holds, history, input versions and metrics | migrations `20261026000052_adaptation_feedback.sql`, `20261026000053_engine_release.sql` |
| Android preview/history and hold controls | `ui/components/AdaptationControls.kt` |
| Optional Android session feedback | `ui/components/SessionFeedbackPanel.kt` |
| Web parity | `components/adaptation-controls.tsx`, `components/session-feedback-panel.tsx` |
| Production scenario matrix and independent review packet | `scripts/engine-eval/run.ts`, `review_cases.json` |
| Labeled matching and release metrics | `_shared/evaluation_metrics.ts` |
| PostgreSQL integration scenarios | `scripts/engine-tests/scenario04_adaptation.sql` through `scenario06_combined_adaptation.sql` |
| Device-only fixture tests | Android `AdaptationContentTest`, `RoomMigration9Test` |
| CI evidence | `.github/workflows/ci.yml`, job `engine-quality` |

All `_shared/` paths above are under `supabase/functions/`.

## Adaptation contract

`adapt-plan` accepts `action = preview | apply | undo | history` and the client's local `today`. Preview optionally accepts available minutes, unavailable implements or a selected alternative sport. It returns a persisted proposal containing affected IDs/slots, exact before/after workouts, reasons, uncertainties, one next action and feasible alternatives. Preview never modifies a plan. Viewing an activity never opens a feedback questionnaire automatically.

The engine reads latest feedback and effective actuals rather than interpreting missing imports as misses. Time-limited and skipped sessions ordinarily repeat familiar work without catch-up debt; a concrete smaller time window rebuilds the next session. Fatigue or harder actual work reduces the next appropriate dose. Substitution counts the activity actually performed while preserving uncertainty about the original sport-specific stimulus. Equipment changes require an identified unavailable implement; the engine does not guess. Conditions use a dated forecast or a confirmed indoor venue. Preference-sensitive alternatives are checked for sport eligibility, equipment, recovery and time budgets before being offered.

Ordinary adaptation touches only the next suitable unprotected session. Pain/illness holds can replace affected mutable sessions in the next seven days with explicit rest. Completed, recorded, skipped and locked commitments are preserved. Combined sessions remain a unit; if an unprotected group is affected by a hold, both parts move to rest and transition time becomes zero. Undo restores the original transition alongside the workouts. A partially protected group is preserved, with an uncertainty note.

Proposals retain the plan revision, athlete-input revision, relevant observation/program/readiness snapshots, feedback ID, policy version and model provenance (`deterministic`). Apply rejects changed observations, changed plans, expired previews and unresolved material clarification. Every candidate is independently revalidated against current exposure, equipment, holds, pauses, conditions, availability, catalog and canonical dose. The database checks ownership, input revisions, protection, group completeness and rollout before updating existing IDs in one transaction. Calendar sync uses the existing outbox.

Apply is idempotent. Undo is idempotent, revision-checked and revalidated; it cannot rewrite completed/recorded work or force an old prescription through new constraints. History exposes both versions and the reason for the change. Clearing a hold does not silently restore an old workout; the athlete can inspect and undo an eligible adaptation or preview a new one.

## Feedback and readiness

Optional feedback records reason (time, fatigue, pain, illness, equipment, conditions, preference, other, unknown), outcome (as planned, skipped, shortened, easier, harder, substituted, unknown), actual duration, perceived effort, pain/soreness location, enjoyment, usefulness and unwanted plan changes. Android and web retain stable request IDs for uncertain retries. Feedback requests cannot be reused with different input. A rating with unknown outcome does not clear an existing completion. Undo appends a retraction instead of deleting evidence.

Reports remain separate from raw provider measurements. A dated, completed report with known duration can supply a report-sourced exposure when no linked import exists. A later linked import replaces that fallback rather than counting twice. Substitutions without a known actual sport remain other/unknown rather than earning original-sport exposure. Both effort values and reported/recorded durations are retained. Large effort disagreement prevents the lower value alone from authorizing progression; the higher value is a conservative planning input, not a verdict that either source is correct. Duration disagreement and skip-versus-recording conflicts remain explicit. Missing interval/stroke/set evidence is still unknown.

Readiness combines dated wellness, physiological trends, recent actual demanding work and planning holds. Missing readings produce a null decision score and unknown status. Soreness can lead to caution; pain/illness creates a visible planning hold, not an inferred diagnosis or guessed recovery deadline. Holds remain until explicitly cleared. Clearing planning is not medical clearance. Existing injury/backoff controls remain in force as well.

Home headlines and coach briefings respect holds and caution. Cached upbeat briefings are suppressed while current context calls for caution/pause. The web no longer displays an unknown readiness value as a measured midpoint. Coaching prompts distinguish execution from the quality of the athlete's decision, retain uncertainty, avoid scolding, ground numbers in structured observations and give one next action. Chat can preview, inspect, apply and undo adaptations; final write observations include the saved calendar.

Load ratios remain descriptive. Prior “safe/productive range,” “injury spike zone” and automatic “otherwise add volume” messages were removed from Android, web and prompts. A scalar load model does not establish fitness, recovery, equivalent sport stimulus or individual injury probability.

## Evaluation and release evidence

The offline matrix runs all 29 supported recipes through eight athlete/context variants: established, novice, sparse history, limited equipment, restricted time, stale calibration, fatigue and blocked outdoor weather. It uses the production builder, compiler, content review and publication gate. The current matrix has 232 cases: 215 internally valid prescriptions and 17 expected blocked-weather abstentions. Unexpected exceptions fail the run; they cannot be relabeled as successful abstentions.

Matching is evaluated separately from prescription invariants and explanation review. Independent compatibility labels cover walking/running, generic workouts/strength and sport variants. PostgreSQL fixtures exercise real one-to-one reconciliation, same-sport double-session ambiguity and late arrivals; imports cannot confirm completion. These small fixtures are regression evidence, not a claim about population accuracy.

Metrics distinguish catalog/equipment violations, dose inconsistency, availability, replacement failures, missed/wrong links, abstention, false completion and user corrections by sport. The pure prescription matrix does not execute replacements, so its replacement attempt count is zero rather than a fabricated success rate. Database transaction evidence is attached separately. Eight-week replays use explicitly supplied actual histories; generated plans are never assumed to have happened.

`review-packet.json` contains hand-authored coaching questions, generated prescriptions, multiweek cases and empty independent-review fields. Independent review remains separate from the engine's own rules or an LLM judge. Every required case needs a named independent reviewer, approval and evidence. Real device/export evidence and passing database integration evidence are separate release requirements. The legacy live LLM evaluator now enforces the bundled catalog; it is not a substitute for the full typed production matrix.

CI runs the PostgreSQL scenarios, Room SQLite contract test and production matrix and uploads evidence. It can pass engineering checks while the release report honestly remains blocked for missing independent reviews or trainer/watch evidence.

```sh
scripts/dev.sh deno:test
scripts/dev.sh deno:check
python3 scripts/engine-tests/run.py > /tmp/engine-database.log
python3 scripts/engine-tests/room_migration.py
deno run --allow-read --allow-write --allow-env scripts/engine-eval/run.ts /tmp/engine-evaluation --transaction-evidence /tmp/engine-database.log
(cd web && npx tsc --noEmit)
```

After real review, pass `--reviews /path/to/reviews.json --device-evidence <artifact-reference> --require-release` to the evaluation runner. Review records have `case_id`, `reviewer`, `source: independent_coach`, `approved` and `evidence`; no review is generated or approved automatically.

## Rollout, rollback and observability

Migration 53 creates service-controlled `engine_releases`. `adaptation-1` starts `shadow` at zero exposure: previews/history work, Apply is unavailable, and Undo of an already applied change remains possible. `canary` requires deterministic per-athlete cohort inclusion plus regression, expert and device evidence. `enabled` exposes all athletes. `disabled` or `shadow` immediately stops new applications. Mode changes are audited. Owner-facing code cannot enable rollout or edit evidence.

An operator should attach the actual regression report, reviewer signoffs and device/provider artifacts, begin with a small canary, inspect rejected applications, failed sync and unwanted changes, and expand only after review. To roll back, set the mode to `shadow` or `disabled`; preserve saved history and offer validated undo rather than deleting actual training. These are operating steps, not actions performed by this task.

`engine_events` records bounded properties for preview/apply/undo/rejections, feedback, observations and corrections. It excludes raw authorization data and free-text health notes. Confirming an unchanged inferred match is not counted as a type/link correction. `engine_metric_summary` provides owner-filtered aggregates; labels are still needed before operational rates can be called matching accuracy. Existing `generation_logs` retains model/provider/token and failure evidence for model-generated prescriptions.

Owner RLS protects feedback, holds, proposals and metrics. Proposals retain input evidence for 180 days; operational events retain 90 days, with a scheduled service-only pruning function. Feedback remains athlete history rather than a disposable analytics event. No data was sent to an outside coach or new model provider.

## Remaining external work

- Independent coaching/clinical review of cases, dose/recovery defaults, escalation language and return-to-training boundaries for the intended populations.
- End-to-end trainer/watch acceptance, export/reimport and sport-specific instruction fidelity. Fixture parsing and a phone UI test do not establish these.
- Production deployment of pending migrations and changed functions, followed by operator-controlled staged activation and monitoring. This task leaves rollout in preview-only mode.

## Sources informing communication limits

The [IOC load-monitoring consensus](https://doi.org/10.1136/bjsports-2016-096581) supports considering subjective and observed training signals together rather than relying on one marker. [Impellizzeri et al. on ACWR limitations](https://pubmed.ncbi.nlm.nih.gov/32502973/) explains why an observed workload ratio should not be turned into a causal individual injury prediction. The [NHS exercise guidance](https://www.newcastle-hospitals.nhs.uk/services/newcastle-occupational-health-service/information-for-staff/physiotherapy/self-help-leaflets/exercise-and-your-health-a-guide-to-getting-started/) distinguishes symptoms that call for stopping/review from ordinary exercise. These sources inform conservative communication; they do not constitute independent review or certification of this engine.

## Validation status

- 696 shared tests pass; all edge functions type-check.
- Seven isolated PostgreSQL scenario files pass, including actual labeled reconciliation, rollback, combined-session transitions, input freshness, retention/access contracts and rollout gates.
- The production matrix passes engineering invariants for 215 prescriptions, with 17 expected weather abstentions and zero unexpected failures. Its release report remains blocked for the missing independent reviews and real device/provider evidence.
- SQLite migration schema/default/preservation checks pass. Android instrumentation fixtures compile, but the connected device rejected APK installation (`INSTALL_FAILED_ABORTED: User rejected permissions`) before any tests ran. No fixture is reported as passed and neither target/test APK remains installed.
- Android Play/FOSS unit tests pass, the instrumentation APK assembles, web TypeScript passes, and `git diff --check` passes. The CI workflow was updated locally; no hosted CI run or production deployment is claimed.
