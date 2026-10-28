package com.workoutmaker.app.strength

// Bundled exercise library (no network needed). Mirrors the kind of catalog
// Strong ships with: name, primary muscle, equipment/category, compound flag.

data class Exercise(
    val name: String,
    val muscle: String,
    val category: String,      // Barbell | Dumbbell | Machine | Cable | Bodyweight | Kettlebell | Cardio
    val compound: Boolean = false,
    val defaultRestSec: Int = if (compound) 150 else 90,
) {
    val id: String get() = name.lowercase().replace(Regex("[^a-z0-9]+"), "_").trim('_')
}

object ExerciseCatalog {
    val all: List<Exercise> = listOf(
        Exercise("Wall Push-Up", "Chest", "Bodyweight", compound = true),
        Exercise("Resistance Band Row", "Back", "Band", compound = true),
        Exercise("Resistance Band Chest Press", "Chest", "Band", compound = true),
        Exercise("Resistance Band Pull-Apart", "Shoulders", "Band", compound = false),
        Exercise("Resistance Band Bicep Curl", "Biceps", "Band", compound = false),
        Exercise("Resistance Band Lateral Raise", "Shoulders", "Band", compound = false),

        // Additional home and gym variations (mirrored on server and Android).
        Exercise("Incline Push-Up", "Chest", "Bodyweight", compound = true),
        Exercise("Dumbbell Floor Press", "Chest", "Dumbbell", compound = true),
        Exercise("Chest-Supported Dumbbell Row", "Back", "Dumbbell", compound = true),
        Exercise("Assisted Pull-Up", "Back", "Machine", compound = true),
        Exercise("Inverted Row", "Back", "Bodyweight", compound = true),
        Exercise("Pike Push-Up", "Shoulders", "Bodyweight", compound = true),
        Exercise("Dumbbell Shrug", "Shoulders", "Dumbbell"),
        Exercise("Bodyweight Squat", "Quads", "Bodyweight", compound = true),
        Exercise("Reverse Lunge (Bodyweight)", "Quads", "Bodyweight", compound = true),
        Exercise("Split Squat (Bodyweight)", "Quads", "Bodyweight", compound = true),
        Exercise("Reverse Lunge (Dumbbell)", "Quads", "Dumbbell", compound = true),
        Exercise("Romanian Deadlift (Dumbbell)", "Hamstrings", "Dumbbell", compound = true),
        Exercise("Single-Leg Romanian Deadlift (Dumbbell)", "Hamstrings", "Dumbbell", compound = true),
        Exercise("Glute Bridge (Bodyweight)", "Glutes", "Bodyweight", compound = true),
        Exercise("Single-Leg Glute Bridge", "Glutes", "Bodyweight", compound = true),
        Exercise("Hip Thrust (Dumbbell)", "Glutes", "Dumbbell", compound = true),
        Exercise("Standing Calf Raise (Bodyweight)", "Calves", "Bodyweight"),
        Exercise("Single-Leg Calf Raise (Bodyweight)", "Calves", "Bodyweight"),
        Exercise("Standing Calf Raise (Dumbbell)", "Calves", "Dumbbell"),
        Exercise("Side Plank", "Core", "Bodyweight"),
        Exercise("Dead Bug", "Core", "Bodyweight"),
        Exercise("Bird Dog", "Core", "Bodyweight"),
        Exercise("Pallof Press", "Core", "Cable"),
        Exercise("Reverse Crunch", "Core", "Bodyweight"),
        Exercise("Kettlebell Goblet Squat", "Quads", "Kettlebell", compound = true),
        Exercise("Kettlebell Deadlift", "Hamstrings", "Kettlebell", compound = true),
        // ---- Chest ----
        Exercise("Barbell Bench Press", "Chest", "Barbell", compound = true),
        Exercise("Incline Barbell Bench Press", "Chest", "Barbell", compound = true),
        Exercise("Decline Barbell Bench Press", "Chest", "Barbell", compound = true),
        Exercise("Dumbbell Bench Press", "Chest", "Dumbbell", compound = true),
        Exercise("Incline Dumbbell Bench Press", "Chest", "Dumbbell", compound = true),
        Exercise("Dumbbell Fly", "Chest", "Dumbbell"),
        Exercise("Cable Crossover", "Chest", "Cable"),
        Exercise("Pec Deck", "Chest", "Machine"),
        Exercise("Machine Chest Press", "Chest", "Machine", compound = true),
        Exercise("Push-Up", "Chest", "Bodyweight", compound = true),
        Exercise("Dips (Chest)", "Chest", "Bodyweight", compound = true),
        // ---- Back ----
        Exercise("Deadlift", "Back", "Barbell", compound = true, defaultRestSec = 210),
        Exercise("Barbell Row", "Back", "Barbell", compound = true),
        Exercise("Pendlay Row", "Back", "Barbell", compound = true),
        Exercise("T-Bar Row", "Back", "Barbell", compound = true),
        Exercise("Dumbbell Row", "Back", "Dumbbell", compound = true),
        Exercise("Pull-Up", "Back", "Bodyweight", compound = true),
        Exercise("Chin-Up", "Back", "Bodyweight", compound = true),
        Exercise("Lat Pulldown", "Back", "Cable", compound = true),
        Exercise("Seated Cable Row", "Back", "Cable", compound = true),
        Exercise("Straight-Arm Pulldown", "Back", "Cable"),
        Exercise("Machine Row", "Back", "Machine", compound = true),
        Exercise("Rack Pull", "Back", "Barbell", compound = true, defaultRestSec = 180),
        // ---- Shoulders ----
        Exercise("Overhead Press", "Shoulders", "Barbell", compound = true),
        Exercise("Seated Dumbbell Press", "Shoulders", "Dumbbell", compound = true),
        Exercise("Arnold Press", "Shoulders", "Dumbbell", compound = true),
        Exercise("Lateral Raise", "Shoulders", "Dumbbell"),
        Exercise("Cable Lateral Raise", "Shoulders", "Cable"),
        Exercise("Front Raise", "Shoulders", "Dumbbell"),
        Exercise("Rear Delt Fly", "Shoulders", "Dumbbell"),
        Exercise("Reverse Pec Deck", "Shoulders", "Machine"),
        Exercise("Face Pull", "Shoulders", "Cable"),
        Exercise("Barbell Shrug", "Shoulders", "Barbell"),
        Exercise("Upright Row", "Shoulders", "Barbell", compound = true),
        // ---- Biceps ----
        Exercise("Barbell Curl", "Biceps", "Barbell"),
        Exercise("EZ-Bar Curl", "Biceps", "Barbell"),
        Exercise("Dumbbell Curl", "Biceps", "Dumbbell"),
        Exercise("Hammer Curl", "Biceps", "Dumbbell"),
        Exercise("Incline Dumbbell Curl", "Biceps", "Dumbbell"),
        Exercise("Preacher Curl", "Biceps", "Machine"),
        Exercise("Cable Curl", "Biceps", "Cable"),
        Exercise("Concentration Curl", "Biceps", "Dumbbell"),
        // ---- Triceps ----
        Exercise("Close-Grip Bench Press", "Triceps", "Barbell", compound = true),
        Exercise("Triceps Pushdown", "Triceps", "Cable"),
        Exercise("Rope Pushdown", "Triceps", "Cable"),
        Exercise("Overhead Cable Extension", "Triceps", "Cable"),
        Exercise("Skullcrusher", "Triceps", "Barbell"),
        Exercise("Dumbbell Overhead Extension", "Triceps", "Dumbbell"),
        Exercise("Dips (Triceps)", "Triceps", "Bodyweight", compound = true),
        Exercise("Bench Dip", "Triceps", "Bodyweight"),
        // ---- Quads ----
        Exercise("Back Squat", "Quads", "Barbell", compound = true, defaultRestSec = 210),
        Exercise("Front Squat", "Quads", "Barbell", compound = true, defaultRestSec = 180),
        Exercise("Hack Squat", "Quads", "Machine", compound = true),
        Exercise("Leg Press", "Quads", "Machine", compound = true),
        Exercise("Goblet Squat", "Quads", "Dumbbell", compound = true),
        Exercise("Bulgarian Split Squat", "Quads", "Dumbbell", compound = true),
        Exercise("Walking Lunge", "Quads", "Dumbbell", compound = true),
        Exercise("Leg Extension", "Quads", "Machine"),
        Exercise("Step-Up", "Quads", "Dumbbell", compound = true),
        // ---- Hamstrings ----
        Exercise("Romanian Deadlift", "Hamstrings", "Barbell", compound = true, defaultRestSec = 180),
        Exercise("Lying Leg Curl", "Hamstrings", "Machine"),
        Exercise("Seated Leg Curl", "Hamstrings", "Machine"),
        Exercise("Nordic Curl", "Hamstrings", "Bodyweight"),
        Exercise("Good Morning", "Hamstrings", "Barbell", compound = true),
        Exercise("Stiff-Leg Deadlift", "Hamstrings", "Barbell", compound = true),
        // ---- Glutes ----
        Exercise("Hip Thrust", "Glutes", "Barbell", compound = true),
        Exercise("Glute Bridge", "Glutes", "Barbell"),
        Exercise("Cable Kickback", "Glutes", "Cable"),
        Exercise("Hip Abduction", "Glutes", "Machine"),
        // ---- Calves ----
        Exercise("Standing Calf Raise", "Calves", "Machine"),
        Exercise("Seated Calf Raise", "Calves", "Machine"),
        Exercise("Leg Press Calf Raise", "Calves", "Machine"),
        // ---- Core ----
        Exercise("Plank", "Core", "Bodyweight"),
        Exercise("Hanging Leg Raise", "Core", "Bodyweight"),
        Exercise("Cable Crunch", "Core", "Cable"),
        Exercise("Ab Wheel Rollout", "Core", "Bodyweight"),
        Exercise("Russian Twist", "Core", "Bodyweight"),
        Exercise("Decline Sit-Up", "Core", "Bodyweight"),
        Exercise("Mountain Climber", "Core", "Bodyweight"),
        // ---- Forearms ----
        Exercise("Wrist Curl", "Forearms", "Barbell"),
        Exercise("Reverse Wrist Curl", "Forearms", "Barbell"),
        Exercise("Farmer's Walk", "Forearms", "Dumbbell", compound = true),
        // ---- Olympic / full body ----
        Exercise("Power Clean", "Full Body", "Barbell", compound = true, defaultRestSec = 180),
        Exercise("Clean and Jerk", "Full Body", "Barbell", compound = true, defaultRestSec = 210),
        Exercise("Snatch", "Full Body", "Barbell", compound = true, defaultRestSec = 210),
        Exercise("Kettlebell Swing", "Full Body", "Kettlebell", compound = true),
        Exercise("Thruster", "Full Body", "Barbell", compound = true),
        Exercise("Burpee", "Full Body", "Bodyweight", compound = true),
        // ---- Cardio ----
        Exercise("Treadmill Run", "Cardio", "Cardio"),
        Exercise("Rowing Machine", "Cardio", "Cardio"),
        Exercise("Assault Bike", "Cardio", "Cardio"),
        Exercise("Stair Climber", "Cardio", "Cardio"),
        Exercise("Elliptical", "Cardio", "Cardio"),
    )

    val muscles: List<String> = listOf(
        "Chest", "Back", "Shoulders", "Biceps", "Triceps",
        "Quads", "Hamstrings", "Glutes", "Calves", "Core", "Forearms", "Full Body", "Cardio",
    )

    val categories: List<String> = listOf(
        "Barbell", "Dumbbell", "Machine", "Cable", "Bodyweight", "Kettlebell", "Band", "Cardio",
    )

    private val byName = all.associateBy { it.name }

    // User-created exercises (D1), registered at app start from Room/cloud.
    @Volatile private var customByName: Map<String, Exercise> = emptyMap()
    fun registerCustom(list: List<Exercise>) { customByName = list.associateBy { it.name } }
    fun custom(): List<Exercise> = customByName.values.toList()

    // Account switch: the registry is process-global, so it must be emptied
    // along with the Room tables or the next user still sees the old customs.
    fun resetCustom() { customByName = emptyMap() }

    /** Built-ins plus any registered custom exercises. */
    fun combined(): List<Exercise> = all + customByName.values

    // Fuzzy snap (mirrors the server-side canonicaliser): drop equipment/grip
    // qualifier words so a reworded name like "Machine Lat Pulldown" maps onto
    // "Lat Pulldown". Equipment words DO distinguish real entries (Barbell Row
    // vs Dumbbell Row), so a fuzzy key is only usable when exactly ONE bundled
    // entry maps to it — ambiguous keys are dropped.
    private val qualifier = Regex(
        "\\b(machine|cable|barbell|dumbbell|db|smith|seated|standing|bench|lying|" +
            "kneeling|assisted|weighted|wide|close|narrow|neutral|grip|single|onearm|one|alternating|alt)\\b",
    )
    private fun norm(s: String) = s.lowercase().replace(Regex("[^a-z0-9]"), "")
    private fun fuzz(s: String) = norm(s.lowercase().replace(Regex("[-_]"), " ").replace(qualifier, " "))
    private val byFuzz: Map<String, Exercise> = run {
        val count = all.groupingBy { fuzz(it.name) }.eachCount()
        all.filter { count[fuzz(it.name)] == 1 }.associateBy { fuzz(it.name) }
    }

    /** The bundled entry this off-catalog name is clearly a reworded duplicate
     *  of — e.g. "Machine Lat Pulldown" → "Lat Pulldown". Null if it's already a
     *  catalog name or has no unambiguous match. */
    fun canonicalFor(name: String): Exercise? =
        if (byName.containsKey(name)) null else byFuzz[fuzz(name)]

    fun find(name: String): Exercise? = customByName[name] ?: byName[name]
    fun muscleOf(name: String): String = find(name)?.muscle ?: "Other"

    // Generic cardio names the AI sometimes invents ("Light Cardio", "HIIT",
    // "Conditioning"). Real cardio equipment (Treadmill Run, Rowing Machine, …)
    // is already tagged Cardio in the catalog, so this only needs to catch the
    // off-catalog wording — and deliberately omits ambiguous words like "row" /
    // "run" / "bike" that appear in strength exercise names.
    private val cardioName = Regex(
        "\\b(cardio|treadmill|elliptical|jog(ging)?|spinning|cycling|conditioning|hiit|aerobic)\\b",
        RegexOption.IGNORE_CASE,
    )

    /** True for cardio entries: tagged Cardio in the catalog, or an off-catalog
     *  name that clearly reads as cardio. Drives minute-based logging (no load,
     *  no strength progression). */
    fun isCardio(name: String): Boolean {
        val e = find(name)
        if (e != null && (e.category == "Cardio" || e.muscle == "Cardio")) return true
        return cardioName.containsMatchIn(name)
    }
    fun restOf(name: String): Int = find(name)?.defaultRestSec ?: 120
    fun isCustom(name: String): Boolean = customByName.containsKey(name)

    fun search(query: String, muscle: String?, category: String?): List<Exercise> =
        combined().filter { ex ->
            (query.isBlank() || ex.name.contains(query, ignoreCase = true)) &&
                (muscle == null || ex.muscle == muscle) &&
                (category == null || ex.category == category)
        }.sortedBy { it.name }
}
