const BENCHMARK_CODES = { tbp: "423", ted: "23698", tpm: "3541" };

export function resolveScenarioRate(scenario, rates, cutoffDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cutoffDate || ""))) throw new Error("Seleccione una fecha de recálculo válida.");
  const rateType = scenario.rateType || "fixed";
  const spread = rateType === "fixed" ? 0 : Number(scenario.spread || 0);
  if (rateType === "fixed") {
    const annualRate = Number(scenario.annualRate);
    if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100) throw new Error("La tasa fija guardada no es válida.");
    return { annualRate, baseRate: annualRate, spread: 0, benchmark: null, referenceDate: null, source: "Tasa fija guardada" };
  }

  if (scenario.rateSnapshot?.source === "Manual") {
    const baseRate = Number(scenario.rateSnapshot.baseRate ?? scenario.annualRate);
    const annualRate = baseRate + spread;
    if (!Number.isFinite(spread) || spread < 0 || !Number.isFinite(baseRate) || baseRate < 0 || baseRate > 100 || annualRate > 100) throw new Error("La tasa efectiva calculada está fuera de rango.");
    return { annualRate, baseRate, spread, benchmark: null, referenceDate: null, source: "Manual" };
  }

  const code = scenario.rateSnapshot?.benchmarkCode || BENCHMARK_CODES[rateType];
  if (!code) throw new Error("No se reconoce la tasa de referencia de este escenario.");
  const rate = (rates || []).find((item) => String(item.code) === String(code));
  if (!rate) throw new Error(`No hay historial disponible para ${rateType.toUpperCase()}.`);
  const observations = [...(Array.isArray(rate.history) ? rate.history : []), rate]
    .filter((item) => item.reference_date && item.reference_date <= cutoffDate && Number.isFinite(Number(item.value)))
    .sort((a, b) => String(a.reference_date).localeCompare(String(b.reference_date)));
  const observation = observations.at(-1);
  if (!observation) throw new Error(`No hay una tasa ${rate.short_name || rateType.toUpperCase()} registrada al ${cutoffDate} o antes.`);

  const baseRate = Number(observation.value);
  const annualRate = baseRate + spread;
  if (!Number.isFinite(spread) || spread < 0 || !Number.isFinite(annualRate) || annualRate > 100) throw new Error("La tasa efectiva calculada está fuera de rango.");
  return {
    annualRate,
    baseRate,
    spread,
    benchmark: rate.short_name || rate.name || rateType.toUpperCase(),
    benchmarkCode: String(code),
    referenceDate: observation.reference_date,
    source: "BCCR SDDE",
  };
}