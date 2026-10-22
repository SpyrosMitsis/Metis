package com.workoutmaker.app.ui.screens.onboarding

import com.workoutmaker.app.util.runCatching

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.data.AppPreferences
import com.workoutmaker.app.data.AppSettings
import com.workoutmaker.app.data.LlmProvider
import com.workoutmaker.app.data.Race
import com.workoutmaker.app.data.TestKeyRequest
import com.workoutmaker.app.data.ThemeMode
import com.workoutmaker.app.data.ThemePalette
import com.workoutmaker.app.data.TrainingProfile
import com.workoutmaker.app.data.WorkoutRepository
import com.workoutmaker.app.data.deriveLegacyFields
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject
import android.app.Activity
import com.workoutmaker.app.billing.BillingGateway
import com.workoutmaker.app.billing.ProPurchaseResult
import com.workoutmaker.app.billing.purchaseAndVerify
import com.workoutmaker.app.calendar.DeviceCalendarManager
import com.workoutmaker.app.data.PlanWeekRequest
import com.workoutmaker.app.data.PlanWeekResult
import com.workoutmaker.app.health.HealthConnectManager
import com.workoutmaker.app.ui.components.Confetti
import com.workoutmaker.app.util.AppLog
import com.workoutmaker.app.util.friendlyFnError
import java.time.LocalDate
import kotlinx.coroutines.delay
import com.workoutmaker.app.data.addRace
import com.workoutmaker.app.data.connectIntervalsVerified
import com.workoutmaker.app.data.dailySummary
import com.workoutmaker.app.data.isOnboardingComplete
import com.workoutmaker.app.data.planStatus
import com.workoutmaker.app.data.planWeek
import com.workoutmaker.app.data.races
import com.workoutmaker.app.data.saveProfile
import com.workoutmaker.app.data.setActiveProvider
import com.workoutmaker.app.data.EnduranceGoals
import com.workoutmaker.app.ui.screens.settings.GoalDraft
import com.workoutmaker.app.data.setGoalRace
import com.workoutmaker.app.data.syncIntervals
import com.workoutmaker.app.data.testLlmKey

@HiltViewModel
class OnboardingViewModel @Inject constructor(
    private val repo: WorkoutRepository,
    private val prefs: AppPreferences,
    private val billing: BillingGateway,
    private val health: HealthConnectManager,
    private val deviceCalendar: DeviceCalendarManager,
) : ViewModel() {
    val complete = MutableStateFlow<Boolean?>(null)
    val accountError = MutableStateFlow<String?>(null)
    val step = MutableStateFlow(0)
    val profile = MutableStateFlow(TrainingProfile())
    val keyStatus = MutableStateFlow<String?>(null)
    val intervalsStatus = MutableStateFlow<String?>(null)
    val finishStatus = MutableStateFlow<String?>(null)
    val busy = MutableStateFlow(false)
    var provider by mutableStateOf(LlmProvider.GROQ)

    // Appearance step: same device-local theme prefs the Settings screen edits.
    val appSettings = prefs.settings.stateIn(viewModelScope, SharingStarted.Eagerly, AppSettings())
    fun setThemeMode(m: ThemeMode) = viewModelScope.launch { prefs.setThemeMode(m) }
    fun setThemePalette(p: ThemePalette) = viewModelScope.launch { prefs.setThemePalette(p) }

    // Permissions step: the same managers Settings uses, so "granted" here and
    // "granted" there can never disagree.
    val healthAvailable: Boolean get() = health.isAvailable
    val healthPermissions: Set<String> get() = health.permissions
    suspend fun grantedHealthPerms(): Set<String> = health.grantedPermissions()
    fun calendarReadGranted() = deviceCalendar.hasReadPermission()
    fun calendarWriteGranted() = deviceCalendar.hasWritePermission()
    fun setCalendarRead(on: Boolean) = viewModelScope.launch { prefs.setCalendarRead(on) }
    fun setCalendarWrite(on: Boolean) = viewModelScope.launch { prefs.setCalendarWrite(on) }

    // Zero-setup Pro path: shown only when this build can bill AND this server
    // hosts an LLM key. The one summary fetch also warms the Room cache.
    val hostedAvailable = MutableStateFlow(false)
    val proActive = MutableStateFlow(false)
    val proBusy = MutableStateFlow(false)
    val proError = MutableStateFlow<String?>(null)

    init {
        recheck()
    }

    // Billing state is PER ACCOUNT: it must reload every time the signed-in
    // user changes, not once per ViewModel. Fetching it only in init meant a
    // fresh sign-up on a device whose previous account had Pro saw "Pro is
    // active" during onboarding, while actually being free.
    private fun refreshBilling() {
        hostedAvailable.value = false
        proActive.value = false
        if (!billing.supported) return
        viewModelScope.launch {
            runCatching {
                val summary = repo.dailySummary()
                hostedAvailable.value = summary.server?.hosted_ai == true
                proActive.value = repo.planStatus().isPro
            }
        }
    }
    fun currentUserId(): String? = repo.auth.currentUserOrNull()?.id

    // Re-runs whenever the authenticated user changes (OnboardingGate keys on
    // the uid): first scope-checks local per-account data, then asks the server
    // whether onboarding is done. Never serves a previous user's answer.
    private var checkedUid: String? = null
    fun recheck() = viewModelScope.launch {
        val uid = currentUserId()
        if (uid != checkedUid) complete.value = null
        checkedUid = uid
        accountError.value = null
        runCatching {
            repo.ensureAccountScope()
            complete.value = repo.isOnboardingComplete()
            refreshBilling()
        }.onFailure {
            complete.value = null
            accountError.value = "Couldn't prepare your account data. Please retry."
        }
    }

    fun buyPro(activity: Activity) = viewModelScope.launch {
        proBusy.value = true
        proError.value = null
        when (val r = purchaseAndVerify(activity, billing, repo)) {
            // Success only means the server VERIFIED the token, not that it granted
            // Pro: a pending/on-hold purchase verifies fine and still returns "free".
            // Re-read the plan columns rather than assuming (Settings does the same).
            is ProPurchaseResult.Success -> {
                proActive.value = repo.planStatus().isPro
                if (!proActive.value) {
                    proError.value = "Google Play is still confirming your purchase. " +
                        "Pro switches on by itself once it clears."
                }
            }
            is ProPurchaseResult.Cancelled -> Unit
            is ProPurchaseResult.Failed -> proError.value = r.message
        }
        proBusy.value = false
    }

    // First-week preview on the review step: the payoff moment. plan-week reads
    // the profile from the DB, so save the in-progress answers first — safe,
    // because OnboardingGate keys on OUR `complete` flag (set only in finish()),
    // not the DB column, so the screen stays put. push=false: no watch spam
    // before the athlete has even entered the app.
    val previewWeek = MutableStateFlow<PlanWeekResult?>(null)
    val previewBusy = MutableStateFlow(false)
    val previewError = MutableStateFlow<String?>(null)
    fun previewFirstWeek() = viewModelScope.launch {
        previewBusy.value = true
        previewError.value = null
        runCatching {
            repo.saveProfile(profile.value.deriveLegacyFields())
            repo.planWeek(
                PlanWeekRequest(
                    start_date = LocalDate.now().toString(),
                    push = false,
                ),
            )
        }.onSuccess { previewWeek.value = it }
            .onFailure {
                AppLog.w("onboarding", "preview failed", it)
                previewError.value = friendlyFnError(
                    it, "Couldn't build the preview. Finish setup and plan from the app instead.",
                )
            }
        previewBusy.value = false
    }

    fun update(t: (TrainingProfile) -> TrainingProfile) { profile.value = t(profile.value) }
    fun goNext(lastIndex: Int) { step.value = (step.value + 1).coerceAtMost(lastIndex) }
    fun goBack() { step.value = (step.value - 1).coerceAtLeast(0) }

    // The goal race is stored in the races table (safe mid-onboarding), but the
    // goal date/pace is set LOCALLY on the in-progress profile — NOT saved yet.
    // Calling repo.setGoalRace here would flip onboarding_complete early and wipe
    // the in-progress answers, so finish() is the single persist point.
    internal fun addGoalRace(draft: GoalDraft) = viewModelScope.launch {
        val race = draft.race
        runCatching { repo.addRace(race) }
        if (draft.setAsGoal) {
            val pace = race.target?.takeIf { race.sport == "run" && it.isNotBlank() }
            update { p ->
                // The distance goal alongside the date: the race row is not what
                // the planner reads, the profile's per-sport target is.
                val withTarget = if (draft.km != null) {
                    p.copy(
                        distance_goal_km = p.distance_goal_km + (race.sport to draft.km),
                        goal_pace_sec_per_km = draft.paceSec
                            ?.let { p.goal_pace_sec_per_km + (race.sport to it) }
                            ?: p.goal_pace_sec_per_km,
                        goals_by_sport = p.goals_by_sport + (race.sport to EnduranceGoals.withDistanceGoal(
                            p.goals_by_sport[race.sport].orEmpty(), race.sport, draft.km,
                        )),
                    )
                } else {
                    p
                }
                withTarget.copy(goal_date = race.date, target_pace = pace ?: withTarget.target_pace)
            }
        }
    }

    fun testKey(key: String) = viewModelScope.launch {
        busy.value = true
        keyStatus.value = "Testing…"
        runCatching { repo.testLlmKey(TestKeyRequest(provider.key, key.trim())) }
            .onSuccess {
                if (it.is_valid) { repo.setActiveProvider(provider); keyStatus.value = "✓ ${provider.label} key saved & active" }
                else keyStatus.value = "✗ ${it.error ?: "invalid key"}"
            }
            .onFailure { keyStatus.value = "Failed: ${it.message}" }
        busy.value = false
    }

    fun connect(athleteId: String, key: String) = viewModelScope.launch {
        busy.value = true
        intervalsStatus.value = "Connecting…"
        runCatching { repo.connectIntervalsVerified(athleteId.trim(), key.trim()) }
            .onSuccess {
                intervalsStatus.value = if (it.ok) "✓ Connected as ${it.athlete_name}" else "Failed: ${it.error}"
                if (it.ok) runCatching { repo.syncIntervals() }
            }
            .onFailure { intervalsStatus.value = "Failed: ${it.message}" }
        busy.value = false
    }

    // Set between a successful save and actually entering the app, so the
    // celebration has a moment to play. OnboardingGate swaps this screen out the
    // instant `complete` flips, which would otherwise kill the animation on the
    // frame it started. Only ever set here, on an explicit Finish: a cold-start
    // restore goes through recheck(), so returning users never see confetti.
    val celebrating = MutableStateFlow(false)

    // [celebrate] is false when skipping setup (nothing to celebrate) and when the
    // user has animations turned off, in which case we enter the app immediately
    // rather than make them wait out an animation they will never see.
    fun finish(celebrate: Boolean = false) = viewModelScope.launch {
        busy.value = true
        finishStatus.value = null
        // Derive the single-value fields the live backend reads from the rich ones.
        runCatching { repo.saveProfile(profile.value.deriveLegacyFields()) }
            // saveProfile flips onboarding_complete → enters the app. Entering
            // without the save would leave every downstream feature profileless.
            .onSuccess {
                if (celebrate) {
                    celebrating.value = true
                    delay(CELEBRATION_MS)
                }
                complete.value = true
            }
            .onFailure { finishStatus.value = "Couldn't save your profile: ${it.message}. Check your connection and try again." }
        busy.value = false
    }

    private companion object {
        // Long enough for Confetti's DURATION_MS burst to play out fully (it is
        // deliberately shorter), short enough not to feel like a loading screen.
        const val CELEBRATION_MS = 2_400L
    }
}
