package com.workoutmaker.app.ui.screens.coach

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.ui.draw.clip
import com.workoutmaker.app.ui.components.EmptyState
import com.workoutmaker.app.ui.components.GhostButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.workoutmaker.app.ui.collectAsStateSafe
import kotlinx.coroutines.launch
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.material3.AssistChip
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import com.workoutmaker.app.ui.components.SectionLabel
import com.workoutmaker.app.ui.components.rememberAnimationsEnabled









// Wiring only: collect the view model, hand CoachContent a snapshot and a set of
// callbacks. Everything that decides what appears on screen lives in
// CoachContent, where a test can compose it (see CoachUiState.kt).
@Composable
fun CoachScreen(vm: CoachViewModel = hiltViewModel(), onOpenCalendar: () -> Unit = {}) {
    val messages by vm.messages.collectAsStateSafe()
    val sending by vm.sending.collectAsStateSafe()
    val banner by vm.banner.collectAsStateSafe()
    val liveStatus by vm.liveStatus.collectAsStateSafe()
    val actionWeek by vm.actionWeek.collectAsStateSafe()
    val actionWeekAnchor by vm.actionWeekAnchor.collectAsStateSafe()
    val lastAction by vm.lastAction.collectAsStateSafe()
    val showReplan by vm.showReplan.collectAsStateSafe()
    val turnTools by vm.turnTools.collectAsStateSafe()
    val suggestions by vm.suggestions.collectAsStateSafe()
    val showHistory by vm.showHistory.collectAsStateSafe()
    val conversations by vm.conversations.collectAsStateSafe()
    val currentStep by vm.currentStep.collectAsStateSafe()
    val displayName by vm.displayName.collectAsStateSafe()
    val followUps by vm.followUps.collectAsStateSafe()
    val incognito by vm.incognito.collectAsStateSafe()
    val draftRestore by vm.draftRestore.collectAsStateSafe()
    // While the reply is typing out, hold back everything that would pop in
    // beneath it (result card, banner, chips): each arrival reflowed the layout
    // under the growing text and read as flicker.
    val revealing by vm.revealing.collectAsStateSafe()

    // Respect the system remove-animations setting: replies appear at once.
    val animationsOn = rememberAnimationsEnabled()
    LaunchedEffect(animationsOn) { vm.animateReplies.value = animationsOn }

    CoachContent(
        state = CoachState(
            messages = messages,
            sending = sending,
            revealing = revealing,
            banner = banner,
            liveStatus = liveStatus,
            currentStep = currentStep,
            actionWeek = actionWeek,
            actionWeekAnchor = actionWeekAnchor,
            lastAction = lastAction,
            showReplan = showReplan,
            turnTools = turnTools,
            suggestions = suggestions,
            followUps = followUps,
            displayName = displayName,
            incognito = incognito,
            showHistory = showHistory,
            conversations = conversations,
            draftRestore = draftRestore,
        ),
        on = remember(vm, onOpenCalendar) {
            CoachActions(
                send = vm::send,
                retryLast = vm::retryLast,
                dismissFollowUps = vm::dismissFollowUps,
                dismissActionCard = vm::dismissActionCard,
                rePlanWeek = vm::rePlanWeek,
                focusCalendar = vm::focusCalendar,
                finalize = vm::finalize,
                toggleIncognito = vm::toggleIncognito,
                openHistory = vm::openHistory,
                closeHistory = vm::closeHistory,
                newChat = { vm.newChat() },
                openConversation = vm::openConversation,
                togglePin = vm::togglePin,
                deleteConversation = vm::deleteConversation,
                draftConsumed = { vm.draftRestore.value = null },
                openCalendar = onOpenCalendar,
            )
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CoachContent(state: CoachState, on: CoachActions = CoachActions()) {
    val messages = state.messages
    val sending = state.sending
    val banner = state.banner
    val liveStatus = state.liveStatus
    val actionWeek = state.actionWeek
    val actionWeekAnchor = state.actionWeekAnchor
    val lastAction = state.lastAction
    val showReplan = state.showReplan
    val turnTools = state.turnTools
    val suggestions = state.suggestions
    val showHistory = state.showHistory
    val conversations = state.conversations
    val currentStep = state.currentStep
    val displayName = state.displayName
    val followUps = state.followUps
    val revealing = state.revealing
    val incognito = state.incognito
    // Saveable: a half-typed coach message must survive rotation.
    var input by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()

    // A soft tick when the coach finishes answering, same language as the rest
    // of the app (set-done, PRs). "Finished" = the turn is done AND the
    // typewriter has settled, so the tick lands on the completed reply.
    val haptics = LocalHapticFeedback.current
    val busy = sending || revealing
    var wasBusy by remember { mutableStateOf(false) }
    LaunchedEffect(busy) {
        if (wasBusy && !busy && messages.lastOrNull()?.role == "assistant") {
            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        }
        wasBusy = busy
    }

    // A failed send parks its text here — pull it back into the box (unless the
    // athlete already started typing something new) so retry is one tap.
    LaunchedEffect(state.draftRestore) {
        state.draftRestore?.let {
            if (input.isBlank()) input = it
            on.draftConsumed()
        }
    }

    if (showHistory) {
        ModalBottomSheet(
            onDismissRequest = { on.closeHistory() },
            sheetState = rememberModalBottomSheetState(),
        ) {
            Text(
                "Chat history",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
            if (conversations.isEmpty()) {
                EmptyState(
                    title = "No conversations yet",
                    subtitle = "Your past coaching chats will show up here.",
                    icon = Icons.Filled.History,
                )
            } else {
                LazyColumn(
                    Modifier.fillMaxWidth().padding(bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    items(conversations) { c ->
                    ConversationRow(
                        c,
                        onClick = { on.openConversation(c) },
                        onPin = { on.togglePin(c) },
                        onDelete = { on.deleteConversation(c) },
                    )
                }
                }
            }
        }
    }

    // Whether the reader is pinned to the newest content (also drives the FAB).
    val atBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val lastVisible = info.visibleItemsInfo.lastOrNull()
            lastVisible == null || lastVisible.index >= info.totalItemsCount - 1
        }
    }

    // Follow new messages with one animated scroll; follow the typewriter's
    // growth with instant, non-animated pins. Restarting animateScrollToItem on
    // every reveal tick fought its own animation and flickered the whole list.
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
    }
    val lastContentLength = messages.lastOrNull()?.content?.length ?: 0
    LaunchedEffect(lastContentLength) {
        // Never yank the reader back down if they scrolled up mid-reveal.
        if (messages.isEmpty() || !atBottom) return@LaunchedEffect
        // Pin the growing tail by scrolling EXACTLY the overflow: how far the
        // last item's bottom now pokes past the viewport. (scrollToItem with a
        // huge offset overshot the content: one blank frame per tick.)
        val info = listState.layoutInfo
        val last = info.visibleItemsInfo.lastOrNull() ?: return@LaunchedEffect
        val overflow = last.offset + last.size - info.viewportEndOffset
        if (overflow > 0) listState.scrollBy(overflow.toFloat())
    }

    // imePadding, or the keyboard takes the whole screen with it: targetSdk 35 on
    // Android 15+ makes the window edge-to-edge, which retires adjustResize, so an
    // app that ignores the IME inset gets PANNED instead — the header slid off the
    // top of the screen every time the composer was tapped. Padding the column
    // keeps the composer visible, so there is nothing left for the system to pan:
    // header stays put, the thread shortens, the keyboard covers the tab bar.
    Column(Modifier.fillMaxSize().imePadding().padding(top = 8.dp)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // On the landing state the hero below IS the heading, so the title
            // collapses to the label alone rather than giving the screen two.
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                SectionLabel(if (incognito) "AI COACH · INCOGNITO" else "AI COACH")
                if (messages.isNotEmpty()) {
                    Text(
                        "Coach",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            IconButton(onClick = { on.toggleIncognito() }) {
                Icon(
                    if (incognito) Icons.Filled.VisibilityOff else Icons.Outlined.VisibilityOff,
                    contentDescription = if (incognito) "Leave incognito" else "Incognito chat",
                    tint = if (incognito) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = { on.openHistory() }) {
                Icon(Icons.Filled.History, contentDescription = "Chat history")
            }
            IconButton(onClick = { on.newChat() }) {
                Icon(Icons.Filled.Add, contentDescription = "New chat")
            }
        }
        if (incognito) {
            Text(
                "Incognito: this chat won't be saved to history or remembered by your coach.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp).padding(bottom = 6.dp),
            )
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Positional keys: only ever appended to (or the tail mutated),
                // so the index is a stable identity. Without keys every list
                // rebuild re-established item identity and the reveal flickered.
                itemsIndexed(messages, key = { i, _ -> i }) { i, msg ->
                    // Consecutive assistant messages group under one avatar.
                    val prevRole = messages.getOrNull(i - 1)?.role
                    // animateItem() smooths a settled bubble being replaced in place,
                    // but on the CURRENTLY GROWING reply it animates the bubble's own
                    // resize — its bounds lag the real size every tick, so the
                    // overflow-based auto-scroll below (which reads those bounds)
                    // keeps chasing a moving target and never truly pins to the
                    // bottom while text is streaming in. Skip it on that one bubble.
                    val isStreamingTail = revealing && i == messages.lastIndex && msg.role == "assistant"
                    val itemModifier = if (isStreamingTail) Modifier else Modifier.animateItem()
                    Box(itemModifier) {
                        Bubble(msg, showAvatar = msg.role != prevRole, streaming = isStreamingTail)
                    }
                    // Anchored to the specific turn that produced it, so it stays put
                    // in the transcript as later turns are added, instead of always
                    // trailing the newest message.
                    if (!revealing && actionWeekAnchor == i) actionWeek?.let { week ->
                        CalendarResultCard(
                            week,
                            changed = lastAction,
                            showReplan = showReplan,
                            onOpen = on.openCalendar,
                            onOpenDay = { date -> on.focusCalendar(date); on.openCalendar() },
                            onReplan = { on.rePlanWeek() },
                            onDismiss = { on.dismissActionCard() },
                        )
                    }
                }
                // A failed turn gets a one-tap retry directly under it.
                val last = messages.lastOrNull()
                if (!sending && last?.role == "assistant" && last.content.startsWith("⚠️")) {
                    item {
                        TextButton(onClick = { on.retryLast() }) { Text("Try again") }
                    }
                }
                if (sending) {
                    item {
                        // The agentic turn made visible as one line: it names the
                        // tool the coach is using right now, so a 30s plan feels
                        // like work happening rather than a stuck spinner. Before
                        // the first tool event, the plain typing indicator.
                        Column(Modifier.padding(8.dp)) {
                            val step = currentStep
                            if (step == null) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    TypingDots()
                                    Text(
                                        liveStatus ?: "Coach is thinking…",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(start = 10.dp),
                                    )
                                }
                            } else {
                                ToolStepRow(step)
                            }
                        }
                    }
                }
            }

            // The landing state. Fades and lifts away as the first message
            // lands, leaving the thread as the whole screen.
            //
            // AFTER the list, not before it. Underneath, the fillMaxSize
            // LazyColumn covered it: transparent, but it takes every touch AND
            // hides what is beneath it from the accessibility tree, so the hero
            // was unreadable to a screen reader and invisible to qa:device even
            // though it rendered perfectly in a screenshot. Nothing is lost by
            // drawing it on top: it only ever shows while the thread is empty,
            // and the first message removes it in the same frame it arrives.
            androidx.compose.animation.AnimatedVisibility(
                visible = messages.isEmpty(),
                modifier = Modifier.align(Alignment.Center),
                enter = fadeIn(),
                exit = fadeOut() + slideOutVertically { -it / 6 },
            ) {
                ChatHero(name = displayName)
            }

            // Jump back down when the reader has scrolled up into history.
            val scope = rememberCoroutineScope()
            androidx.compose.animation.AnimatedVisibility(
                visible = !atBottom,
                modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
                enter = fadeIn(),
                exit = fadeOut(),
            ) {
                SmallFloatingActionButton(
                    onClick = {
                        scope.launch {
                            val count = listState.layoutInfo.totalItemsCount
                            if (count > 0) listState.animateScrollToItem(count - 1)
                        }
                    },
                    containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ) {
                    Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "Scroll to latest")
                }
            }
        }

        // Quick-reply chips: starters on a fresh thread, contextual follow-ups
        // after a coach action ("Explain the week", "Make it easier", ...). One
        // row, one component; follow-ups clear on tap or when a new turn starts.
        // They belong HERE and not in the hero: the hero sits under the message
        // list, which covers it at fillMaxSize and eats every tap.
        val chips = if (messages.isEmpty()) suggestions else followUps
        if (chips.isNotEmpty() && !sending && !revealing) {
            LazyRow(
                Modifier.fillMaxWidth().padding(vertical = 4.dp),
                // contentPadding, not padding: with an outer horizontal padding
                // the last chip was clipped flat against the screen edge instead
                // of scrolling clear of it.
                contentPadding = PaddingValues(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(chips) { sgn ->
                    AssistChip(
                        onClick = { on.dismissFollowUps(); on.send(sgn.prompt) },
                        label = { Text(sgn.label) },
                    )
                }
            }
        }

        if (!revealing) banner?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }

        // Fallback only: the coach normally applies changes itself (its plan_week /
        // generate_workout tools land on the real calendar and the result card
        // shows above). This appears just for the rare turn where the coach
        // proposed sessions in prose without applying them — a manual escape hatch.
        // Saving a reusable template is tucked into the small "Save" menu.
        // lastAction is the reliable "the coach actually wrote something" signal:
        // it is set synchronously for EVERY write tool, whereas actionWeek only
        // loads for plan_week/generate_workout/move_workout and does so
        // asynchronously, leaving a window where this banner could claim a
        // successful plan "wasn't applied". A day-by-day table makes that far
        // likelier to be seen, since looksLikeWorkoutProposal matches on day names.
        val lastAssistant = messages.lastOrNull { it.role == "assistant" }?.content ?: ""
        // turnTools == null: nothing ran in this session (a thread reopened from
        // history), so there is no proposal to apply and no tool record to rule
        // one out either way.
        val proposalTools = turnTools
        if (!revealing && messages.size > 1 && actionWeek == null && lastAction == null &&
            proposalTools != null && proposalTools.none { it in setOf("get_planned_week", "get_today_plan") } &&
            looksLikeWorkoutProposal(lastAssistant)
        ) {
            Text(
                "Coach proposed this but didn't apply it:",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
            )
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                GhostButton(
                    onClick = {
                        on.send("Yes, apply that to my real calendar now and push it to my watch, then confirm exactly what you scheduled.")
                    },
                    enabled = !sending,
                    modifier = Modifier.weight(1f),
                ) { Text("📅 Put it on my calendar") }
                var templateMenu by remember { mutableStateOf(false) }
                Box {
                    TextButton(onClick = { templateMenu = true }, enabled = !sending) {
                        Text("Save ▾", style = MaterialTheme.typography.labelMedium)
                    }
                    DropdownMenu(
                        expanded = templateMenu,
                        onDismissRequest = { templateMenu = false },
                    ) {
                        DropdownMenuItem(
                            text = { Text("Save as workout template") },
                            onClick = { templateMenu = false; on.finalize("workout") },
                        )
                        DropdownMenuItem(
                            text = { Text("Save as plan template") },
                            onClick = { templateMenu = false; on.finalize("plan") },
                        )
                    }
                }
            }
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.surfaceContainerHigh)
        Row(
            Modifier.fillMaxWidth()
                .background(MaterialTheme.colorScheme.surfaceContainerLow)
                .padding(12.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it; if (it.isNotEmpty()) on.dismissFollowUps() },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Message your coach…") },
                shape = RoundedCornerShape(24.dp),
                // Long questions happen; grow with the text, cap before it eats
                // the thread. The send button anchors to the bottom edge.
                maxLines = 4,
            )
            val canSend = !sending && input.isNotBlank()
            val sendBg by animateColorAsState(
                if (canSend) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                label = "sendBg",
            )
            Box(
                Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(sendBg),
                contentAlignment = Alignment.Center,
            ) {
                IconButton(
                    onClick = { if (input.isNotBlank()) { on.send(input.trim()); input = "" } },
                    enabled = canSend,
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.Send,
                        contentDescription = "Send",
                        tint = if (canSend) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}








// --- workout rendering -------------------------------------------------------
