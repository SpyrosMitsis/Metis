import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { editRestriction, RestrictionEditError } from "./restriction_edit.ts";
const original = { area: "Lower back", level: "avoid", until: "2026-11-07", sports: ["ride", "run"], reason: "test", extra: "preserve" };
Deno.test("restriction editor preserves movement restriction and unrelated data when releasing a sport", () => {
  const other = { area: "Knee", level: "ease", until: "2026-11-09" };
  const result = editRestriction([original, other], { area: original.area, expected: original, level: "avoid", until: original.until, sports: ["ride"] });
  assertEquals(result[0], { ...original, source: "user", sports: ["ride"] });
  assertEquals(result[1], other);
  assertEquals(original.sports, ["ride", "run"]);
});
Deno.test("restriction editor rejects stale values, invalid dates and unknown sports", () => {
  const body = { area: original.area, expected: original, level: "ease", until: original.until, sports: [] };
  assertThrows(() => editRestriction([{ ...original, reason: "new update" }], body), RestrictionEditError);
  assertThrows(() => editRestriction([original], { ...body, until: "2026-02-30" }), RestrictionEditError);
  assertThrows(() => editRestriction([original], { ...body, sports: ["unknown"] }), RestrictionEditError);
});
