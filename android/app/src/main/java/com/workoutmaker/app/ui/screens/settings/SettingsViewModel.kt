package com.workoutmaker.app.ui.screens.settings

import com.workoutmaker.app.util.runCatching

import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.data.AppPreferences
import com.workoutmaker.app.data.AppSettings
import com.workoutmaker.app.data.LlmProvider
import com.workoutmaker.app.data.TestKeyRequest
import com.workoutmaker.app.data.TestKeyResponse
import com.workoutmaker.app.data.TrainingProfile
import com.workoutmaker.app.data.WeightUnit
import com.workoutmaker.app.data.WorkoutRepository
import com.workoutmaker.app.data.EnduranceGoals
import com.workoutmaker.app.data.deriveLegacyFields
import com.workoutmaker.app.data.format
import com.workoutmaker.app.data.hydrateRichFromLegacy
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject
import android.app.Activity
import android.util.Log
import androidx.compose.runtime.mutableStateMapOf
import com.workoutmaker.app.billing.BillingGateway
import com.workoutmaker.app.billing.ProPurchaseResult
import com.workoutmaker.app.billing.purchaseAndVerify
import com.workoutmaker.app.calendar.DeviceCalendarManager
import com.workoutmaker.app.data.GenerationLogRow
import com.workoutmaker.app.data.LlmKeyRow
import com.workoutmaker.app.data.ModelListResponse
import com.workoutmaker.app.data.PlanStatus
import com.workoutmaker.app.data.Race
import com.workoutmaker.app.data.RestChime
import com.workoutmaker.app.data.ThemeMode
import com.workoutmaker.app.data.ThemePalette
import com.workoutmaker.app.data.ThresholdTest
import com.workoutmaker.app.health.HealthConnectManager
import com.workoutmaker.app.strength.ImportSummary
import com.workoutmaker.app.strength.StrengthRepository
import com.workoutmaker.app.util.AppLog
import java.time.LocalDate
import com.workoutmaker.app.data.addRace
import com.workoutmaker.app.data.addThresholdTest
import com.workoutmaker.app.data.autoPlanEnabled
import com.workoutmaker.app.data.connectIntervals
import com.workoutmaker.app.data.connectIntervalsVerified
import com.workoutmaker.app.data.customLlmPricing
import com.workoutmaker.app.data.deleteRace
import com.workoutmaker.app.data.generationLogs
import com.workoutmaker.app.data.intervalsConnection
import com.workoutmaker.app.data.listModels
import com.workoutmaker.app.data.llmKeyRows
import com.workoutmaker.app.data.loadKnowledge
import com.workoutmaker.app.data.loadMemory
import com.workoutmaker.app.data.loadProfile
import com.workoutmaker.app.data.loadSoul
import com.workoutmaker.app.data.modelOverrides
import com.workoutmaker.app.data.planStatus
import com.workoutmaker.app.data.races
import com.workoutmaker.app.data.refreshMemory
import com.workoutmaker.app.data.saveKnowledge
import com.workoutmaker.app.data.saveMemory
import com.workoutmaker.app.data.saveProfile
import com.workoutmaker.app.data.saveSoul
import com.workoutmaker.app.data.serverHostedAi
import com.workoutmaker.app.data.setActiveProvider
import com.workoutmaker.app.data.setAutoPlan
import com.workoutmaker.app.data.setCustomLlmPricing
import com.workoutmaker.app.data.setGoalRace
import com.workoutmaker.app.data.setModelOverride
import com.workoutmaker.app.data.setUseHostedAi
import com.workoutmaker.app.data.syncHealth
import com.workoutmaker.app.data.syncIntervals
import com.workoutmaker.app.data.syncPlanToDeviceCalendar
import com.workoutmaker.app.data.testLlmKey
import com.workoutmaker.app.data.thresholdTests
import com.workoutmaker.app.data.verifyPurchase

internal val DAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

internal val LEVELS = listOf("Beginner", "Intermediate", "Advanced")

internal val SPLIT_STYLES = listOf("Auto", "Full body", "Upper / lower", "Push / pull / legs")

// Canonical sport keys (stored); UI capitalizes them. Match workout `type` values.
internal val SPORTS = listOf("run", "ride", "swim", "strength")

internal val BAR_WEIGHTS = listOf(20.0, 15.0, 10.0, 7.0)

// --- Richer onboarding catalogs (shared by onboarding + Settings) ----------

// Goals are asked per activity: pick an activity, then its goal(s) + level.
internal val GOALS_BY_SPORT: Map<String, List<String>> = mapOf(
    "run" to listOf("5K", "10K", "Half Marathon", "Marathon", "Run faster", "General fitness"),
    "ride" to listOf("Build FTP / power", "Go longer", "Racing", "General fitness"),
    "swim" to listOf("Faster times", "Swim further", "Technique", "General fitness"),
    "strength" to listOf("Build muscle", "Get stronger", "Lose fat", "Body recomposition", "General fitness"),
)

// These labels describe a dated event, not a broad training intent. They stay
// in the shared catalog for existing Settings profiles, but onboarding collects
// them through the single optional target-event step instead of offering them
// twice.
internal val RACE_GOALS = setOf("5K", "10K", "Half Marathon", "Marathon", "Racing", "Faster times")

// Experience is tracked per activity, with sport-appropriate rungs.
internal val EXPERIENCE_BY_SPORT: Map<String, List<String>> = mapOf(
    "strength" to listOf("Beginner", "Novice", "Intermediate", "Advanced"),
    "run" to listOf("Never ran", "Beginner", "Intermediate", "Experienced"),
    "ride" to listOf("Beginner", "Intermediate", "Advanced"),
    "swim" to listOf("Beginner", "Intermediate", "Advanced"),
)

// Multi-select equipment; only shown when the athlete lifts.
internal val EQUIPMENT_ITEMS = listOf(
    "Full gym", "Dumbbells", "Barbell", "Bench", "Squat rack",
    "Resistance bands", "Band anchor", "Pull-up bar", "Kettlebells", "Cable machine", "Machines", "Treadmill", "Indoor trainer", "Stationary bike", "Power meter",
)

// Quick-add chips for the onboarding injuries step (appended to the free text).
internal val INJURY_AREAS = listOf(
    "Knee", "Lower back", "Shoulder", "Hamstring", "Achilles", "Wrist",
)

// --- Weekly availability, "few questions" model ----------------------------
internal val DAYS_PER_WEEK = listOf(2, 3, 4, 5, 6)
internal val TYPICAL_MINUTES = listOf(45, 60, 90)
internal val LONG_MINUTES = listOf(90, 120, 180)

// A sensible weekday spread for a chosen days-per-week count. The optional long
// day is forced into whichever pattern applies (see buildAvailability).
internal val DAY_PATTERNS: Map<Int, List<String>> = mapOf(
    2 to listOf("Tue", "Sat"),
    3 to listOf("Mon", "Wed", "Fri"),
    4 to listOf("Mon", "Tue", "Thu", "Sat"),
    5 to listOf("Mon", "Tue", "Wed", "Fri", "Sat"),
    6 to listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat"),
)

// Human labels for the canonical sport keys (onboarding-facing).
internal fun sportLabel(key: String): String = when (key) {
    "run" -> "Running"
    "ride" -> "Cycling"
    "swim" -> "Swimming"
    "strength" -> "Gym"
    else -> key.replaceFirstChar { it.uppercase() }
}

// Equipment step is only relevant when the athlete trains in the gym.
// sportNeedsEquipment() lived here to gate a standalone equipment step. The kit
// question belongs to the gym now and is added with the gym's other three, so
// the gate is just "did they pick the gym", asked where the steps are built.

// A target event is optional metadata ON TOP OF an endurance training goal.
// Offer it to every endurance athlete, rather than making it appear only after
// they picked a race-shaped label such as "10K". That keeps "I want to run
// farther" distinct from "I am racing Copenhagen Half on this date".
internal fun shouldOfferTargetEvent(p: TrainingProfile): Boolean =
    p.sports.any { EnduranceGoals.isEndurance(it) }

// Best-effort migration: assign each legacy flat goal to the activity whose
// catalog lists it, so an existing account pre-fills the per-activity editors.
internal fun legacyGoalsBySport(p: TrainingProfile): Map<String, List<String>> {
    val flat = p.goals.ifEmpty {
        p.goal?.split(" + ")?.map { it.trim() }?.filter { it.isNotBlank() } ?: emptyList()
    }
    if (flat.isEmpty()) return emptyMap()
    val out = mutableMapOf<String, MutableList<String>>()
    flat.forEach { g ->
        GOALS_BY_SPORT.entries.firstOrNull { (_, list) -> list.any { it.equals(g, ignoreCase = true) } }
            ?.let { (sport, list) -> out.getOrPut(sport) { mutableListOf() }.add(list.first { it.equals(g, ignoreCase = true) }) }
    }
    return out.mapValues { it.value.toList() }
}

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val repo: WorkoutRepository,
    private val prefs: AppPreferences,
    private val strength: StrengthRepository,
    private val health: HealthConnectManager,
    private val billing: BillingGateway,
    private val deviceCalendar: DeviceCalendarManager,
) : ViewModel() {

    // --- Device calendar (read busy times / write workouts, both opt-in) ----
    val calendarStatus = MutableStateFlow<String?>(null)
    fun calendarReadGranted() = deviceCalendar.hasReadPermission()
    fun calendarWriteGranted() = deviceCalendar.hasWritePermission()
    fun setCalendarStatus(msg: String?) { calendarStatus.value = msg }

    fun setCalendarRead(on: Boolean) = viewModelScope.launch {
        prefs.setCalendarRead(on)
        calendarStatus.value = if (on) "The coach will plan around your busy times from the next plan on." else null
    }

    fun setCalendarWrite(on: Boolean) = viewModelScope.launch {
        prefs.setCalendarWrite(on)
        if (on) {
            runCatching { repo.syncPlanToDeviceCalendar() }
            calendarStatus.value = "Planned workouts now appear as all-day events in your calendar."
        } else {
            runCatching { deviceCalendar.clearAll() }
            calendarStatus.value = "Removed the app's events from your calendar."
        }
    }

    // --- Pro plan / hosted AI (only when this build can bill AND this server
    // hosts an LLM key — self-hosted stacks and foss builds never see it) ----
    val planStatus = MutableStateFlow(PlanStatus())
    val proAvailable = MutableStateFlow(false)
    val proBusy = MutableStateFlow(false)
    val proError = MutableStateFlow<String?>(null)

    fun buyPro(activity: Activity) = viewModelScope.launch {
        proBusy.value = true
        proError.value = null
        when (val r = purchaseAndVerify(activity, billing, repo)) {
            is ProPurchaseResult.Success -> planStatus.value = repo.planStatus()
            is ProPurchaseResult.Cancelled -> Unit
            is ProPurchaseResult.Failed -> proError.value = r.message
        }
        proBusy.value = false
    }

    // Re-verify a purchase Play already knows about (bought on another device,
    // or verify failed right after the buy).
    fun restorePro() = viewModelScope.launch {
        proBusy.value = true
        proError.value = null
        runCatching {
            val token = billing.currentPurchaseToken() ?: error("No active subscription found on this Google account.")
            repo.verifyPurchase(token)
            planStatus.value = repo.planStatus()
        }.onFailure { proError.value = it.message }
        proBusy.value = false
    }

    fun setUseHostedAi(on: Boolean) = viewModelScope.launch {
        runCatching { repo.setUseHostedAi(on) }
            .onSuccess { planStatus.value = planStatus.value.copy(useHostedAi = on) }
    }

    // --- Support the developer (one-time tips / Ko-fi) ----------------------
    // Same section in both flavors; only the rail differs: Play builds tip
    // through Play Billing, foss builds open Ko-fi in the browser.
    val tipsSupported: Boolean get() = billing.tipsSupported
    val tipBusy = MutableStateFlow(false)
    val tipStatus = MutableStateFlow<String?>(null)

    // Play's real localized prices, filled in once Play answers. Starts empty so
    // the UI shows TIP_FALLBACK_PRICES rather than a blank button.
    val tipPrices = MutableStateFlow<Map<String, String>>(emptyMap())

    fun loadTipPrices() = viewModelScope.launch {
        if (!billing.tipsSupported || tipPrices.value.isNotEmpty()) return@launch
        tipPrices.value = runCatching { billing.tipPrices() }.getOrDefault(emptyMap())
    }

    fun sendTip(activity: Activity, productId: String) = viewModelScope.launch {
        tipBusy.value = true
        tipStatus.value = null
        val ok = runCatching { billing.tip(activity, productId) }.getOrDefault(false)
        tipStatus.value = if (ok) "Thank you! Every tip helps." else "Tip not completed. Nothing was charged."
        tipBusy.value = false
    }

    // CSV import (Strong / Hevy) lives in Settings → Import data.
    val importStatus = MutableStateFlow<String?>(null)
    val importBusy = MutableStateFlow(false)
    // Set once an import finishes so the UI can show a detailed result dialog.
    val importResult = MutableStateFlow<ImportSummary?>(null)
    fun dismissImportResult() { importResult.value = null }
    fun importCsv(text: String) = viewModelScope.launch {
        importBusy.value = true
        importStatus.value = "Importing…"
        runCatching { strength.importCsv(text) }
            .onSuccess { s ->
                importResult.value = s
                importStatus.value = if (s.ok)
                    "✓ Imported ${s.workoutsAdded} ${s.format} workouts (${s.setsAdded} sets)" +
                        (if (s.duplicatesSkipped > 0) " · ${s.duplicatesSkipped} already imported" else "")
                else "Import failed: ${s.error}"
            }
            .onFailure {
                Log.e("IMPORT", "import threw", it)
                importResult.value = ImportSummary(
                    ok = false, error = "${it::class.simpleName}: ${it.message ?: "unknown error"}")
                importStatus.value = "Import failed: ${it.message}"
            }
        importBusy.value = false
    }
    val results = mutableStateMapOf<String, TestKeyResponse>()
    var active by mutableStateOf(LlmProvider.GROQ)

    // Dynamic model selector: per-provider override + live model lists.
    val modelOverrides = MutableStateFlow<Map<String, String>>(emptyMap())
    val modelLists = mutableStateMapOf<String, ModelListResponse>()
    val modelBusy = MutableStateFlow<String?>(null)

    fun loadModels(p: LlmProvider) = viewModelScope.launch {
        modelBusy.value = p.key
        runCatching { repo.listModels(p) }
            .onSuccess { modelLists[p.key] = it }
            .onFailure {
                modelLists[p.key] = ModelListResponse(
                    provider = p.key, error = it.message ?: "couldn't fetch models")
            }
        modelBusy.value = null
    }

    fun setModel(p: LlmProvider, model: String?) = viewModelScope.launch {
        runCatching {
            repo.setModelOverride(p, model)
            modelOverrides.value = repo.modelOverrides()
        }.onFailure { saveStatus.value = "Couldn't set model: ${it.message}" }
    }

    val profile = MutableStateFlow(TrainingProfile())
    val intervalsStatus = MutableStateFlow<String?>(null)
    val saveStatus = MutableStateFlow<String?>(null)
    val busy = MutableStateFlow(false)

    // Device-local app settings (units, rest defaults, vibration, etc.).
    val appSettings = prefs.settings.stateIn(viewModelScope, SharingStarted.Eagerly, AppSettings())
    fun setUnits(u: WeightUnit) = viewModelScope.launch { prefs.setUnits(u) }
    fun setDefaultRest(sec: Int) = viewModelScope.launch { prefs.setDefaultRest(sec) }
    fun setBarbell(kg: Double) = viewModelScope.launch { prefs.setBarbell(kg) }
    fun setRestVibrate(on: Boolean) = viewModelScope.launch { prefs.setRestVibrate(on) }
    fun setRestNotify(on: Boolean) = viewModelScope.launch { prefs.setRestNotify(on) }
    fun setMorningNotify(on: Boolean) = viewModelScope.launch { prefs.setMorningNotify(on) }
    fun setDebugLogSharing(on: Boolean) = viewModelScope.launch {
        prefs.setDebugLogSharing(on)
        // Send what's already local right away, rather than waiting for the
        // next cold start — turning it on should feel immediate.
        if (on) repo.uploadDebugLogIfEnabled()
    }
    fun setRestChime(c: RestChime) = viewModelScope.launch { prefs.setRestChime(c) }
    fun setKeepScreenOn(on: Boolean) = viewModelScope.launch { prefs.setKeepScreenOn(on) }
    fun setThemeMode(m: ThemeMode) = viewModelScope.launch { prefs.setThemeMode(m) }
    fun setThemePalette(p: ThemePalette) = viewModelScope.launch { prefs.setThemePalette(p) }
    fun setSpendCap(usd: Double) = viewModelScope.launch { prefs.setSpendCap(usd) }

    // Performance numbers the athlete has told us to stop asking about.
    val hushedNumbers = prefs.hushedNumbers.stateIn(viewModelScope, SharingStarted.Eagerly, emptySet())
    fun setNumberHushed(name: String, hushed: Boolean) = viewModelScope.launch {
        prefs.setNumberHushed(name, hushed)
    }

    val setupNudge = prefs.setupNudge.stateIn(viewModelScope, SharingStarted.Eagerly, SetupNudge())
    fun dismissSetupCard() = viewModelScope.launch { prefs.dismissSetupCard() }

    // Q11: build a Strong-compatible CSV of all strength history for the user to save.
    suspend fun buildExportCsv(): String = strength.exportCsv()

    // --- Health Connect ---------------------------------------------------
    val healthAvailable: Boolean get() = health.isAvailable
    val healthPermissions: Set<String> get() = health.permissions
    val healthProviderPackage: String get() = health.providerPackage
    val healthStatus = MutableStateFlow<String?>(null)

    /** Granted read permissions — syncing works with a partial grant too. */
    suspend fun grantedHealthPerms(): Set<String> = health.grantedPermissions()
    fun setHealthStatus(msg: String) { healthStatus.value = msg }

    fun syncHealth() = viewModelScope.launch {
        healthStatus.value = "Reading Health Connect (7-day trend)…"
        runCatching {
            // Shared implementation with Home/Calendar: wellness week + watch
            // workouts (the latter only when intervals.icu isn't connected).
            val result = repo.syncHealth()
            val week = result.week
            if (week.isEmpty() && result.activitiesUpserted == 0) {
                healthStatus.value = "No HRV/HR/sleep data found in Health Connect yet."
                return@launch
            }
            val today = week.firstOrNull { it.date == LocalDate.now().toString() } ?: week.firstOrNull()
            healthStatus.value = buildString {
                append("✓ Synced ${week.size} days")
                today?.hrvRmssd?.let { append(" · HRV ${"%.0f".format(it)}ms") }
                today?.restingHr?.let { append(" · RHR $it") }
                today?.sleepMinutes?.let { append(" · sleep ${it / 60}h${it % 60}m") }
                if (result.activitiesUpserted > 0) append(" · ${result.activitiesUpserted} workouts")
            }
        }.onFailure { healthStatus.value = "Failed: ${it.message}" }
    }

    val autoPlan = MutableStateFlow(false)
    val logs = MutableStateFlow<List<GenerationLogRow>>(emptyList())
    fun reloadLogs() = viewModelScope.launch {
        runCatching { repo.generationLogs() }.onSuccess { logs.value = it }
            .onFailure { AppLog.w("settings", "generationLogs failed", it) }
    }

    // Durable coaching knowledge (injuries, equipment, preferences).
    val knowledge = MutableStateFlow("")
    val knowledgeStatus = MutableStateFlow<String?>(null)

    // Rolling coach memory — durable notes the coach carries between sessions.
    val memory = MutableStateFlow("")
    val memoryStatus = MutableStateFlow<String?>(null)

    // Coach soul — the coach's identity/voice + its evolving relationship with you.
    val soul = MutableStateFlow("")
    val soulStatus = MutableStateFlow<String?>(null)

    // P1 races + E4 threshold tests.
    val races = MutableStateFlow<List<Race>>(emptyList())
    val thresholdTests = MutableStateFlow<List<ThresholdTest>>(emptyList())

    // Saved credentials, shown masked so it's clear what's already configured:
    // Intervals.icu (athlete id + key hint) and per-provider LLM key rows.
    val intervalsSaved = MutableStateFlow<Pair<String, String?>?>(null)
    val llmKeys = MutableStateFlow<Map<String, LlmKeyRow>>(emptyMap())
    // Custom (BYO) provider per-1M-token prices, so its cost isn't shown as $0.
    val customPrice = MutableStateFlow<Pair<Double?, Double?>>(null to null)

    fun load() = viewModelScope.launch {
        // Pre-populate the richer editors from an existing account's single-value profile.
        repo.loadProfile()?.let { p ->
            val hydrated = p.hydrateRichFromLegacy()
            profile.value = if (hydrated.goals_by_sport.isEmpty())
                hydrated.copy(goals_by_sport = legacyGoalsBySport(hydrated)) else hydrated
        }
        runCatching { repo.planStatus() }.onSuccess { planStatus.value = it }
        proAvailable.value = billing.supported && repo.serverHostedAi()
        autoPlan.value = repo.autoPlanEnabled()
        runCatching { repo.modelOverrides() }.onSuccess { modelOverrides.value = it }
        runCatching { repo.loadKnowledge() }.onSuccess { knowledge.value = it }
        runCatching { repo.loadMemory() }.onSuccess { memory.value = it }
        runCatching { repo.loadSoul() }.onSuccess { soul.value = it }
        runCatching { repo.generationLogs() }.onSuccess { logs.value = it }
            .onFailure { AppLog.w("settings", "generationLogs failed", it) }
        runCatching { repo.races() }.onSuccess { races.value = it }
        runCatching { repo.thresholdTests() }.onSuccess { thresholdTests.value = it }
        runCatching { repo.intervalsConnection() }.onSuccess { intervalsSaved.value = it }
        runCatching { repo.llmKeyRows() }.onSuccess { rows -> llmKeys.value = rows.associateBy { it.provider } }
        runCatching { repo.customLlmPricing() }.onSuccess { customPrice.value = it }
    }

    fun setCustomPricing(inputPer1M: Double?, outputPer1M: Double?) = viewModelScope.launch {
        runCatching {
            repo.setCustomLlmPricing(inputPer1M, outputPer1M)
            customPrice.value = inputPer1M to outputPer1M
        }
    }

    /**
     * Save a goal from the guided sheet.
     *
     * A main goal writes in two places on purpose. The `races` row is the event
     * itself, which the goal list, Home's countdown and the coach's profile tool
     * read, with `goal_date` pointing at it; the PROFILE's distance goal and
     * pace are the training goal, which reaches workout generation via the flat
     * string `deriveLegacyFields` builds ("Run 42.2 km at 5:22 /km"). Writing
     * only the row would leave a goal the planner has never heard of. The two
     * never share a field: that is what made the coach forget one of them.
     */
    internal fun addRace(draft: GoalDraft) = viewModelScope.launch {
        runCatching {
            repo.addRace(draft.race)
            if (draft.setAsGoal) {
                repo.setGoalRace(draft.race)
                if (draft.km != null) {
                    val sport = draft.race.sport
                    repo.loadProfile()?.let { p ->
                        repo.saveProfile(
                            p.copy(
                                distance_goal_km = p.distance_goal_km + (sport to draft.km),
                                goal_pace_sec_per_km = draft.paceSec
                                    ?.let { p.goal_pace_sec_per_km + (sport to it) }
                                    ?: p.goal_pace_sec_per_km,
                                goals_by_sport = p.goals_by_sport + (sport to EnduranceGoals.withDistanceGoal(
                                    p.goals_by_sport[sport].orEmpty(), sport, draft.km,
                                )),
                            ).deriveLegacyFields(),
                        )
                    }
                }
            }
            races.value = repo.races()
            repo.loadProfile()?.let { profile.value = it }
        }.onSuccess { saveStatus.value = "✓ Goal added" }.onFailure { saveStatus.value = "Couldn't add: ${it.message}" }
    }

    fun deleteRace(r: Race) = viewModelScope.launch {
        runCatching {
            repo.deleteRace(r)
            races.value = repo.races()
            repo.loadProfile()?.let { profile.value = it }
        }.onFailure { saveStatus.value = "Couldn't delete: ${it.message}" }
    }

    fun makeGoalRace(r: Race) = viewModelScope.launch {
        runCatching { repo.setGoalRace(r); repo.loadProfile()?.let { profile.value = it } }
            .onSuccess { saveStatus.value = "✓ “${r.name}” is now your goal" }
            .onFailure { saveStatus.value = it.message }
    }

    // Thresholds are set by logging a test and nothing else, so the value and
    // the date it was measured can never disagree.
    fun addThresholdTest(t: ThresholdTest) = viewModelScope.launch {
        runCatching {
            repo.addThresholdTest(t)
            thresholdTests.value = repo.thresholdTests()
            repo.loadProfile()?.let { profile.value = it }
        }.onSuccess { saveStatus.value = "✓ Test logged, zones updated" }
            .onFailure { saveStatus.value = "Couldn't log: ${it.message}" }
    }

    fun updateKnowledge(text: String) { knowledge.value = text }

    fun saveKnowledge() = viewModelScope.launch {
        busy.value = true
        runCatching { repo.saveKnowledge(knowledge.value) }
            .onSuccess { knowledgeStatus.value = "✓ Saved" }
            .onFailure { knowledgeStatus.value = "Couldn't save: ${it.message}" }
        busy.value = false
    }

    fun updateMemory(text: String) { memory.value = text }

    fun saveMemory() = viewModelScope.launch {
        busy.value = true
        runCatching { repo.saveMemory(memory.value) }
            .onSuccess { memoryStatus.value = "✓ Saved" }
            .onFailure { memoryStatus.value = "Couldn't save: ${it.message}" }
        busy.value = false
    }

    fun updateSoul(text: String) { soul.value = text }

    fun saveSoul() = viewModelScope.launch {
        busy.value = true
        runCatching { repo.saveSoul(soul.value) }
            .onSuccess { soulStatus.value = "✓ Saved" }
            .onFailure { soulStatus.value = "Couldn't save: ${it.message}" }
        busy.value = false
    }

    // Re-derive the rolling notes from recent training, then reload them.
    fun refreshMemory() = viewModelScope.launch {
        busy.value = true
        memoryStatus.value = "Refreshing from recent training…"
        runCatching { repo.refreshMemory(); repo.loadMemory() }
            .onSuccess { memory.value = it; memoryStatus.value = "✓ Updated" }
            .onFailure { memoryStatus.value = "Couldn't refresh: ${it.message}" }
        busy.value = false
    }

    fun setAutoPlan(enabled: Boolean) = viewModelScope.launch {
        autoPlan.value = enabled
        runCatching { repo.setAutoPlan(enabled) }
            .onFailure { autoPlan.value = !enabled; saveStatus.value = "Couldn't update: ${it.message}" }
    }

    fun updateProfile(transform: (TrainingProfile) -> TrainingProfile) {
        profile.value = transform(profile.value)
    }

    fun saveProfile() = viewModelScope.launch {
        busy.value = true
        // Derive the single-value fields the live backend reads from the rich ones.
        runCatching { repo.saveProfile(profile.value.deriveLegacyFields()) }
            .onSuccess { saveStatus.value = "✓ Saved" }
            .onFailure { saveStatus.value = it.message }
        busy.value = false
    }

    fun connectIntervals(athleteId: String, apiKey: String) = viewModelScope.launch {
        busy.value = true
        intervalsStatus.value = "Connecting…"
        runCatching { repo.connectIntervalsVerified(athleteId, apiKey) }
            .onSuccess { r ->
                intervalsStatus.value = if (r.ok) "✓ Connected as ${r.athlete_name}"
                else "Failed: ${r.error ?: "unknown"}"
                if (r.ok) {
                    runCatching { repo.intervalsConnection() }.onSuccess { intervalsSaved.value = it }
                    runCatching { repo.syncIntervals() }
                }
            }
            .onFailure { intervalsStatus.value = "Failed: ${it.message}" }
        busy.value = false
    }

    /** Pull fresh Intervals.icu data using the already-saved credentials — no
     *  need to re-enter the key/id just to sync. */
    fun syncIntervalsNow() = viewModelScope.launch {
        busy.value = true
        intervalsStatus.value = "Syncing…"
        runCatching { repo.syncIntervals() }
            .onSuccess { intervalsStatus.value = "✓ Synced from Intervals.icu" }
            .onFailure { intervalsStatus.value = "Sync failed: ${it.message}" }
        busy.value = false
    }

    fun selectProvider(p: LlmProvider) {
        active = p
        viewModelScope.launch { runCatching { repo.setActiveProvider(p) } }
    }

    // Which provider key is currently being tested (drives the button spinner).
    val testing = MutableStateFlow<String?>(null)

    fun testKey(
        p: LlmProvider,
        key: String,
        sample: Boolean,
        baseUrl: String? = null,
        model: String? = null,
    ) = viewModelScope.launch {
        testing.value = p.key
        runCatching {
            repo.testLlmKey(
                TestKeyRequest(p.key, key, sample, baseUrl = baseUrl?.trim()?.ifBlank { null }, model = model?.trim()?.ifBlank { null }),
            )
        }
            .onFailure {
                // Surface the failure instead of silently doing nothing — most
                // commonly the function returned an error (e.g. endpoint
                // unreachable from the server, or DB migration not yet applied).
                results[p.key] = TestKeyResponse(
                    provider = p.key, model = model ?: p.model, is_valid = false,
                    error = it.message ?: "request failed",
                )
            }
            .onSuccess {
                results[p.key] = it
                // For the custom provider the model id lives in the per-provider
                // override (llm_models), so persist it alongside the key.
                if (p == LlmProvider.CUSTOM && it.is_valid && !model.isNullOrBlank()) {
                    runCatching {
                        repo.setModelOverride(p, model.trim())
                        modelOverrides.value = repo.modelOverrides()
                    }
                }
                // Refresh the saved-key rows so the masked hint + base URL appear.
                runCatching { repo.llmKeyRows() }.onSuccess { rows -> llmKeys.value = rows.associateBy { r -> r.provider } }
            }
        testing.value = null
    }

    fun signOut() = viewModelScope.launch {
        runCatching { repo.signOut() }.onFailure { saveStatus.value = "Sign out failed: ${it.message}" }
    }

    /** The signed-in address, for the Account screen's headline. Null when unknown. */
    fun userEmail(): String? = repo.auth.currentUserOrNull()?.email?.takeIf { it.isNotBlank() }

    // null = idle, "" = in flight, anything else = error text.
    val deleteAccountState = MutableStateFlow<String?>(null)

    fun deleteAccount() = viewModelScope.launch {
        deleteAccountState.value = ""
        runCatching { repo.deleteAccount() }
            .onFailure { deleteAccountState.value = it.message ?: "Deletion failed, try again." }
            .onSuccess { deleteAccountState.value = null }
        // On success AuthGate flips to the login screen by itself (session gone).
    }
}

// ===========================================================================
// Holistic, two-level Settings panel: an index of grouped categories, each
// opening its own focused detail page (no more one flat scroll).
// ===========================================================================
