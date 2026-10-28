package com.workoutmaker.app.ui.screens.coach

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertCountEquals
import com.workoutmaker.app.data.ChatMessage
import com.workoutmaker.app.ui.theme.WorkoutMakerTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

// The coach screen, composed for real.
//
// Every case here is a regression that was found by hand on the phone, because
// nothing in the suite could reach a rendering decision. They are cheap to
// assert now that CoachContent takes a state object (see CoachUiState.kt).
class CoachContentTest {

    @get:Rule val compose = createComposeRule()

    private fun show(state: CoachState, on: CoachActions = CoachActions()) {
        compose.setContent { WorkoutMakerTheme { CoachContent(state, on) } }
    }

    private val starters = listOf(
        CoachStarter("How's my fitness?", "prompt-fitness"),
        CoachStarter("Plan my week", "prompt-plan"),
    )

    // The original bug: the hero sat under a fillMaxSize LazyColumn, which is
    // transparent but eats every touch, so the chips looked fine and did
    // nothing. A click has to reach the callback, not merely find the node.
    @Test fun starterChipSends() {
        var sent: String? = null
        show(
            CoachState(suggestions = starters),
            CoachActions(send = { sent = it }),
        )
        compose.onNodeWithText("Plan my week").performClick()
        assertEquals("prompt-plan", sent)
    }

    // Driven through one composition rather than two: the hero LEAVING as the
    // first message lands is the behaviour, not two independent snapshots.
    @Test fun theHeroLeavesWhenTheFirstMessageLands() {
        val messages = mutableStateOf(emptyList<ChatMessage>())
        compose.setContent {
            WorkoutMakerTheme {
                CoachContent(CoachState(displayName = "Spyros", messages = messages.value))
            }
        }
        compose.onNodeWithText(HERO_SUBTITLE).assertIsDisplayed()

        messages.value = listOf(ChatMessage("user", "hi"), ChatMessage("assistant", "hey"))
        compose.waitForIdle()
        compose.onAllNodesWithText(HERO_SUBTITLE).assertCountEquals(0)
    }

    // A 13-tool turn used to stack 13 rows, pushing the composer off screen.
    @Test fun onlyTheCurrentToolStepIsShown() {
        show(
            CoachState(
                messages = listOf(ChatMessage("user", "plan my week")),
                sending = true,
                currentStep = CoachViewModel.ToolStep("Reading your week", write = false),
            ),
        )
        compose.onNodeWithText("Reading your week").assertIsDisplayed()
        // The generic line is replaced by the step, never shown beside it.
        compose.onAllNodesWithText("Coach is thinking…").assertCountEquals(0)
    }

    @Test fun aFailedTurnOffersRetry() {
        var retried = false
        show(
            CoachState(
                messages = listOf(
                    ChatMessage("user", "hi"),
                    ChatMessage("assistant", "⚠️ The coach didn't answer."),
                ),
            ),
            CoachActions(retryLast = { retried = true }),
        )
        compose.onNodeWithText("Try again").performClick()
        assertEquals(true, retried)
    }

    // ---- the proposal banner, three ways -----------------------------------
    //
    // looksLikeWorkoutProposal fires on three or more day names, so ANY answer
    // describing the athlete's week trips it. What separates a proposal from a
    // description is whether the turn READ the plan, which is what turnTools
    // carries. Both false-positive states below were seen on device.

    private val describesTheWeek =
        "Here's how the week sits: Monday is your full body strength session, " +
            "Tuesday an easy run with strides, Thursday strength again, and " +
            "Saturday the long run. Nothing to change."

    private fun threadEndingIn(reply: String) = listOf(
        ChatMessage("user", "how's my fitness?"),
        ChatMessage("assistant", reply),
    )

    @Test fun bannerShowsWhenTheCoachProposedWithoutReadingThePlan() {
        show(CoachState(messages = threadEndingIn(describesTheWeek), turnTools = listOf("get_profile")))
        compose.onNodeWithText(PROPOSAL_BANNER).assertIsDisplayed()
    }

    @Test fun bannerHiddenWhenTheTurnReadThePlannedWeek() {
        show(
            CoachState(
                messages = threadEndingIn(describesTheWeek),
                turnTools = listOf("get_planned_week"),
            ),
        )
        compose.onAllNodesWithText(PROPOSAL_BANNER).assertCountEquals(0)
    }

    @Test fun bannerHiddenAfterReadingTodaysSavedWorkout() {
        show(CoachState(messages = threadEndingIn(describesTheWeek), turnTools = listOf("get_today_plan")))
        compose.onAllNodesWithText(PROPOSAL_BANNER).assertCountEquals(0)
        compose.onAllNodesWithText("📅 Put it on my calendar").assertCountEquals(0)
    }

    // Reopened from history: no tool record survives, so there is no live turn
    // to judge and nothing was proposed in this session.
    @Test fun bannerHiddenOnAThreadRestoredFromHistory() {
        show(CoachState(messages = threadEndingIn(describesTheWeek), turnTools = null))
        compose.onAllNodesWithText(PROPOSAL_BANNER).assertCountEquals(0)
    }

    // The original bug: the calendar result card was always the trailing item in
    // the list, so it re-settled under whatever the newest message was. It must
    // stay anchored to the turn that produced it (index 1 here) even once later
    // turns push the "newest message" well past it.
    @Test fun calendarCardStaysAnchoredPastLaterTurns() {
        val messages = mutableStateOf(
            listOf(ChatMessage("user", "clear the week"), ChatMessage("assistant", "Done.")),
        )
        compose.setContent {
            WorkoutMakerTheme {
                CoachContent(
                    CoachState(
                        messages = messages.value,
                        actionWeek = emptyList(),
                        actionWeekAnchor = 1,
                        lastAction = "cleared the week",
                    ),
                )
            }
        }
        // SectionLabel uppercases its text, so match the plain "View in
        // calendar" button instead of the "✓ Updated your calendar" label.
        compose.onNodeWithText("View in calendar").assertIsDisplayed()

        // A later, unrelated turn arrives; the anchor is untouched (no write
        // tool ran), same as the real ViewModel only reassigns it in loadActionWeek.
        messages.value = messages.value + listOf(
            ChatMessage("user", "how's my fitness?"),
            ChatMessage("assistant", "Looking solid."),
        )
        compose.waitForIdle()
        compose.onNodeWithText("View in calendar").assertIsDisplayed()
    }

    private companion object {
        const val PROPOSAL_BANNER = "Coach proposed this but didn't apply it:"
    }
}
