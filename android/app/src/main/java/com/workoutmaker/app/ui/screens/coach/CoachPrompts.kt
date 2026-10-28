package com.workoutmaker.app.ui.screens.coach

import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

// The landing hero's heading. Deliberately NOT Notifications.greeting(): that
// one rotates variants by day of year to keep a daily notification from reading
// identically, which is right for a notification and wrong for a heading you
// see several times an hour ("New day, Spyros" at 9pm). This one is a pure
// function of the hour and nothing else.
internal fun timeGreeting(hour: Int): String = when (hour) {
    in 0..4 -> "Still up"
    in 5..11 -> "Good morning"
    in 12..16 -> "Good afternoon"
    else -> "Good evening"
}

// What sits under the greeting. One line, an invitation rather than a manual:
// the starter chips below it already show what the coach can be asked for.
internal const val HERO_SUBTITLE = "What are we training today?"

// A conversation starter: the short text shown on the chip, plus the richer,
// directive prompt actually sent to the coach. The chip stays terse; the prompt
// under the hood tells the coach to read the data and drive to a concrete
// outcome in one turn — so the user doesn't have to keep nudging "go on".
data class CoachStarter(val label: String, val prompt: String)

// The directive prompts behind the starter chips. Each one tells the coach to
// pull the relevant data itself and finish the job in a single turn — give the
// answer, take the action, and end with a clear next step — instead of asking a
// question and waiting. This is what removes the "I have to keep saying go on".
internal const val STARTER_FITNESS =
    "Give me a full read on my fitness right now. Pull my CTL/ATL/TSB, this week's " +
        "load and my readiness, then tell me what shape I'm in, what's trending up or " +
        "down, and the one thing I should focus on this week. Use the real numbers."

internal const val STARTER_PLAN_WEEK =
    "Plan my full training week. Check my fitness, readiness, recent sessions and goal " +
        "first, then build the complete week and put it on my calendar, don't ask me to " +
        "confirm each day. When it's scheduled, summarize the week and why it's built that way."

internal const val STARTER_EXPLAIN_TODAY =
    "What should I do today? Read all of today's saved sessions and explain what to do, " +
        "including the warm-up, main work and effort. Use the existing plan, including rest " +
        "or completed sessions. Do not create or replace a workout. If a change seems useful, " +
        "explain why and offer it without editing the calendar."

internal const val STARTER_MAKE_TODAY =
    "Make me today's workout. Check my readiness, recent training and goal, pick the right " +
        "type and intensity yourself, generate it and put it on my calendar, then tell me the plan."

internal const val STARTER_RECENT =
    "Review how my recent training has actually gone, how I executed the sessions versus the " +
        "plan. Tell me what's going well, what's lagging, and the most useful change to make next."

// Live progress line while the agentic loop runs ("checking your fitness…").
internal fun friendlyToolProgress(tool: String): String = when (tool) {
    "get_fitness" -> "Checking your fitness…"
    "get_recent_activities" -> "Reviewing recent activities…"
    "get_today_plan" -> "Reading today’s workout…"
    "get_planned_week" -> "Looking at your week…"
    "get_strength_summary" -> "Reviewing your lifting…"
    "get_profile" -> "Checking your profile…"
    "get_readiness" -> "Checking today's readiness…"
    "get_execution_analysis" -> "Reviewing how recent sessions went…"
    "plan_week" -> "Planning your week (this can take ~30s)…"
    "generate_workout" -> "Creating your workout…"
    "move_workout" -> "Moving the session…"
    "set_rest_day" -> "Setting a rest day…"
    "make_easier" -> "Making the session easier…"
    "log_stretch_session" -> "Logging your stretch session…"
    "assess_goal" -> "Checking if that goal is realistic…"
    "set_goal_race" -> "Saving your goal race…"
    "remove_goal_race" -> "Removing that goal…"
    "remember" -> "Noting that down…"
    "update_profile" -> "Updating your profile…"
    "update_app_settings" -> "Updating your app settings…"
    else -> "Working…"
}

// Tools that mutate the calendar/plan — used to drive the "✓ Updated" result card.
internal val WRITE_TOOL_NAMES = setOf(
    "plan_week", "generate_workout", "move_workout", "set_goal_race", "remove_goal_race",
    "set_rest_day", "make_easier",
)

// Contextual quick replies for the turn that just finished. Deterministic from
// the write tools used: after a concrete action the athlete predictably wants
// one of a few follow-ups; after a plain answer, chips would be noise (none).
// Directive prompts, same philosophy as the starters: finish the job in one turn.
internal fun followUpChips(toolsUsed: List<String>): List<CoachStarter> = when {
    // Order matters: a week plan is the bigger action, its follow-ups win even
    // when a single workout was also generated in the same turn.
    "plan_week" in toolsUsed -> listOf(
        CoachStarter(
            "Explain the week",
            "Walk me through the week you just planned, day by day, and why it's structured that way for my goal and current fitness.",
        ),
        CoachStarter(
            "Make it easier",
            "The planned week feels like too much. Reduce the overall load, keep the structure sensible, apply the changes, and summarize what moved.",
        ),
        CoachStarter(
            "Swap two days",
            "Swap the two days in this week's plan that would fit me better the other way around. Pick them yourself, apply the swap, and tell me which ones and why.",
        ),
    )
    "generate_workout" in toolsUsed || "make_easier" in toolsUsed -> listOf(
        CoachStarter(
            "Make it easier",
            "Make the workout you just created easier. Reduce the intensity or volume, apply the change, and tell me what you changed.",
        ),
        CoachStarter(
            "Move it",
            "Move the workout you just created to a better day this week. Look at my week, pick the day yourself, apply the move, and tell me why.",
        ),
        CoachStarter(
            "Why this session?",
            "Explain why the session you just created is the right one for me now, based on my fitness, fatigue and goal. Use the real numbers.",
        ),
    )
    // The coach may have SAVED the goal and then argued against the timeline
    // (set_goal_race returns a feasibility verdict). So offer both paths: the
    // build, and the honest question. A single "Plan toward it" chip would
    // push the athlete straight past a warning it just gave them.
    "set_goal_race" in toolsUsed || "assess_goal" in toolsUsed -> listOf(
        CoachStarter(
            "Plan toward it",
            "Now that my goal race is set, plan this week so it starts building toward it. Put the week on my calendar and summarize the focus.",
        ),
        CoachStarter(
            "What would it take?",
            "Be concrete about what reaching that goal actually requires from me: the weekly volume, the long session, and how many weeks of building. Tell me honestly whether my current numbers support it.",
        ),
    )
    "move_workout" in toolsUsed || "set_rest_day" in toolsUsed -> listOf(
        CoachStarter(
            "Rebalance the week",
            "After that change, check this week's balance, hard-day spacing, load and recovery, and fix anything that no longer makes sense. Apply what you change.",
        ),
    )
    else -> emptyList()
}

// Maps tool names the agentic coach used into a friendly "what I just did" note.
internal fun friendlyTools(tools: List<String>): String {
    val label = { t: String ->
        when (t) {
            "get_fitness" -> "checked your fitness"
            "get_recent_activities" -> "reviewed recent activities"
            "get_today_plan" -> "read today’s workout"
            "get_planned_week" -> "looked at your week"
            "get_strength_summary" -> "reviewed your lifting"
            "get_profile" -> "checked your profile"
            "plan_week" -> "planned your week"
            "generate_workout" -> "created a workout"
            "get_readiness" -> "checked your readiness"
            "get_execution_analysis" -> "reviewed your execution"
            "move_workout" -> "moved a session"
            "set_rest_day" -> "set a rest day"
            "make_easier" -> "made the session easier"
            "log_stretch_session" -> "logged a stretch session"
            "set_goal_race" -> "set your goal race"
            "remove_goal_race" -> "removed that goal"
            "remember" -> "noted that for next time"
            "update_profile" -> "updated your profile"
            "update_app_settings" -> "updated your app settings"
            else -> t
        }
    }
    return tools.distinct().joinToString(" · ", transform = label)
}
