"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { createClient } from "@/lib/supabase-browser";
import type { AdaptationProposal } from "@shared/adaptation";
import type { Workout } from "@shared/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WorkoutDetail } from "@/components/workout-detail";
export function AdaptationControls({ onChange }: { onChange?: () => void }) {
  const [applyAllowed, setApplyAllowed] = useState(false);
  const [proposal, setProposal] = useState<AdaptationProposal>();
  const [history, setHistory] = useState<AdaptationProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [minutes, setMinutes] = useState("");
  const [equipment, setEquipment] = useState<string[]>([]);
  const [inventory, setInventory] = useState<string[]>([]);
  const [holds, setHolds] = useState<
    { id: string; reason: string; sport?: string; area?: string }[]
  >([]);
  const supabase = createClient();
  const loadHolds = async () => {
    const { data: profile } = await supabase.from("user_profiles").select(
      "onboarding",
    ).single();
    setInventory(profile?.onboarding?.implements ?? []);
    const { data } = await supabase.from("training_holds").select(
      "id,reason,sport,area",
    ).eq("active", true);
    setHolds(data ?? []);
  };
  useEffect(() => {
    void loadHolds();
  }, []); // owner RLS
  const run = async (
    action: "preview" | "apply" | "undo" | "history" = "preview",
    id?: string,
    alternative_sport?: string,
  ) => {
    setBusy(true);
    setMessage("");
    try {
      const r = await api.adaptPlan(action, id, {
        minutes: minutes ? Number(minutes) : undefined,
        unavailable_implements: equipment,
        alternative_sport,
      });
      if (r.proposal) {
        setProposal(r.proposal);
        setApplyAllowed(r.apply_allowed === true);
      }
      if (r.history) setHistory(r.history);
      if (action === "apply" || action === "undo") onChange?.();
      if (r.sync_error) setMessage("Plan saved; calendar sync will retry.");
    } catch {
      setMessage(
        "Could not update the plan. Refresh the preview and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <p className="label-caps">Adjust my plan</p>
        <p className="text-sm text-muted-foreground">
          Preview only the sessions that need changing. Completed training and
          locked commitments stay in place.
        </p>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => run()}>Preview changes</Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => run("history")}
          >
            History
          </Button>
        </div>
        {proposal && (
          <>
            <p>{proposal.explanation}</p>
            <p className="text-sm">{proposal.next_action}</p>
            {proposal.uncertainties.map((s, i) => (
              <p key={i} className="text-xs text-muted-foreground">{s}</p>
            ))}
            {proposal.changes.map((c) => (
              <details key={c.id}>
                <summary>
                  {c.date} · session {c.session_slot + 1}:{" "}
                  {(c.before as Workout).duration_minutes} →{" "}
                  {(c.after as Workout).duration_minutes} minutes
                </summary>
                <p>{c.explanation}</p>
                <p>Before</p>
                <WorkoutDetail workout={c.before as Workout} />
                <p>Proposed</p>
                <WorkoutDetail workout={c.after as Workout} />
              </details>
            ))}
            {proposal.clarification && <p>{proposal.clarification}</p>}
            <Input
              type="number"
              min={0}
              placeholder="Available minutes (optional)"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
            {proposal.clarification && (
              <div>
                {inventory.map((item) => (
                  <label key={item} className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={equipment.includes(item)}
                      onChange={(e) =>
                        setEquipment(
                          e.target.checked
                            ? [...equipment, item]
                            : equipment.filter((i) =>
                              i !== item
                            ),
                        )}
                    />
                    {item.replaceAll("_", " ")}
                  </label>
                ))}
              </div>
            )}
            {(minutes || equipment.length > 0) && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => run()}
              >
                Update preview
              </Button>
            )}
            {proposal.alternatives.map((a) => (
              <Button
                key={a.id}
                variant="outline"
                disabled={busy}
                onClick={() => run("preview", undefined, a.id)}
              >
                {a.label}
              </Button>
            ))}
            {proposal.state === "preview" && !!proposal.changes.length &&
              !applyAllowed && (
              <p className="text-xs">
                Plan adjustments are currently available as previews.
              </p>
            )}
            {applyAllowed && proposal.state === "preview" &&
              !!proposal.changes.length && !proposal.clarification && (
              <Button
                disabled={busy}
                onClick={() => run("apply", proposal.id)}
              >
                Apply these changes
              </Button>
            )}
            {proposal.state === "applied" && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => run("undo", proposal.id)}
              >
                Undo adaptation
              </Button>
            )}
          </>
        )}
        {history.map((p) => (
          <details key={p.id}>
            <summary>
              {p.created_at?.slice(0, 10)} · {p.state} · {p.changes.length}{" "}
              changes
            </summary>
            <p>{p.explanation}</p>
            {p.changes.map((c) => (
              <details key={c.id}>
                <summary>
                  {c.date}: {(c.before as Workout).title} →{" "}
                  {(c.after as Workout).title}
                </summary>
                <WorkoutDetail workout={c.before as Workout} />
                <WorkoutDetail workout={c.after as Workout} />
              </details>
            ))}
            {p.state === "applied" && (
              <Button
                disabled={busy}
                onClick={() => run("undo", p.id)}
              >
                Undo this adaptation
              </Button>
            )}
          </details>
        ))}
        {holds.map((h) => (
          <div key={h.id} className="space-y-2">
            <p>Planning hold: {h.reason} {h.sport} {h.area}</p>
            <p className="text-xs">
              Clearing this resumes planning; it is not medical clearance.
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                const { error } = await supabase.rpc("resolve_training_hold", {
                  p_id: h.id,
                });
                if (error) setMessage("Could not clear the planning hold.");
                else {
                  await loadHolds();
                  onChange?.();
                }
              }}
            >
              Clear planning hold
            </Button>
          </div>
        ))}
        {message && <p className="text-sm">{message}</p>}
      </CardContent>
    </Card>
  );
}
