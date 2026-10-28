"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, coachChatStream, localDateIso } from "@/lib/api";
import { createClient } from "@/lib/supabase-browser";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MarkdownText } from "@/components/markdown-text";
import { cn } from "@/lib/utils";
import type { CoachConversation, DailySummary, PlannedWorkout } from "@shared/types";
import {
  CalendarCheck, ChevronDown, History, Pin, PinOff, Plus, Send, Sparkles, Trash2, Wrench, X,
} from "lucide-react";
import Link from "next/link";

interface Msg {
  role: "user" | "assistant";
  content: string;
  tools?: string[];
}

const GREETING =
  "Hey! I'm your coach, and I can see your real data. Ask me things like " +
  "“how's my fitness looking?”, “plan my week”, “am I overtraining?”, or " +
  "“set my goal race to the Berlin marathon on 2026-09-27”. I'll check your " +
  "numbers, then plan, generate, or adjust your training for you.";

// Live progress line while the agentic loop runs — matches the Android app.
function friendlyToolProgress(tool: string): string {
  switch (tool) {
    case "get_fitness": return "Checking your fitness…";
    case "get_recent_activities": return "Reviewing recent activities…";
    case "get_planned_week": return "Looking at your week…";
    case "get_strength_summary": return "Reviewing your lifting…";
    case "get_profile": return "Checking your profile…";
    case "get_readiness": return "Checking today's readiness…";
    case "get_execution_analysis": return "Reviewing how recent sessions went…";
    case "plan_week": return "Planning your week (this can take ~30s)…";
    case "generate_workout": return "Creating your workout…";
    case "move_workout": return "Moving the session…";
    case "set_goal_race": return "Setting your goal race…";
    case "remember": return "Noting that down…";
    default: return "Working…";
  }
}

function friendlyTools(tools: string[]): string {
  const label = (t: string) => {
    switch (t) {
      case "get_fitness": return "checked your fitness";
      case "get_recent_activities": return "reviewed recent activities";
      case "get_planned_week": return "looked at your week";
      case "get_strength_summary": return "reviewed your lifting";
      case "get_profile": return "checked your profile";
      case "plan_week": return "planned your week";
      case "generate_workout": return "created a workout";
      case "get_readiness": return "checked your readiness";
      case "get_execution_analysis": return "reviewed your execution";
      case "move_workout": return "moved a session";
      case "set_goal_race": return "set your goal race";
      case "remember": return "noted that for next time";
      default: return t;
    }
  };
  return [...new Set(tools)].map(label).join(" · ");
}

// Heuristic shared with Android: is the coach proposing a concrete workout or
// week plan (vs. analysis / Q&A)? Gates the "Apply to my calendar" row.
function looksLikeWorkoutProposal(text: string): boolean {
  const t0 = text.trim();
  if (t0.startsWith("{") && t0.endsWith("}")) {
    try { return JSON.stringify(JSON.parse(t0)).includes('"sections"'); } catch { /* not JSON */ }
  }
  if (text.length < 80) return false;
  const t = text.toLowerCase();
  const structure = [
    "warm-up", "warmup", "main set", "cool-down", "cooldown", "×", " sets",
    " reps", "interval", "tempo", "easy run", "long run", "rest day",
  ];
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  return structure.filter((s) => t.includes(s)).length >= 2 || days.filter((d) => t.includes(d)).length >= 3;
}

const mondayIso = () => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDateIso(d);
};

export default function CoachPage() {
  const qc = useQueryClient();
  const supabase = createClient();
  const [messages, setMessages] = useState<Msg[]>([{ role: "assistant", content: GREETING }]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [actionWeek, setActionWeek] = useState<PlannedWorkout[] | null>(null);
  const [saveMenu, setSaveMenu] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Contextual conversation starters, built from the dashboard (cached query).
  const summary = useQuery({ queryKey: ["daily-summary"], queryFn: api.dailySummary, staleTime: 60_000 });
  const suggestions = useMemo(() => {
    const d: DailySummary | undefined = summary.data;
    const chips = ["How's my fitness looking?"];
    if (d?.today_workout && !d.today_workout.completed) chips.push("Explain today's workout");
    else if (d && !d.today_workout) chips.push("Make me a workout for today");
    chips.push("Plan my week");
    if (d?.goal?.weeks_to_goal != null) chips.push(`Am I on track for ${d.goal.goal} (${d.goal.weeks_to_goal} weeks out)?`);
    chips.push("How did my last workouts go?");
    return chips.slice(0, 5);
  }, [summary.data]);

  const conversations = useQuery({
    queryKey: ["coach-conversations"],
    enabled: showHistory,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("coach_conversations").select("id, title, messages, updated_at, pinned")
        .order("updated_at", { ascending: false }).limit(100);
      if (error) throw error;
      const list = (data ?? []) as CoachConversation[];
      return list.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    },
  });

  // After plan_week / generate_workout / move_workout: show what's actually on
  // the calendar now, fetched fresh from the source of truth.
  const loadActionWeek = async () => {
    const monday = mondayIso();
    const sunday = new Date(monday + "T00:00:00");
    sunday.setDate(sunday.getDate() + 6);
    const { data } = await supabase
      .from("reconciled_session_plans").select("*")
      .gte("date", monday).lte("date", sunday.toISOString().slice(0, 10))
      .order("date");
    setActionWeek((data ?? []) as PlannedWorkout[]);
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || sending) return;
    const outgoing: Msg[] = [...messages, { role: "user", content: t }];
    setMessages(outgoing);
    setInput("");
    setSending(true);
    setBanner(null);
    setLiveStatus("Thinking…");
    const history = outgoing.slice(1).map(({ role, content }) => ({ role, content })); // drop local greeting

    let gotReply = false;
    const appendToken = (tok: string) => {
      setMessages((m) => {
        if (!gotReply) { gotReply = true; return [...m, { role: "assistant", content: tok }]; }
        const last = m[m.length - 1];
        return [...m.slice(0, -1), { ...last, content: last.content + tok }];
      });
    };

    try {
      const r = await coachChatStream(history, conversationId,
        (tool) => setLiveStatus(friendlyToolProgress(tool)), appendToken);
      if (r.conversationId) setConversationId(r.conversationId);
      if (r.error && !gotReply) setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${r.error}` }]);
      if (r.toolsUsed.length) {
        setBanner(`🔧 ${friendlyTools(r.toolsUsed)}`);
        setMessages((m) => {
          const last = m[m.length - 1];
          return last.role === "assistant" ? [...m.slice(0, -1), { ...last, tools: r.toolsUsed }] : m;
        });
      }
      if (r.toolsUsed.some((x) => x === "plan_week" || x === "generate_workout" || x === "move_workout")) {
        await loadActionWeek();
        qc.invalidateQueries({ queryKey: ["daily-summary"] });
      }
    } catch (e) {
      // Stream transport failed — retry once over the plain endpoint.
      if (!gotReply) {
        try {
          const reply = await api.coachChat(history, conversationId);
          if (reply.conversation_id) setConversationId(reply.conversation_id);
          setMessages((m) => [...m, { role: "assistant", content: reply.reply, tools: reply.tools_used }]);
          if (reply.tools_used?.length) setBanner(`🔧 ${friendlyTools(reply.tools_used)}`);
        } catch (e2) {
          setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${(e2 as Error).message}` }]);
        }
      } else {
        setBanner((e as Error).message);
      }
    }
    setSending(false);
    setLiveStatus(null);
  };

  const finalize = useMutation({
    mutationFn: (kind: "workout" | "plan") =>
      api.coachFinalize(messages.slice(1).map(({ role, content }) => ({ role, content })), kind, conversationId),
    onSuccess: (_r, kind) =>
      setBanner(kind === "plan" ? "✓ Saved a multi-week plan to your templates." : "✓ Saved a workout template you can reuse."),
    onError: (e) => setBanner(`Couldn't finalize: ${(e as Error).message}`),
  });

  const deleteConversation = async (c: CoachConversation) => {
    await supabase.from("coach_conversations").delete().eq("id", c.id);
    if (conversationId === c.id) newChat();
    qc.invalidateQueries({ queryKey: ["coach-conversations"] });
  };
  const togglePin = async (c: CoachConversation) => {
    await supabase.from("coach_conversations").update({ pinned: !c.pinned }).eq("id", c.id);
    qc.invalidateQueries({ queryKey: ["coach-conversations"] });
  };
  const openConversation = (c: CoachConversation) => {
    setConversationId(c.id);
    setMessages([{ role: "assistant", content: GREETING }, ...c.messages]);
    setBanner(null);
    setActionWeek(null);
    setShowHistory(false);
  };
  const newChat = () => {
    setConversationId(null);
    setMessages([{ role: "assistant", content: GREETING }]);
    setBanner(null);
    setActionWeek(null);
    setShowHistory(false);
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending, actionWeek]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const proposing = messages.length > 2 && actionWeek === null && looksLikeWorkoutProposal(lastAssistant);

  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Coach</h1>
          <p className="text-sm text-muted-foreground">
            Reads your real training data; can plan weeks and create workouts.
          </p>
        </div>
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" onClick={() => setShowHistory(true)} title="Chat history">
            <History className="h-5 w-5" />
          </Button>
          <Button size="icon" variant="ghost" onClick={newChat} title="New chat">
            <Plus className="h-5 w-5" />
          </Button>
        </div>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto pr-1">
        {messages.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm",
                m.role === "user"
                  ? "whitespace-pre-wrap rounded-br-sm bg-primary text-primary-foreground"
                  : "rounded-bl-sm border border-border bg-card",
              )}
            >
              {m.role === "user" ? m.content : <MarkdownText text={m.content} />}
              {m.tools && m.tools.length > 0 && (
                <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Wrench className="h-3 w-3" />
                  {friendlyTools(m.tools)}
                </p>
              )}
            </div>
          </div>
        ))}

        {actionWeek && (
          <CalendarResultCard week={actionWeek} onDismiss={() => setActionWeek(null)} />
        )}

        {sending && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              <span className="inline-flex gap-1">
                <Dot delay="0ms" /> <Dot delay="150ms" /> <Dot delay="300ms" />
              </span>
              {liveStatus ?? "Coach is thinking…"}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Contextual conversation starters on a fresh thread. */}
      {messages.length <= 1 && !sending && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => send(s)}
              className="shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-xs hover:bg-secondary"
            >
              <Sparkles className="mr-1 inline h-3 w-3 text-primary" />
              {s}
            </button>
          ))}
        </div>
      )}

      {banner && <p className="mt-2 text-sm text-primary">{banner}</p>}

      {/* Primary action: put what was discussed onto the REAL calendar. Only
          shown while the coach is actually proposing sessions. */}
      {proposing && (
        <div className="mt-2 flex items-center gap-2">
          <Button
            variant="outline"
            className="flex-1"
            disabled={sending}
            onClick={() =>
              send("Yes, apply that to my real calendar now and push it to my watch, then confirm exactly what you scheduled.")}
          >
            <CalendarCheck className="h-4 w-4" /> Apply to my calendar
          </Button>
          <div className="relative">
            <Button variant="ghost" size="sm" disabled={sending} onClick={() => setSaveMenu((v) => !v)}>
              Save <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            {saveMenu && (
              <div className="absolute bottom-10 right-0 z-20 w-52 rounded-lg border border-border bg-card p-1 shadow-lg">
                <button
                  className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-secondary"
                  onClick={() => { setSaveMenu(false); finalize.mutate("workout"); }}
                >
                  Save as workout template
                </button>
                <button
                  className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-secondary"
                  onClick={() => { setSaveMenu(false); finalize.mutate("plan"); }}
                >
                  Save as plan template
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); send(input); }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
          }}
          rows={1}
          placeholder="Message your coach…"
          className="max-h-32 min-h-[2.75rem] flex-1 resize-none rounded-xl border border-border bg-card px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary"
        />
        <Button type="submit" size="icon" disabled={sending || !input.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </form>

      {/* Chat history sheet */}
      {showHistory && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={() => setShowHistory(false)}>
          <div
            className="max-h-[70vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-border bg-card p-4 sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-base font-semibold">Chat history</h2>
              <button onClick={() => setShowHistory(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>
            {(conversations.data ?? []).length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">No past conversations yet.</p>
            )}
            {(conversations.data ?? []).map((c) => (
              <div key={c.id} className="flex items-center gap-1 rounded-lg px-1 py-2 hover:bg-secondary/50">
                <button className="flex-1 text-left" onClick={() => openConversation(c)}>
                  <p className="line-clamp-1 text-sm font-medium">
                    {c.title || c.messages.find((m) => m.role === "user")?.content?.slice(0, 60) || "Conversation"}
                  </p>
                  <p className="text-xs text-muted-foreground">{c.updated_at?.slice(0, 10)}</p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    {c.messages.filter((m) => m.role === "assistant").slice(-1)[0]?.content?.slice(0, 80)}
                  </p>
                </button>
                <button onClick={() => togglePin(c)} className={cn("p-1.5", c.pinned ? "text-primary" : "text-muted-foreground hover:text-foreground")} title={c.pinned ? "Unpin" : "Pin"}>
                  {c.pinned ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
                </button>
                <button onClick={() => deleteConversation(c)} className="p-1.5 text-muted-foreground hover:text-red-400" title="Delete">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Shown after the coach changes the calendar: the week as it now actually is,
// straight from planned_workouts, with a jump into the Calendar page.
function CalendarResultCard({ week, onDismiss }: { week: PlannedWorkout[]; onDismiss: () => void }) {
  return (
    <Card className="border-primary/30">
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center justify-between">
          <p className="label-caps" style={{ color: "hsl(var(--primary))" }}>Now on your calendar</p>
          <button onClick={onDismiss} className="text-xs text-muted-foreground hover:text-foreground">Hide</button>
        </div>
        {week.length === 0 && <p className="text-sm text-muted-foreground">Nothing scheduled this week yet.</p>}
        {week.map((w) => (
          <div key={w.id} className="flex items-center gap-2 text-sm">
            <span className="w-11 text-xs text-muted-foreground">
              {new Date(w.date + "T00:00:00").toLocaleDateString("en", { weekday: "short" })}
            </span>
            <span className="flex-1 truncate">{w.type === "rest" ? "Rest" : w.workout_json.title}</span>
            {w.workout_json.tss_estimate > 0 && (
              <span className="text-xs text-muted-foreground">{Math.round(w.workout_json.tss_estimate)} TSS</span>
            )}
          </div>
        ))}
        <Link href="/calendar" className="block">
          <Button variant="outline" className="w-full" size="sm">View in calendar</Button>
        </Link>
      </CardContent>
    </Card>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
      style={{ animationDelay: delay }}
    />
  );
}
