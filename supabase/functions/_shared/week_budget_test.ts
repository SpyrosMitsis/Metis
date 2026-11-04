import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { WeekBudget } from "./week_budget.ts";
Deno.test("staged sessions consume time once per calendar week, including year boundaries", async () => {
  const budget = new WeekBudget(); let reads = 0;
  const load = async () => { reads++; return 90; };
  assertEquals(await budget.available("2026-12-31", load), 90);
  budget.consume("2026-12-31", 40);
  assertEquals(await budget.available("2027-01-03", load), 50);
  assertEquals(reads, 1);
  assertThrows(() => budget.consume("2027-01-03", 51));
  assertEquals(await budget.available("2027-01-04", load), 90);
  assertEquals(reads, 2);
});
Deno.test("failed budget reads cannot become a cached zero or unlimited allowance", async () => {
  const budget = new WeekBudget();
  await assertRejects(() => budget.available("2026-11-04", async () => { throw new Error("offline"); }));
  await assertRejects(() => budget.available("2026-11-04", async () => NaN));
  assertEquals(await budget.available("2026-11-04", async () => 45), 45);
});
