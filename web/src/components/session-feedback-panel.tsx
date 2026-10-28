"use client";
import { useRef, useState } from "react";
import {
  CHANGE_REASONS,
  SESSION_OUTCOMES,
  type SessionFeedback,
} from "@shared/adaptation";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
export function SessionFeedbackPanel(
  { date, planId, activityId, onChange }: {
    date: string;
    planId?: string;
    activityId?: string;
    onChange?: () => void;
  },
) {
  const [feedback, setFeedback] = useState<Partial<SessionFeedback>>({
    reason: "unknown",
    outcome: "unknown",
  });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef({ signature: "", id: "" });
  const patch = (value: Partial<SessionFeedback>) =>
    setFeedback((f) => ({ ...f, ...value }));
  const save = async () => {
    setBusy(true);
    try {
      const signature = JSON.stringify({ date, planId, activityId, feedback });
      if (signature !== request.current.signature) {
        request.current = { signature, id: crypto.randomUUID() };
      }
      await api.sessionFeedback({
        ...feedback,
        id: request.current.id,
        date,
        planned_workout_id: planId ?? null,
        activity_id: activityId ?? null,
        completed: !["skipped", "unknown"].includes(
          feedback.outcome ?? "unknown",
        ),
      });
      setMessage("Feedback saved.");
      onChange?.();
    } catch {
      setMessage("Could not save feedback. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="rounded-md border p-3">
      <summary className="text-sm">Session feedback (optional)</summary>
      <div className="mt-3 space-y-2">
        <label className="block">
          What happened{" "}
          <select
            value={feedback.outcome}
            onChange={(e) =>
              patch({ outcome: e.target.value as SessionFeedback["outcome"] })}
          >
            {SESSION_OUTCOMES.map((v) => (
              <option key={v} value={v}>{v.replaceAll("_", " ")}</option>
            ))}
          </select>
        </label>
        <label className="block">
          Reason{" "}
          <select
            value={feedback.reason}
            onChange={(e) =>
              patch({ reason: e.target.value as SessionFeedback["reason"] })}
          >
            {CHANGE_REASONS.map((v) => <option key={v}>{v}</option>)}
          </select>
        </label>
        <label className="block">
          Session fit{" "}
          <select
            onChange={(e) => patch({ difficulty: e.target.value || null })}
          >
            <option value="">Not rated</option>
            {["too_easy", "just_right", "too_hard"].map((v) => (
              <option key={v} value={v}>{v.replaceAll("_", " ")}</option>
            ))}
          </select>
        </label>
        <Input
          type="number"
          min={1}
          max={10}
          placeholder="Perceived effort 1–10"
          onChange={(e) =>
            patch({
              actual_rpe: e.target.value ? Number(e.target.value) : null,
            })}
        />
        <Input
          type="number"
          min={0}
          max={1440}
          placeholder="Actual minutes"
          onChange={(e) =>
            patch({
              actual_minutes: e.target.value ? Number(e.target.value) : null,
            })}
        />
        <Input
          maxLength={100}
          placeholder="Soreness location (optional)"
          onChange={(e) => patch({ soreness_area: e.target.value })}
        />
        {feedback.reason === "pain" && (
          <Input
            maxLength={100}
            placeholder="Pain location"
            onChange={(e) => patch({ pain_area: e.target.value })}
          />
        )}
        {["pain", "illness"].includes(feedback.reason ?? "") && (
          <p className="text-xs">
            Affected planning goes on hold until you review and clear it in
            Adjust my plan. Pain is treated separately from soreness.
          </p>
        )}
        {([["enjoyment", "Enjoyment"], [
          "usefulness",
          "Useful workout",
        ]] as const).map(([key, label]) => (
          <label key={key} className="block">
            {label}{" "}
            <select
              onChange={(e) =>
                patch({
                  [key]: e.target.value ? Number(e.target.value) : null,
                })}
            >
              <option value="">Not rated</option>
              {[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}
            </select>
          </label>
        ))}
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            onChange={(e) => patch({ unwanted_change: e.target.checked })}
          />An unwanted plan change affected this session
        </label>
        <Button disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save feedback"}
        </Button>
        {message && <p className="text-sm">{message}</p>}
      </div>
    </details>
  );
}
