package com.workoutmaker.app.ui.screens.coach

import com.workoutmaker.app.util.runCatching

import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.data.ChatMessage
import com.workoutmaker.app.data.CoachChatRequest
import com.workoutmaker.app.data.WorkoutRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject
import com.workoutmaker.app.data.ChatSettingChange
import com.workoutmaker.app.data.CoachConversation
import com.workoutmaker.app.data.PlanChangeBus
import com.workoutmaker.app.data.PlanWeekRequest
import com.workoutmaker.app.data.PlannedWorkout
import com.workoutmaker.app.ui.components.MarkdownText
import com.workoutmaker.app.ui.components.rememberAnimationsEnabled
import com.workoutmaker.app.util.AppLog
import com.workoutmaker.app.util.friendlyFnError
import java.time.DayOfWeek
import java.time.LocalDate
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import com.workoutmaker.app.data.applyChatSettings
import com.workoutmaker.app.data.cachedDailySummary
import com.workoutmaker.app.data.coachAgenticStream
import com.workoutmaker.app.data.coachChat
import com.workoutmaker.app.data.coachConversations
import com.workoutmaker.app.data.coachFinalizeRaw
import com.workoutmaker.app.data.deleteCoachConversation
import com.workoutmaker.app.data.loadProfile
import com.workoutmaker.app.data.planWeek
import com.workoutmaker.app.data.plannedWorkouts
import com.workoutmaker.app.data.setCoachConversationPinned
import com.workoutmaker.app.data.templates

@HiltViewModel
class CoachViewModel @Inject constructor(
    private val repo: WorkoutRepository,
    private val planChanges: PlanChangeBus,
) : ViewModel() {
    // Empty until someone speaks. A fresh thread used to open with a canned
    // assistant bubble, which read as the coach having already talked at you;
    // the screen now shows a greeting hero over the empty thread instead.
    val messages = MutableStateFlow<List<ChatMessage>>(emptyList())
    // First name for that hero. Null keeps the greeting to the time of day.
    val displayName = MutableStateFlow<String?>(null)
    val sending = MutableStateFlow(false)
    val banner = MutableStateFlow<String?>(null)
    // When a send fails outright, the failed text is parked here so the screen can
    // refill the input box — the athlete retries with one tap, not a retype.
    val draftRestore = MutableStateFlow<String?>(null)
    // Live tool-progress line while the agentic loop runs.
    val liveStatus = MutableStateFlow<String?>(null)
    // The agentic turn made visible as ONE line that swaps text as the coach
    // moves tool to tool. It used to accumulate a row per tool, which on a real
    // planning turn (a dozen tools) grew into a wall that pushed the composer
    // down the screen and fought the auto-scroll. What the coach actually
    // changed is reported afterwards by [lastAction] and the result card, both
    // built from the server's toolsUsed, so nothing is lost by not stacking
    // them here. Write tools are accented in the UI.
    data class ToolStep(val label: String, val write: Boolean)
    val currentStep = MutableStateFlow<ToolStep?>(null)
    private fun advanceTool(tool: String) {
        liveStatus.value = null // the step line replaces the generic one
        currentStep.value = ToolStep(friendlyToolProgress(tool), tool in WRITE_TOOL_NAMES)
    }
    // Contextual quick replies after a coach turn (never after a plain answer).
    val followUps = MutableStateFlow<List<CoachStarter>>(emptyList())
    fun dismissFollowUps() { followUps.value = emptyList() }
    // After the coach changes the calendar: this week's sessions for the result card.
    val actionWeek = MutableStateFlow<List<PlannedWorkout>?>(null)
    // Index into [messages] of the assistant turn that produced [actionWeek] — the
    // card renders inline at this position instead of always trailing the thread,
    // so it stays where it was generated as the conversation continues past it.
    val actionWeekAnchor = MutableStateFlow<Int?>(null)
    // Plain-language summary of the write actions the coach just took (card subtitle).
    val lastAction = MutableStateFlow<String?>(null)
    // Whether a full week was (re)planned this turn — gates the card's "Re-plan" escape hatch.
    val showReplan = MutableStateFlow(false)
    // The tools the CURRENT turn used, or null when no turn has run in this
    // session (fresh thread, or one just opened from history). The proposal
    // banner reads it two ways: null means there is no live turn to judge, and
    // a turn that read the planned week was describing it, not proposing.
    val turnTools = MutableStateFlow<List<String>?>(null)
    // Contextual conversation starters, built from the cached dashboard.
    val suggestions = MutableStateFlow(
        listOf(
            CoachStarter("How's my fitness?", STARTER_FITNESS),
            CoachStarter("Plan my week", STARTER_PLAN_WEEK),
        ),
    )
    private var conversationId: String? = null

    // Incognito: this thread is never saved (server persists nothing, history
    // never lists it). Toggling starts a fresh thread so the semantics are
    // clean — a chat is either fully saved or fully ephemeral.
    val incognito = MutableStateFlow(false)
    fun toggleIncognito() {
        incognito.value = !incognito.value
        newChat(keepIncognito = true)
    }

    // ---- reveal pacing -------------------------------------------------------
    // The server now streams real token deltas (llmStream captures usage, so
    // cost logging is no longer a reason to buffer the whole turn). Deltas are
    // mid-line by definition, so this is a PACED DRAIN, not a typewriter: it
    // smooths arrival jitter without ever falling behind the stream. The old
    // whole-line rule existed to stop MarkdownText restyling a half-written
    // line; that is now handled properly in the renderer's streaming mode.
    // The screen sets [animateReplies] from rememberAnimationsEnabled(), so the
    // system remove-animations setting shows replies instantly.
    val animateReplies = MutableStateFlow(true)
    // True between send() and the stream closing. revealing must cover this too,
    // or a network stall mid-reply would drain the queue, flip revealing false,
    // and pop the result card / chips in underneath a message still being
    // written.
    private val streamOpen = MutableStateFlow(false)
    // True while the typewriter is still revealing text. The screen holds back
    // everything that would otherwise pop in under the growing message (result
    // card, banner, follow-up chips) until this settles, so the reply types
    // into a stable layout instead of one that keeps reflowing.
    val revealing = MutableStateFlow(false)
    private var revealJob: Job? = null
    private val revealQueue = StringBuilder()

    /** Append [text] to the trailing assistant message, creating it if needed. */
    private fun appendVisible(text: String) {
        val msgs = messages.value
        val last = msgs.lastOrNull()
        messages.value = if (last?.role == "assistant" && revealTarget) {
            msgs.dropLast(1) + ChatMessage("assistant", last.content + text)
        } else {
            revealTarget = true
            msgs + ChatMessage("assistant", text)
        }
    }

    // True while the trailing assistant message is this turn's reply (so
    // appendVisible knows to extend it rather than start a new bubble).
    private var revealTarget = false

    /** Drop anything queued without showing it (thread switch / new chat). */
    private fun cancelReveal() {
        revealJob?.cancel()
        revealJob = null
        revealQueue.setLength(0)
        revealTarget = false
        revealing.value = false
    }

    /** Show everything still queued at once (new send, screen exit, no-anim). */
    private fun flushReveal() {
        revealJob?.cancel()
        revealJob = null
        if (revealQueue.isNotEmpty()) {
            appendVisible(revealQueue.toString())
            revealQueue.setLength(0)
        }
        revealing.value = false
    }

    /** Discard the in-flight reply: the coach narrated, then called a tool. */
    private fun resetReveal() {
        revealJob?.cancel()
        revealJob = null
        revealQueue.setLength(0)
        if (revealTarget) {
            // Drop the bubble we were growing; the real answer starts fresh.
            messages.value = messages.value.dropLast(1)
            revealTarget = false
        }
    }

    private fun queueReveal(tok: String) {
        // JSON replies render as a card (WorkoutCard/DataCard) only once whole;
        // typing them out would flash broken JSON as text first. Show at once.
        // Only meaningful on the non-streaming path now: the streamed path is
        // guaranteed prose, since the JSON-protocol leg never streams.
        val jsonStart = !revealTarget && revealQueue.isEmpty() && tok.trimStart().startsWith("{")
        if (!animateReplies.value || jsonStart) {
            flushReveal()
            appendVisible(tok)
            return
        }
        revealQueue.append(tok)
        if (revealJob == null) {
            revealing.value = true
            revealJob = viewModelScope.launch {
                // Drain until the queue is empty AND no more is coming. The old
                // loop stopped the moment the queue drained, which was fine when
                // the whole reply arrived at once but ends the reveal during any
                // gap between deltas.
                while (revealQueue.isNotEmpty() || streamOpen.value) {
                    if (revealQueue.isEmpty()) {
                        delay(RevealPacer.TICK_MS)
                        continue
                    }
                    val cut = RevealPacer.chunk(revealQueue)
                    val chunk = revealQueue.substring(0, cut)
                    revealQueue.delete(0, cut)
                    appendVisible(chunk)
                    delay(RevealPacer.TICK_MS)
                }
                revealJob = null
                revealing.value = false
            }
        }
    }

    init {
        viewModelScope.launch {
            // Cached profile read, so this costs nothing on a warm start and
            // simply leaves the hero nameless if it fails.
            displayName.value = runCatching { repo.loadProfile()?.display_name }
                .getOrNull()?.takeIf { it.isNotBlank() }
        }
        viewModelScope.launch {
            val cached = runCatching { repo.cachedDailySummary() }.getOrNull()?.first
            val chips = mutableListOf(CoachStarter("How's my fitness?", STARTER_FITNESS))
            val today = cached?.today_workout
            if (today?.workout_json != null && !today.completed) {
                chips += CoachStarter("Explain today's workout", STARTER_EXPLAIN_TODAY)
            } else if (today == null) {
                chips += CoachStarter("Workout for today", STARTER_MAKE_TODAY)
            }
            chips += CoachStarter("Plan my week", STARTER_PLAN_WEEK)
            cached?.goal?.let { g ->
                g.weeks_to_goal?.let { w ->
                    chips += CoachStarter(
                        "On track for ${g.goal}?",
                        "Am I on track for my goal of ${g.goal}, $w weeks out? Read my fitness " +
                            "trend (CTL/ATL/TSB), recent volume and how I've been executing, then tell " +
                            "me honestly if I'm ahead, on pace, or behind, and the single most important " +
                            "thing to adjust over the next two weeks.",
                    )
                }
            }
            chips += CoachStarter("How did my training go?", STARTER_RECENT)
            suggestions.value = chips.take(5)
        }
    }

    /** Ask the Calendar tab to open on [date] (the nav itself is the screen's). */
    fun focusCalendar(date: String) {
        planChanges.focusDate.value = date
    }

    fun dismissActionCard() {
        actionWeek.value = null
        actionWeekAnchor.value = null
        lastAction.value = null
        showReplan.value = false
    }

    // Re-run the weekly plan from the result card — the same plan-week action the
    // Calendar tab uses, as a quick "not happy with this? regenerate" escape hatch.
    fun rePlanWeek() {
        sending.value = true
        liveStatus.value = "Re-planning your week…"
        viewModelScope.launch {
            runCatching {
                val monday = LocalDate.now().with(DayOfWeek.MONDAY)
                repo.planWeek(PlanWeekRequest(start_date = monday.toString()))
            }.onSuccess {
                lastAction.value = "re-planned your week"
                banner.value = "✓ Re-planned your week"
                loadActionWeek()
                planChanges.emit("coach")
            }.onFailure {
                AppLog.w("coach", "re-plan failed", it)
                banner.value = friendlyFnError(
                    it, "Couldn't re-plan your week. Try again.",
                )
            }
            sending.value = false
            liveStatus.value = null
        }
    }

    // Reflect any write actions the coach took this turn: a plain-language card
    // subtitle, the "Re-plan" escape hatch (only after a full week plan), and a
    // fresh pull of the real calendar for the result card.
    private fun onToolsUsed(tools: List<String>) {
        val writes = tools.filter { it in WRITE_TOOL_NAMES }
        followUps.value = followUpChips(tools)
        // looksLikeWorkoutProposal fires on three or more day names, so ANY
        // answer describing the athlete's existing week trips it. Seen on
        // device: a pure "how's my fitness?" read listed the week's four days
        // and got a "Coach proposed this but didn't apply it" banner offering
        // to put an already-scheduled week on the calendar. If the coach read
        // the plan, the day names came FROM the plan and nothing was proposed.
        turnTools.value = tools
        if (writes.isNotEmpty()) {
            lastAction.value = friendlyTools(writes)
            showReplan.value = writes.contains("plan_week")
            // Home and Calendar survive tab switches; tell them the plan moved.
            planChanges.emit("coach")
            // Any write tool can change what's on the calendar (set_rest_day and
            // make_easier used to be excluded here, so clearing a week to rest
            // left the result card showing the pre-clear days).
            loadActionWeek()
        }
    }

    // After a write tool: show what's actually on the calendar now, fetched fresh
    // from the source of truth.
    private fun loadActionWeek() = viewModelScope.launch {
        runCatching {
            val monday = LocalDate.now().with(DayOfWeek.MONDAY)
            val sunday = monday.plusDays(6)
            repo.plannedWorkouts(monday.toString())
                .filter { it.date <= sunday.toString() }
                .sortedBy { it.date }
        }.onSuccess {
            actionWeek.value = it
            // Captured here, not in onToolsUsed: this fetch is a network round-trip
            // that reliably outlasts the typewriter reveal, so by now the assistant's
            // reply is already the true last entry in messages (append-only, see the
            // itemsIndexed key comment in CoachScreen).
            actionWeekAnchor.value = messages.value.lastIndex
        }
    }

    // Chat history
    val conversations = MutableStateFlow<List<CoachConversation>>(emptyList())
    val showHistory = MutableStateFlow(false)

    fun openHistory() {
        showHistory.value = true
        viewModelScope.launch {
            runCatching { repo.coachConversations() }.onSuccess { list ->
                conversations.value = list.sortedWith(
                    compareByDescending<CoachConversation> { it.pinned }
                        .thenByDescending { it.updated_at ?: "" },
                )
            }
        }
    }
    fun closeHistory() { showHistory.value = false }

    fun deleteConversation(c: CoachConversation) {
        conversations.value = conversations.value.filterNot { it.id == c.id }
        if (conversationId == c.id) newChat()
        viewModelScope.launch { runCatching { repo.deleteCoachConversation(c.id) } }
    }

    fun togglePin(c: CoachConversation) {
        val next = !c.pinned
        // Optimistic: flip locally and re-sort (pinned first, then by updated_at).
        conversations.value = conversations.value
            .map { if (it.id == c.id) it.copy(pinned = next) else it }
            .sortedWith(compareByDescending<CoachConversation> { it.pinned }
                .thenByDescending { it.updated_at ?: "" })
        viewModelScope.launch { runCatching { repo.setCoachConversationPinned(c.id, next) } }
    }

    /** Load a past conversation to read or continue it. */
    fun openConversation(c: CoachConversation) {
        cancelReveal() // never type a stale reply into the newly opened thread
        incognito.value = false // saved threads are by definition not incognito
        conversationId = c.id
        messages.value = c.messages
        banner.value = null
        // No tool record survives in a saved thread, so the proposal banner has
        // nothing to judge: on device a stored "how's my fitness?" answer showed
        // it again the moment the thread was reopened. Null suppresses it.
        turnTools.value = null
        showHistory.value = false
        // A stale card/anchor from whatever thread was open before would otherwise
        // point at the wrong message index in this (shorter) restored list.
        actionWeek.value = null
        actionWeekAnchor.value = null
    }

    /** Start a fresh thread. */
    fun newChat(keepIncognito: Boolean = false) {
        cancelReveal()
        if (!keepIncognito) incognito.value = false
        conversationId = null
        messages.value = emptyList()
        banner.value = null
        turnTools.value = null
        showHistory.value = false
        actionWeek.value = null
        actionWeekAnchor.value = null
    }

    fun send(text: String) {
        flushReveal() // never animate two replies at once
        revealTarget = false
        val outgoing = messages.value + ChatMessage("user", text)
        messages.value = outgoing
        sending.value = true
        banner.value = null
        lastAction.value = null
        showReplan.value = false
        turnTools.value = null
        followUps.value = emptyList()
        currentStep.value = null
        liveStatus.value = "Thinking…"
        // Every message here is real: the greeting that used to occupy slot 0
        // (and had to be dropped before sending) is now a screen-level hero and
        // never enters the thread.
        val history = outgoing

        // Agentic + streamed: the server emits a progress event per tool while
        // the loop runs, then the reply. Falls back to the plain request if the
        // stream fails before any reply arrived.
        viewModelScope.launch {
            var gotReply = false
            fun appendToken(tok: String) {
                gotReply = true
                queueReveal(tok)
            }
            suspend fun applySettings(changes: List<ChatSettingChange>) {
                if (changes.isEmpty()) return
                val applied = repo.applyChatSettings(changes)
                if (applied.isNotEmpty()) banner.value = "✓ Settings updated: " + applied.joinToString(", ")
            }
            streamOpen.value = true
            val streamed = runCatching {
                repo.coachAgenticStream(
                    history, conversationId, incognito.value,
                    onTool = { advanceTool(it) },
                    onToken = { appendToken(it) },
                    // The coach narrated, then called a tool: what is on screen
                    // was a preamble, not the answer. gotReply goes back to
                    // false too, or a later failure would be swallowed as
                    // "we already showed a reply".
                    onReset = { gotReply = false; resetReveal() },
                )
            }
            streamOpen.value = false
            streamed.onSuccess { r ->
                conversationId = r.conversationId ?: conversationId
                r.error?.let { err ->
                    if (!gotReply) messages.value = messages.value + ChatMessage("assistant", "⚠️ $err")
                }
                applySettings(r.settingsChanges)
                onToolsUsed(r.toolsUsed)
            }.onFailure {
                if (!gotReply) {
                    // Stream transport failed — retry once over the plain endpoint.
                    runCatching {
                        repo.coachChat(
                            CoachChatRequest(
                                messages = history, mode = "chat", conversationId = conversationId,
                                purpose = "setup", incognito = incognito.value,
                            ),
                        )
                    }.onSuccess { reply ->
                        conversationId = reply.conversation_id ?: conversationId
                        appendToken(reply.reply ?: "(no reply)")
                        applySettings(reply.settings_changes)
                        onToolsUsed(reply.tools_used)
                    }.onFailure { e2 ->
                        AppLog.w("coach", "both transports failed", e2)
                        banner.value = friendlyFnError(
                            e2, "The coach didn't answer. Tap send to try again.",
                        )
                        // Both transports failed — revert the stranded user turn and
                        // hand the text back to the input box so retry is one tap.
                        if (messages.value.lastOrNull()?.role == "user") {
                            messages.value = messages.value.dropLast(1)
                        }
                        draftRestore.value = text
                    }
                }
            }
            sending.value = false
            liveStatus.value = null
            // The step line collapses into the banner summary; the reveal job
            // (if still typing) carries on, it owns only message text.
            currentStep.value = null
            // Settle the gate if nothing is left to reveal. Normally the drain
            // loop clears this itself, but a turn that ended on a reset (coach
            // narrated, then called a tool, then said nothing more) leaves no
            // job running, and the screen would hold the result card back
            // forever waiting for a reveal that will never finish.
            if (revealJob == null && revealQueue.isEmpty()) revealing.value = false
        }
    }

    // One-tap retry after a failed turn: drop the trailing error bubble and
    // re-send the last user message (send() re-appends it).
    fun retryLast() {
        val lastUser = messages.value.lastOrNull { it.role == "user" }?.content ?: return
        messages.value = messages.value.dropLastWhile { it.role != "user" }.dropLast(1)
        send(lastUser)
    }

    fun finalize(kind: String) {
        sending.value = true
        banner.value = null
        viewModelScope.launch {
            runCatching {
                repo.coachFinalizeRaw(
                    CoachChatRequest(
                        messages = messages.value.drop(1),
                        mode = "finalize",
                        finalizeKind = kind,
                        conversationId = conversationId,
                        save = true,
                    ),
                )
            }.onSuccess {
                banner.value = if (kind == "plan")
                    "✓ Saved a multi-week plan to your templates."
                else "✓ Saved a workout template you can reuse."
            }.onFailure {
                AppLog.w("coach", "finalize failed", it)
                banner.value = friendlyFnError(
                    it, "Couldn't save that. Try again.",
                )
            }
            sending.value = false
        }
    }
}
