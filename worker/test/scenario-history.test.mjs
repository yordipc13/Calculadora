import test from "node:test";
import assert from "node:assert/strict";
import { resolveScenarioRate } from "../../scenario-history.mjs";

const rates = [{
  code: "423",
  short_name: "TBP",
  value: 4.5,
  reference_date: "2026-11-20",
  history: [
    { value: 4.0, reference_date: "2026-10-01" },
    { value: 4.25, reference_date: "2026-11-10" },
    { value: 4.5, reference_date: "2026-11-20" },
  ],
}];

test("uses the latest benchmark available on or before the cutoff date", () => {
  const result = resolveScenarioRate({ rateType: "tbp", spread: 12.5 }, rates, "2026-11-15");
  assert.equal(result.baseRate, 4.25);
  assert.equal(result.annualRate, 16.75);
  assert.equal(result.referenceDate, "2026-11-10");
});

test("rejects dates older than the available benchmark history", () => {
  assert.throws(() => resolveScenarioRate({ rateType: "tbp", spread: 10 }, rates, "2026-09-30"), /No hay una tasa/);
});

test("reuses the saved rate for a fixed-rate scenario", () => {
  const result = resolveScenarioRate({ rateType: "fixed", annualRate: 17.25 }, [], "2026-11-15");
  assert.equal(result.annualRate, 17.25);
  assert.equal(result.source, "Tasa fija guardada");
});

test("keeps the saved base rate for a manually entered variable-rate scenario", () => {
  const result = resolveScenarioRate({
    rateType: "tbp",
    annualRate: 16,
    spread: 2,
    rateSnapshot: { source: "Manual", benchmarkCode: "423", baseRate: 16 },
  }, rates, "2026-11-15");
  assert.equal(result.baseRate, 16);
  assert.equal(result.annualRate, 18);
  assert.equal(result.source, "Manual");
});