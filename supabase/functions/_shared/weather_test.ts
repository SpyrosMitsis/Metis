import { assertEquals } from "jsr:@std/assert@1";
import { assessViability, type WeatherSnapshot } from "./weather.ts";

function snap(overrides: Partial<WeatherSnapshot> = {}): WeatherSnapshot {
  return {
    tempC: 18,
    apparentC: 18,
    humidity: 50,
    windKmh: 10,
    precipMm: 0,
    precipProbMax: 5,
    tMaxC: 20,
    summary: "",
    ...overrides,
  };
}

// --- run: all-clear -------------------------------------------------------

Deno.test("run: mild conditions are ok with no reasons", () => {
  const v = assessViability(snap(), "run");
  assertEquals(v.tier, "ok");
  assertEquals(v.reasons, []);
});

// --- run: heat boundary ----------------------------------------------------

Deno.test("run: blocked at extreme heat threshold (36C)", () => {
  const v = assessViability(snap({ apparentC: 36 }), "run");
  assertEquals(v.tier, "blocked");
});

Deno.test("run: caution just below extreme heat threshold (35C)", () => {
  const v = assessViability(snap({ apparentC: 35 }), "run");
  assertEquals(v.tier, "caution");
});

Deno.test("run: caution at hot threshold (28C)", () => {
  const v = assessViability(snap({ apparentC: 28 }), "run");
  assertEquals(v.tier, "caution");
});

Deno.test("run: ok just below hot threshold (27C)", () => {
  const v = assessViability(snap({ apparentC: 27 }), "run");
  assertEquals(v.tier, "ok");
});

// --- run: cold boundary ----------------------------------------------------

Deno.test("run: blocked at extreme cold threshold (-10C)", () => {
  const v = assessViability(snap({ apparentC: -10 }), "run");
  assertEquals(v.tier, "blocked");
});

Deno.test("run: caution just above extreme cold threshold (-9C)", () => {
  const v = assessViability(snap({ apparentC: -9 }), "run");
  assertEquals(v.tier, "caution");
});

Deno.test("run: caution at freezing threshold (0C)", () => {
  const v = assessViability(snap({ apparentC: 0 }), "run");
  assertEquals(v.tier, "caution");
});

Deno.test("run: ok just above freezing threshold (1C)", () => {
  const v = assessViability(snap({ apparentC: 1 }), "run");
  assertEquals(v.tier, "ok");
});

// --- run: humidity, wind, rain caution rules -------------------------------

Deno.test("run: caution on humid+warm combo", () => {
  const v = assessViability(snap({ humidity: 80, apparentC: 24 }), "run");
  assertEquals(v.tier, "caution");
});

Deno.test("run: ok when humid but not warm enough", () => {
  const v = assessViability(snap({ humidity: 90, apparentC: 23 }), "run");
  assertEquals(v.tier, "ok");
});

Deno.test("run: caution on strong wind (40 km/h)", () => {
  const v = assessViability(snap({ windKmh: 40 }), "run");
  assertEquals(v.tier, "caution");
});

Deno.test("run: caution on heavy rain likely", () => {
  const v = assessViability(snap({ precipProbMax: 70, precipMm: 3 }), "run");
  assertEquals(v.tier, "caution");
});

Deno.test("run: ok on light rain probability only", () => {
  const v = assessViability(snap({ precipProbMax: 70, precipMm: 1 }), "run");
  assertEquals(v.tier, "ok");
});

Deno.test("run: multiple caution triggers produce multiple reasons", () => {
  const v = assessViability(snap({ apparentC: 29, windKmh: 41 }), "run");
  assertEquals(v.tier, "caution");
  assertEquals(v.reasons.length, 2);
});

// --- ride: wind boundary ----------------------------------------------------

Deno.test("ride: blocked at crosswind threshold (45 km/h)", () => {
  const v = assessViability(snap({ windKmh: 45 }), "ride");
  assertEquals(v.tier, "blocked");
});

Deno.test("ride: caution just below crosswind threshold (44 km/h)", () => {
  const v = assessViability(snap({ windKmh: 44 }), "ride");
  assertEquals(v.tier, "caution");
});

Deno.test("ride: caution at elevated wind threshold (30 km/h)", () => {
  const v = assessViability(snap({ windKmh: 30 }), "ride");
  assertEquals(v.tier, "caution");
});

Deno.test("ride: ok just below elevated wind threshold (29 km/h)", () => {
  const v = assessViability(snap({ windKmh: 29 }), "ride");
  assertEquals(v.tier, "ok");
});

// --- ride: rain boundary -----------------------------------------------------

Deno.test("ride: blocked at heavy rain threshold", () => {
  const v = assessViability(snap({ precipProbMax: 70, precipMm: 2 }), "ride");
  assertEquals(v.tier, "blocked");
});

Deno.test("ride: caution below heavy-rain-blocked threshold but above caution", () => {
  const v = assessViability(snap({ precipProbMax: 50, precipMm: 0.5 }), "ride");
  assertEquals(v.tier, "caution");
});

Deno.test("ride: ok below rain caution threshold", () => {
  const v = assessViability(snap({ precipProbMax: 49, precipMm: 0.4 }), "ride");
  assertEquals(v.tier, "ok");
});

// --- ride: temperature boundaries -------------------------------------------

Deno.test("ride: blocked at extreme wind-chill threshold (-5C)", () => {
  const v = assessViability(snap({ apparentC: -5 }), "ride");
  assertEquals(v.tier, "blocked");
});

Deno.test("ride: caution just above extreme wind-chill threshold (-4C)", () => {
  const v = assessViability(snap({ apparentC: -4 }), "ride");
  assertEquals(v.tier, "caution");
});

Deno.test("ride: caution at cold threshold (2C)", () => {
  const v = assessViability(snap({ apparentC: 2 }), "ride");
  assertEquals(v.tier, "caution");
});

Deno.test("ride: ok just above cold threshold (3C)", () => {
  const v = assessViability(snap({ apparentC: 3 }), "ride");
  assertEquals(v.tier, "ok");
});

Deno.test("ride: blocked at extreme heat threshold (37C)", () => {
  const v = assessViability(snap({ apparentC: 37 }), "ride");
  assertEquals(v.tier, "blocked");
});

Deno.test("ride: caution just below extreme heat threshold (36C)", () => {
  const v = assessViability(snap({ apparentC: 36 }), "ride");
  assertEquals(v.tier, "caution");
});

Deno.test("ride: caution at hot threshold (30C)", () => {
  const v = assessViability(snap({ apparentC: 30 }), "ride");
  assertEquals(v.tier, "caution");
});

Deno.test("ride: ok just below hot threshold (29C)", () => {
  const v = assessViability(snap({ apparentC: 29 }), "ride");
  assertEquals(v.tier, "ok");
});

// --- combined / cross-cutting -----------------------------------------------

Deno.test("ride: multiple blocked triggers produce multiple reasons", () => {
  const v = assessViability(snap({ windKmh: 50, apparentC: 38 }), "ride");
  assertEquals(v.tier, "blocked");
  assertEquals(v.reasons.length, 2);
});

Deno.test("same snapshot can be ok for one sport and blocked for the other", () => {
  // precipMm=2 clears ride's blocked rain threshold (>=2) but not run's (>=3).
  const wetRoads = snap({ precipProbMax: 70, precipMm: 2 });
  assertEquals(assessViability(wetRoads, "ride").tier, "blocked");
  assertEquals(assessViability(wetRoads, "run").tier, "ok");
});

Deno.test("weather observations distinguish missing fields from genuine zero", async () => {
  const { getWeather } = await import("./weather.ts");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ current: {}, daily: {} })))) as typeof fetch;
    assertEquals(await getWeather(0, 0), null);
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ current: { time: "2026-10-23T12:00", temperature_2m: 0, apparent_temperature: 0,
      relative_humidity_2m: 50, wind_speed_10m: 0, precipitation: 0 }, daily: { precipitation_probability_max: [0], temperature_2m_max: [0] } })))) as typeof fetch;
    const weather = await getWeather(0, 0);
    assertEquals(weather?.tempC, 0); assertEquals(weather?.localDate, "2026-10-23");
  } finally { globalThis.fetch = original; }
});
