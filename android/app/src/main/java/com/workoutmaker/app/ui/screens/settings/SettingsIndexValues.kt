package com.workoutmaker.app.ui.screens.settings

import com.workoutmaker.app.data.AppSettings
import com.workoutmaker.app.data.LlmProvider
import com.workoutmaker.app.data.Race
import com.workoutmaker.app.data.TrainingProfile
import com.workoutmaker.app.data.WeightUnit
import java.time.LocalDate
import java.time.temporal.ChronoUnit

// ===========================================================================
// What each Settings row is currently SET TO.
//
// The index used to be a menu: sixteen rows, each with a fixed description of
// what you would find inside. That makes you open a screen to answer "did I
// ever set my threshold pace?" — which is the question people actually arrive
// with. Every row now carries its own value on the right, and a value that is
// still missing shows in amber rather than pretending to be fine.
//
// Pure on purpose: this is the whole content of the index, so it is worth being
// able to test it without a phone.
// ===========================================================================

/** A row's current value. [unfinished] paints it amber and feeds the setup card. */
internal data class SettingsRowValue(val text: String, val unfinished: Boolean = false)

/** Everything the index needs to describe itself, gathered once per composition. */
internal data class SettingsSnapshot(
    val profile: TrainingProfile = TrainingProfile(),
    val races: List<Race> = emptyList(),
    val provider: LlmProvider = LlmProvider.GROQ,
    val hasProviderKey: Boolean = false,
    val isPro: Boolean = false,
    val intervalsConnected: Boolean = false,
    val healthConnected: Boolean = false,
    val autoPlan: Boolean = false,
    val knowledgeLines: Int = 0,
    val settings: AppSettings = AppSettings(),
    val email: String? = null,
    val today: LocalDate = LocalDate.now(),
    // Numbers the athlete has hushed, see AppPreferences.hushedNumbers.
    val hushedNumbers: Set<String> = emptySet(),
)

// ---------------------------------------------------------------------------
// Detail screens: the state, said out loud.
//
// Every detail screen opens by TELLING YOU WHERE YOU STAND ("Groq is writing
// your plans", "I plan Sundays", "One of three linked") instead of repeating
// its own title back at you. The title is already in the row you tapped; the
// interesting sentence is what the screen is currently set to, in the coach's
// voice, before you have read a single control.
// ---------------------------------------------------------------------------

internal data class SettingsDetailCopy(val eyebrow: String, val headline: String, val subtitle: String?)

/** Small counts read better as words. Past ten, a numeral is clearer than prose. */
internal fun countWord(n: Int): String = when (n) {
    0 -> "No"
    1 -> "One"
    2 -> "Two"
    3 -> "Three"
    4 -> "Four"
    5 -> "Five"
    6 -> "Six"
    7 -> "Seven"
    8 -> "Eight"
    9 -> "Nine"
    10 -> "Ten"
    else -> n.toString()
}

internal fun detailHeader(id: String, s: SettingsSnapshot): SettingsDetailCopy {
    val p = s.profile
    return when (id) {
        "profile" -> {
            val age = p.birth_year?.let { s.today.year - it }?.takeIf { it in 5..120 }
            val bits = listOfNotNull(age?.toString(), p.weight_kg?.let { "$it kg" }, p.height_cm?.let { "$it cm" })
            SettingsDetailCopy(
                "ABOUT YOU",
                if (bits.isEmpty()) "Tell me about you" else bits.joinToString(", "),
                "Load, recovery and intensity are all tuned to this.",
            )
        }
        "sports" -> SettingsDetailCopy(
            "SPORTS & GOALS",
            if (p.sports.isEmpty()) "Nothing picked yet"
            else "${countWord(p.sports.size)} sport${if (p.sports.size == 1) "" else "s"}",
            "Only what is listed here ever gets scheduled.",
        )
        "week" -> {
            val days = p.day_availability
            val total = days.sumOf { it.max_minutes }
            SettingsDetailCopy(
                "YOUR TRAINING WEEK",
                if (days.isEmpty()) "No week set yet" else "${days.size} days, ${hoursLabel(total)}",
                "Everything I plan has to fit inside this.",
            )
        }
        "races" -> {
            val next = nextRace(s)
            SettingsDetailCopy(
                "GOALS & RACES",
                if (next == null) "No goals yet" else "${next.first.name} in ${next.second} days",
                "Your A goal is what drives periodization and the taper.",
            )
        }
        "zones" -> {
            val missing = missingNumbers(p, s.hushedNumbers)
            SettingsDetailCopy(
                "NUMBERS",
                "What you can do",
                if (missing.isEmpty()) "Your training zones are derived from these."
                else "${missing.first()} is still missing, so those zones stay estimated.",
            )
        }
        "knowledge" -> SettingsDetailCopy(
            "HARD RULES",
            injuryCountHeadline(p.injuries.count { it.area.isNotBlank() }),
            "I never program around these. Everything else is fair game.",
        )
        "ai" -> SettingsDetailCopy(
            "AI MODEL",
            when {
                s.isPro -> "Pro is writing your plans"
                !s.hasProviderKey -> "No model yet"
                else -> "${s.provider.label} is writing your plans"
            },
            "The single biggest lever on how good your coaching is.",
        )
        "planning" -> SettingsDetailCopy(
            "PLANNING",
            if (s.autoPlan) "I plan Sundays" else "You plan by hand",
            p.weekly_tss_target?.let { "Aiming for ~$it TSS a week." }
                ?: "No weekly target set yet.",
        )
        "connections" -> {
            val linked = listOf(
                s.intervalsConnected,
                s.healthConnected,
                s.settings.calendarRead || s.settings.calendarWrite,
            ).count { it }
            SettingsDetailCopy(
                "CONNECTIONS",
                if (linked == 0) "Nothing linked yet" else "${countWord(linked)} of three linked",
                "The more I can see, the less I have to guess.",
            )
        }
        "notifications" -> {
            val on = listOf(s.settings.morningNotify, s.settings.restNotify, s.settings.restVibrate).count { it }
            SettingsDetailCopy(
                "NOTIFICATIONS",
                if (on == 0) "I stay quiet" else "${countWord(on)} kind${if (on == 1) "" else "s"}, at most",
                "Nothing else from me buzzes your phone.",
            )
        }
        "defaults" -> SettingsDetailCopy(
            "GYM SESSION",
            "${if (s.settings.units == WeightUnit.KG) "Kilos" else "Pounds"}, ${s.settings.barbellKg.toInt()} kg bar",
            "How the plate maths and the rest timer behave.",
        )
        "appearance" -> SettingsDetailCopy(
            "APPEARANCE",
            "${s.settings.themePalette.label}, ${s.settings.themeMode.label.lowercase()}",
            "Re-skin the whole app. Nothing here changes your training.",
        )
        "data" -> SettingsDetailCopy(
            "YOUR DATA",
            "Bring it in, take it out",
            "Import a Strong or Hevy history, or export everything as CSV.",
        )
        "diagnostics" -> SettingsDetailCopy(
            "AI SPEND",
            if (s.settings.spendCapUsd > 0) "Capped at $%.0f a month".format(s.settings.spendCapUsd) else "No cap set",
            "Every AI call, what it cost, and which model made it.",
        )
        "account" -> SettingsDetailCopy(
            "ACCOUNT",
            s.email ?: "Signed in",
            if (s.isPro) "Pro, running on hosted AI." else "Free, running on your own key.",
        )
        "support" -> SettingsDetailCopy(
            "SUPPORT",
            "Two ways to chip in",
            "Pro keeps the hosted AI running. A tip just says thanks.",
        )
        else -> SettingsDetailCopy("SETTINGS", "Settings", null)
    }
}

/** The soonest race still ahead of us, and how many days away it is. */
private fun nextRace(s: SettingsSnapshot): Pair<Race, Long>? = s.races
    .mapNotNull { r -> runCatching { LocalDate.parse(r.date) }.getOrNull()?.let { r to it } }
    .filter { !it.second.isBefore(s.today) }
    .minByOrNull { it.second }
    ?.let { it.first to ChronoUnit.DAYS.between(s.today, it.second) }

/** Mirrors the injury editor's own headline, so the two never drift apart. */
internal fun injuryCountHeadline(count: Int): String = when (count) {
    0 -> "Nothing to work around"
    1 -> "One thing I avoid"
    else -> "$count things I avoid"
}

private fun hoursLabel(minutes: Int): String = when {
    minutes < 60 -> "${minutes}m"
    minutes % 60 == 0 -> "${minutes / 60}h"
    else -> "${minutes / 60}h ${minutes % 60}m"
}

internal fun settingsRowValue(id: String, s: SettingsSnapshot): SettingsRowValue {
    val p = s.profile
    return when (id) {
        "profile" -> {
            val age = p.birth_year?.let { s.today.year - it }?.takeIf { it in 5..120 }
            val bits = listOfNotNull(age?.let { "$it y" }, p.weight_kg?.let { "$it kg" })
            if (bits.isEmpty()) SettingsRowValue("Not set", unfinished = true)
            else SettingsRowValue(bits.joinToString(" · "))
        }
        "sports" -> {
            if (p.sports.isEmpty()) SettingsRowValue("None picked", unfinished = true)
            else {
                val level = p.experience_by_sport.values.firstOrNull()
                SettingsRowValue(
                    listOfNotNull(
                        "${p.sports.size} sport${if (p.sports.size == 1) "" else "s"}",
                        level,
                    ).joinToString(" · "),
                )
            }
        }
        "week" -> {
            val days = p.day_availability
            if (days.isEmpty()) SettingsRowValue("Not set", unfinished = true)
            else {
                val typical = availabilityToQuestions(days).typicalMin
                SettingsRowValue("${days.size} days · ${durationLabel(typical)}")
            }
        }
        "races" -> {
            // The soonest race still ahead of us is the one that shapes the plan.
            val next = s.races
                .mapNotNull { r -> runCatching { LocalDate.parse(r.date) }.getOrNull()?.let { r to it } }
                .filter { !it.second.isBefore(s.today) }
                .minByOrNull { it.second }
            if (next == null) SettingsRowValue("None set")
            else {
                val days = ChronoUnit.DAYS.between(s.today, next.second)
                SettingsRowValue("${next.first.name} · ${days}d")
            }
        }
        "zones" -> {
            // Name the FIRST missing anchor rather than counting them: "threshold
            // pace missing" is actionable, "2 of 4 set" is not.
            val missing = missingNumbers(p, s.hushedNumbers)
            if (missing.isNotEmpty()) SettingsRowValue("${missing.first()} missing", unfinished = true)
            else SettingsRowValue(
                listOfNotNull(
                    p.threshold_pace_per_km?.let { "$it /km" },
                    p.ftp?.let { "${it}w" },
                    p.lthr?.let { "$it bpm" },
                ).take(2).joinToString(" · ").ifBlank { "Set" },
            )
        }
        "knowledge" -> {
            val n = p.injuries.count { it.area.isNotBlank() } + s.knowledgeLines
            SettingsRowValue(if (n == 0) "None" else "$n rule${if (n == 1) "" else "s"}")
        }
        "ai" -> when {
            s.isPro -> SettingsRowValue("Pro · hosted")
            !s.hasProviderKey -> SettingsRowValue("No key yet", unfinished = true)
            else -> SettingsRowValue(s.provider.label)
        }
        "planning" -> {
            val load = p.weekly_tss_target?.let { "~$it TSS" }
            SettingsRowValue(
                listOfNotNull(load, if (s.autoPlan) "auto" else "manual").joinToString(" · "),
            )
        }
        "connections" -> {
            val on = listOfNotNull(
                "Intervals.icu".takeIf { s.intervalsConnected },
                "Health Connect".takeIf { s.healthConnected },
            )
            if (on.isEmpty()) SettingsRowValue("Nothing linked", unfinished = true)
            else SettingsRowValue(on.joinToString(" · "))
        }
        "notifications" -> {
            val on = listOfNotNull(
                "morning".takeIf { s.settings.morningNotify },
                "rest timer".takeIf { s.settings.restNotify },
            )
            SettingsRowValue(if (on.isEmpty()) "Off" else on.joinToString(" · "))
        }
        "defaults" -> SettingsRowValue(
            "${if (s.settings.units == WeightUnit.KG) "kg" else "lb"} · ${restLabel(s.settings.defaultRestSec)} rest",
        )
        "tour" -> SettingsRowValue("6 features")
        "appearance" -> SettingsRowValue("${s.settings.themePalette.label} · ${s.settings.themeMode.label}")
        "data" -> SettingsRowValue("Import · export")
        "diagnostics" -> SettingsRowValue(
            if (s.settings.spendCapUsd > 0) "Cap $%.0f/mo".format(s.settings.spendCapUsd) else "No cap",
        )
        "account" -> SettingsRowValue(if (s.isPro) "Pro" else "Free")
        "support" -> SettingsRowValue("Tips")
        else -> SettingsRowValue("")
    }
}

/**
 * The performance anchors this athlete's sports actually need, in the order
 * they matter. Only asks for a number the sport uses: an FTP means nothing to
 * someone who never rides.
 *
 * [hushed] drops the ones the athlete has said they do not have. Knowing your
 * FTP is not the same as riding, and a permanent amber row for a number that is
 * never going to arrive is a reproach, not a prompt.
 */
internal fun missingNumbers(p: TrainingProfile, hushed: Set<String> = emptySet()): List<String> = buildList {
    if (p.sports.contains("run") && p.threshold_pace_per_km.isNullOrBlank()) add("Threshold pace")
    if (p.sports.contains("ride") && p.ftp == null) add("FTP")
    if (p.sports.contains("swim") && p.css_per_100m.isNullOrBlank()) add("Swim pace")
    if (p.sports.contains("strength") && p.starting_lifts.isEmpty()) add("Starting lifts")
}.filterNot { it in hushed }

/** Every number this athlete's sports can be asked for, hushed or not. */
internal fun applicableNumbers(p: TrainingProfile): List<String> = buildList {
    if (p.sports.contains("run")) add("Threshold pace")
    if (p.sports.contains("ride")) add("FTP")
    if (p.sports.contains("swim")) add("Swim pace")
    if (p.sports.contains("strength")) add("Starting lifts")
}

/**
 * What onboarding left undone, most consequential first, as (row id, what it
 * buys you). Drives the "Finish setup" card: the index stops being a menu and
 * starts being a nudge.
 */
internal fun unfinishedSetup(s: SettingsSnapshot): List<Pair<String, String>> = buildList {
    if (settingsRowValue("ai", s).unfinished) add("ai" to "Your coach can't think without a model")
    if (settingsRowValue("sports", s).unfinished) add("sports" to "Nothing gets scheduled until you pick one")
    if (settingsRowValue("week", s).unfinished) add("week" to "I plan from generic defaults instead of your week")
    if (settingsRowValue("zones", s).unfinished) add("zones" to "Your zones stay estimated until you do")
    if (settingsRowValue("profile", s).unfinished) add("profile" to "Load and recovery are tuned to your body")
    if (settingsRowValue("connections", s).unfinished) add("connections" to "Link a watch and I see your real fitness")
}

// ---------------------------------------------------------------------------
// How many times the setup card gets to ask.
//
// Three, a week apart. Once is not an answer (the × could be "not now", and a
// half-set-up profile really is worth one more mention); three is: someone who
// has closed this on three separate weeks has told us, and asking a fourth time
// would be the app deciding it knows better.
//
// The rows stay in the list below with their own amber values throughout, so
// what runs out is the interruption, never the information.
// ---------------------------------------------------------------------------

internal const val SETUP_SNOOZE_DAYS = 7L
internal const val SETUP_DISMISS_LIMIT = 3

private const val DAY_MS = 24L * 60 * 60 * 1000

/**
 * Times the card has been closed, and when the last one was. Public, not
 * internal, because AppPreferences stores it, same as HomeLayout.
 */
data class SetupNudge(val dismissals: Int = 0, val lastDismissedAt: Long = 0L) {
    /** True once the athlete has closed it [SETUP_DISMISS_LIMIT] times. */
    val silenced: Boolean get() = dismissals >= SETUP_DISMISS_LIMIT
}

/**
 * Whether the setup card may show right now. Pure so the week can be tested
 * without waiting one.
 */
internal fun setupCardVisible(nudge: SetupNudge, nowMs: Long): Boolean {
    if (nudge.silenced) return false
    if (nudge.dismissals == 0) return true
    // A clock that has gone backwards (timezone move, manual change) must not
    // strand the card off-screen, so an impossible future stamp reads as elapsed.
    val elapsed = nowMs - nudge.lastDismissedAt
    return elapsed !in 0 until SETUP_SNOOZE_DAYS * DAY_MS
}

/** What the close button is about to do, said plainly for the screen reader. */
internal fun setupDismissLabel(nudge: SetupNudge): String =
    if (nudge.dismissals >= SETUP_DISMISS_LIMIT - 1) "Hide finish setup for good"
    else "Hide finish setup for a week"
