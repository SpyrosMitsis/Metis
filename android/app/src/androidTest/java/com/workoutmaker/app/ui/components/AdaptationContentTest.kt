package com.workoutmaker.app.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.workoutmaker.app.data.*
import com.workoutmaker.app.ui.theme.WorkoutMakerTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class AdaptationContentTest {
    @get:Rule val compose=createComposeRule()
    private val before=Workout(type="run",title="Familiar run",duration_minutes=20.0,tss_estimate=0.0,rpe_target=3.0,sections=emptyList(),coach_note="fixture")
    private val proposal=AdaptationProposal(id="fixture",changes=listOf(AdaptationChange("plan","2026-10-26",0,before,before.copy(duration_minutes=15.0),"Less dose")),explanation="Completed and locked sessions are preserved.",next_action="Use familiar easy work.")
    private fun show(state:AdaptationUiState,onAction:(String)->Unit={}) {
        compose.setContent { WorkoutMakerTheme { Column(Modifier.verticalScroll(rememberScrollState())) { AdaptationContent(state,object:AdaptationActions {
            override fun run(action:String,id:String?,minutes:Int?,unavailable:List<String>,alternative:String?){onAction(action)}
        }) } } }
    }
    @Test fun defaultViewOffersPreviewWithoutAnAutomaticChange() {
        var action:String?=null;show(AdaptationUiState()){action=it}
        compose.onNodeWithText("Apply these changes").assertDoesNotExist()
        compose.onNodeWithText("Preview changes").performClick();assertEquals("preview",action)
    }
    @Test fun anUnchangedPreviewExplainsTheResult() {
        show(AdaptationUiState(proposal=proposal.copy(changes=emptyList())))
        compose.onNodeWithText("No changes needed").assertIsDisplayed()
        compose.onNodeWithText(proposal.explanation).assertIsDisplayed()
        compose.onNodeWithText("Apply these changes").assertDoesNotExist()
    }
    @Test fun previewOnlyRolloutCannotOfferApply() {
        show(AdaptationUiState(proposal=proposal))
        compose.onNodeWithText("Apply these changes").assertDoesNotExist()
        compose.onNodeWithText("Plan adjustments are currently available as previews.").performScrollTo().assertIsDisplayed()
    }
    @Test fun applyingRequiresAnExplicitTapOnTheReviewedCandidate() {
        var action:String?=null;show(AdaptationUiState(proposal=proposal,applyAllowed=true)){action=it}
        assertEquals(null,action)
        compose.onNodeWithText("Apply these changes").performScrollTo().performClick();assertEquals("apply",action)
    }
    @Test fun appliedChangesExposeUndo() {
        var action:String?=null;show(AdaptationUiState(proposal=proposal.copy(state="applied"))){action=it}
        compose.onNodeWithText("Undo adaptation").performScrollTo().performClick();assertEquals("undo",action)
    }
}
