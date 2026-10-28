export const WORKOUT_SPORTS = [
  ["auto", "Coach's choice"], ["run", "Running"], ["ride", "Cycling"],
  ["swim", "Swimming"], ["strength", "Strength"],
] as const;
export type WorkoutSportChoice = typeof WORKOUT_SPORTS[number][0];
export const WORKOUT_FOCUSES: Record<WorkoutSportChoice, readonly string[]> = {
  auto: [],
  run: ["Easy run", "Recovery run", "Long run", "Strides", "Tempo", "Threshold", "Intervals", "Hills", "Run and walk"],
  ride: ["Easy ride", "Recovery ride", "Long ride", "Tempo", "Threshold", "Intervals"],
  swim: ["Easy swim", "Technique", "Threshold", "Intervals"],
  strength: ["Upper body", "Lower body", "Full body", "Push", "Pull"],
};
export function workoutChoiceRequest(sport: WorkoutSportChoice, focus: string, notes = ""): string {
  const choice = sport === "auto" ? "" : `Make this a ${WORKOUT_SPORTS.find(([key]) => key === sport)![1].toLowerCase()} workout${focus ? ` focused on ${focus.toLowerCase()}` : ""}.`;
  return [choice, notes.trim()].filter(Boolean).join(" ");
}
