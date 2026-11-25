import { calculateLoan } from "./worker/src/loan.js";
import { extractFinancialData as parseDocumentFields, normalizeFinancialDate, parseFinancialNumber } from "./document-extraction.mjs";
import { resolveScenarioRate } from "./scenario-history.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API_BASE = document.querySelector('meta[name="api-base"]')?.content.replace(/\/$/, "") || "/api";
const state = {
  schedule: [], rates: [], rateFilter: "ALL", source: null, pdf: null, image: null,
  page: 1, pageCount: 1, redactions: new Map(), pointerStart: null, flatDocument: null,
  transactions: [], debts: [], calculationSequence: 0, activeRateCode: null, applyingRate: false,
  extractionIssues: [], extractionMissing: [], rejectedTransactions: 0,
};

function formatMoney(value, currency = $("#currency")?.value || "CRC", digits = 0) {
  return new Intl.NumberFormat("es-CR", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number.isFinite(Number(value)) ? Number(value) : 0);
}
function escapeHtml(value) { const node = document.createElement("span"); node.textContent = String(value ?? ""); return node.innerHTML; }
function parseAmount(value) {
  return parseFinancialNumber(value) ?? 0;
}

function calculateSchedule(principal, annualRate, months) {
  let monthlyRate = Math.pow(1 + annualRate / 100, 1 / 12) - 1;
  const regularPayment = monthlyRate === 0 ? principal / months : principal * monthlyRate / (1 - Math.pow(1 + monthlyRate, -months));
  const extra = Number($("#extra-payment")?.value || 0);
  const extraStartMonth = Math.max(1, Number($("#extra-start-month")?.value || 1));
  const extraMode = $("#extra-mode")?.value || "reduceTerm";
  const changeMonth = Number($("#rate-change-month")?.value || 0);
  const changeValue = Number($("#rate-change-value")?.value || annualRate);
  let balance = principal; let payment = regularPayment; let totalInterest = 0; const schedule = [];
  for (let month = 1; balance > 0.005 && month <= months * 2; month += 1) {
    if (changeMonth === month && changeMonth > 1) {
      monthlyRate = Math.pow(1 + changeValue / 100, 1 / 12) - 1;
      const periodsLeft = Math.max(1, months - month + 1);
      payment = monthlyRate === 0 ? balance / periodsLeft : balance * monthlyRate / (1 - Math.pow(1 + monthlyRate, -periodsLeft));
    }
    const interest = balance * monthlyRate;
    let planned = Math.min(balance + interest, payment);
    if (planned - interest >= balance) planned = balance + interest;
    let capital = Math.max(0, planned - interest);
    const extraCapital = Math.min(Math.max(0, balance - capital), month >= extraStartMonth ? extra : 0);
    balance = Math.max(0, balance - capital - extraCapital);
    if (extraMode === "reducePayment" && extraCapital > 0 && balance > 0) {
      const remaining = Math.max(1, months - month);
      payment = monthlyRate === 0 ? balance / remaining : balance * monthlyRate / (1 - Math.pow(1 + monthlyRate, -remaining));
    }
    totalInterest += interest;
    schedule.push({ month, payment: planned + extraCapital, capital: capital + extraCapital, extraCapital, interest, balance });
  }
  return { schedule, payment: regularPayment, totalInterest, totalPaid: principal + totalInterest };
}

function updateCalculator() {
  const principalInput = $("#amount"); const currency = $("#currency").value;
  if (currency === "USD") { principalInput.min = "1000"; principalInput.max = "300000"; principalInput.step = "1000"; $("#term").max = "240"; }
  else { principalInput.min = "300000"; principalInput.max = "50000000"; principalInput.step = "100000"; $("#term").max = "360"; }
  if (Number($("#term").value) > Number($("#term").max)) $("#term").value = $("#term").max;
  $("#extra-start-month").max = $("#term").value;
  if (Number($("#extra-start-month").value) > Number($("#term").value)) $("#extra-start-month").value = $("#term").value;
  $("#rate-change-month").max = $("#term").value;
  if (Number($("#rate-change-month").value) > Number($("#term").value)) $("#rate-change-month").value = "0";
  if (Number($("#rate-change-month").value) === 1) $("#rate-change-month").value = "0";
  let principal = Number(principalInput.value);
  if (principal < Number(principalInput.min)) { principal = Number(principalInput.min); principalInput.value = String(principal); }
  if (principal > Number(principalInput.max)) { principal = Number(principalInput.max); principalInput.value = String(principal); }
  const months = Number($("#term").value); const rateType = $("#rate-type").value;
  const baseRate = Number($("#rate").value); const spread = rateType === "fixed" ? 0 : Number($("#spread").value);
  const annualRate = baseRate + spread;
  $("#amount-output").textContent = formatMoney(principal);
  $("#rate-output").textContent = `${baseRate.toFixed(2)}%`;
  $("#spread-output").textContent = `${spread.toFixed(2)}%`;
  $("#term-output").textContent = `${months} meses`;
  $("#spread-label").style.opacity = rateType === "fixed" ? "0.45" : "1";
  $("#spread").disabled = rateType === "fixed";
  const result = calculateSchedule(principal, annualRate, months); state.schedule = result.schedule;
  $("#metric-principal").textContent = formatMoney(principal);
  $("#metric-term").textContent = `${months} meses`;
  $("#metric-rate").textContent = `${annualRate.toFixed(2)}%`;
  $("#metric-payment").textContent = formatMoney(result.schedule[0]?.payment || 0);
  $("#metric-interest").textContent = formatMoney(result.totalInterest);
  $("#metric-total").textContent = formatMoney(result.totalPaid);
  const officialRate = state.activeRateCode && rateByCode(state.activeRateCode);
  $("#rate-source-note").textContent = officialRate
    ? `${officialRate.short_name} BCCR: ${Number(officialRate.value).toFixed(2)}% anual efectiva · dato del ${officialRate.reference_date}. Puedes editar la tasa y el spread.`
    : "Tasa anual efectiva editable. La proyección supone que se mantiene constante, salvo el ajuste indicado.";
  calculateWithWorker(principal, annualRate, months);
  renderSchedule(); drawChart(); updateFxResult();
}

function renderSchedule() {
  $("#schedule-body").innerHTML = state.schedule.map((row) => `<tr><td>${row.month}</td><td>${formatMoney(row.payment)}</td><td>${formatMoney(Number(row.capital) + Number(row.extraCapital || 0))}</td><td>${formatMoney(row.interest)}</td><td>${formatMoney(row.balance)}</td></tr>`).join("");
}
async function calculateWithWorker(principal, annualRate, months) {
  const extraPayment = Number($("#extra-payment").value || 0);
  const changeMonth = Number($("#rate-change-month").value || 0);
  if (!API_BASE || (!extraPayment && changeMonth < 2)) return;
  const sequence = ++state.calculationSequence;
  const rateChanges = changeMonth >= 2 ? [{ month: changeMonth, annualRate: Number($("#rate-change-value").value) }] : [];
  try {
    const response = await fetch(`${API_BASE}/loans/calculate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principal, annualRate, months, extraPayment, extraMode: $("#extra-mode").value, extraStartMonth: Number($("#extra-start-month").value || 1), rateChanges }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "No se pudo calcular");
    if (sequence !== state.calculationSequence) return;
    state.schedule = result.schedule; renderSchedule(); drawChart();
    $("#metric-payment").textContent = formatMoney(result.regularPayment);
    $("#metric-interest").textContent = formatMoney(result.totalInterest);
    $("#metric-total").textContent = formatMoney(result.totalPaid);
  } catch (error) { if (sequence === state.calculationSequence) $("#scenario-status").textContent = `Cálculo local mostrado. Worker: ${error.message}`; }
}
function drawChart() {
  const canvas = $("#balance-chart"); if (!canvas) return;
  const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
  const scale = window.devicePixelRatio || 1; canvas.width = rect.width * scale; canvas.height = rect.height * scale;
  const ctx = canvas.getContext("2d"); ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
  const pad = { left: 72, right: 16, top: 16, bottom: 38 }; const w = rect.width - pad.left - pad.right; const h = rect.height - pad.top - pad.bottom;
  if (!state.schedule.length || w <= 0 || h <= 0) return;
  const max = Number($("#amount").value) || 1; ctx.font = "12px Trebuchet MS"; ctx.strokeStyle = "rgba(32,40,38,.16)"; ctx.fillStyle = "#59635f";
  for (let i = 0; i <= 4; i += 1) { const y = pad.top + h * i / 4; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + w, y); ctx.stroke(); ctx.textAlign = "right"; ctx.fillText(formatMoney(max * (1 - i / 4)), pad.left - 8, y + 4); }
  ctx.beginPath(); state.schedule.forEach((row, i) => { const x = pad.left + w * i / Math.max(1, state.schedule.length - 1); const y = pad.top + h * row.balance / max; i ? ctx.lineTo(x, y) : ctx.moveTo(x, pad.top); });
  ctx.lineTo(pad.left + w, pad.top + h); ctx.lineTo(pad.left, pad.top + h); ctx.closePath(); ctx.fillStyle = "rgba(36,127,107,.16)"; ctx.fill();
  ctx.beginPath(); state.schedule.forEach((row, i) => { const x = pad.left + w * i / Math.max(1, state.schedule.length - 1); const y = pad.top + h * row.balance / max; i ? ctx.lineTo(x, y) : ctx.moveTo(x, pad.top); }); ctx.strokeStyle = "#247f6b"; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = "#59635f"; ctx.textAlign = "left"; ctx.fillText("0", pad.left, rect.height - 8); ctx.textAlign = "right"; ctx.fillText(String(state.schedule.length), pad.left + w, rect.height - 8);
}
function switchView(name) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `${name}-view`));
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === name));
  if (name === "calculator") requestAnimationFrame(drawChart);
  if (name === "rates") loadRates();
}
function exportSchedule() {
  if (!state.schedule.length) return;
  const rows = [["Mes", "Cuota", "Capital", "Interes", "Saldo"], ...state.schedule.map((row) => [row.month, row.payment.toFixed(2), row.capital.toFixed(2), row.interest.toFixed(2), row.balance.toFixed(2)])];
  const blob = new Blob([rows.map((row) => row.join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "plan-amortizacion.csv" }); link.click(); URL.revokeObjectURL(link.href);
}
function saveScenario() {
  const principal = Number($("#amount").value); const annualRate = Number($("#rate").value); const months = Number($("#term").value); const cutoffDate = $("#cutoff-date").value;
  if (!(principal > 0) || annualRate < 0 || annualRate > 100 || months < 1 || !cutoffDate) { $("#scenario-status").textContent = "Revise monto, tasa, plazo y fecha de corte."; return; }
  const rateType = $("#rate-type").value; const spread = rateType === "fixed" ? 0 : Number($("#spread").value);
  const benchmarkCode = ({ tbp: "423", ted: "23698", tpm: "3541" })[rateType] || null;
  const officialRate = benchmarkCode && rateByCode(benchmarkCode);
  const rateSnapshot = {
    benchmarkCode, benchmark: officialRate?.short_name || null, baseRate: annualRate, spread,
    referenceValue: officialRate ? Number(officialRate.value) : null,
    referenceDate: officialRate?.reference_date || null,
    source: state.activeRateCode === benchmarkCode && officialRate && Number(officialRate.value) === annualRate ? "BCCR SDDE" : "Manual",
  };
  const assumptions = {
    extraPayment: Number($("#extra-payment").value || 0), extraMode: $("#extra-mode").value,
    extraStartMonth: Number($("#extra-start-month").value || 1),
    rateChangeMonth: Number($("#rate-change-month").value || 0), rateChangeValue: Number($("#rate-change-value").value || annualRate),
  };
  const effectiveRate = annualRate + spread;
  const baseline = calculateLoan({ principal, annualRate: effectiveRate, months, ...assumptions, rateChanges: assumptions.rateChangeMonth >= 2 ? [{ month: assumptions.rateChangeMonth, annualRate: assumptions.rateChangeValue }] : [] });
  const scenario = {
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), cutoffDate, currency: $("#currency").value,
    principal, rateType, annualRate, spread, months, assumptions, rateSnapshot,
    schedule: baseline.schedule, recalculations: [],
    snapshot: { payment: baseline.regularPayment, totalInterest: baseline.totalInterest, totalPaid: baseline.totalPaid, effectiveRate, rate: rateSnapshot },
  };
  const scenarios = JSON.parse(localStorage.getItem("financialScenarios") || "[]"); scenarios.push(scenario); localStorage.setItem("financialScenarios", JSON.stringify(scenarios));
  $("#scenario-status").textContent = "Escenario guardado localmente."; loadScenarios();
}
function formatDifference(value, currency) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatMoney(Math.abs(value), currency, 2)}`;
}
function scenarioComparisonMarkup(scenario) {
  const last = scenario.recalculations?.at(-1);
  if (!last) return '<div class="scenario-comparison"><span>Sin recálculo histórico</span></div>';
  const original = scenario.snapshot || {};
  return `<div class="scenario-comparison"><strong>Recálculo al ${escapeHtml(last.cutoffDate)}</strong><span>${escapeHtml(last.rateDescription)}</span><span>Δ cuota ${formatDifference(last.result.regularPayment - Number(original.payment || 0), scenario.currency)} · Δ intereses ${formatDifference(last.result.totalInterest - Number(original.totalInterest || 0), scenario.currency)} · Δ total ${formatDifference(last.result.totalPaid - Number(original.totalPaid || 0), scenario.currency)}</span></div>`;
}
function loadScenarios() {
  const scenarios = JSON.parse(localStorage.getItem("financialScenarios") || "[]"); const container = $("#scenario-list"); if (!container) return;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  container.innerHTML = scenarios.length ? scenarios.slice().reverse().map((s) => {
    const savedRate = s.rateSnapshot?.source === "BCCR SDDE" && s.rateSnapshot.referenceDate
      ? `${escapeHtml(s.rateSnapshot.benchmark || "BCCR")} ${Number(s.rateSnapshot.referenceValue).toFixed(2)}% del ${escapeHtml(s.rateSnapshot.referenceDate)}`
      : `${s.rateType === "fixed" ? "Tasa fija" : "Base manual"} ${Number(s.annualRate || 0).toFixed(2)}%${s.spread ? ` + ${Number(s.spread).toFixed(2)}% spread` : ""}`;
    return `<article class="scenario-item" data-scenario-id="${escapeHtml(s.id)}"><div class="scenario-summary"><strong>${escapeHtml(s.currency)} · ${formatMoney(s.principal, s.currency)}</strong><span>${Number(s.snapshot?.effectiveRate ?? (Number(s.annualRate || 0) + Number(s.spread || 0))).toFixed(2)}% anual · ${s.months} meses</span><span>${savedRate} · corte ${escapeHtml(s.cutoffDate || "sin fecha")}</span></div><div class="scenario-actions"><label>Fecha de recálculo<input type="date" data-scenario-date value="${escapeHtml(s.cutoffDate || "")}" max="${today}" /></label><button class="secondary recalculate-scenario" data-id="${escapeHtml(s.id)}" type="button">Recalcular</button><button class="secondary restore-scenario" data-id="${escapeHtml(s.id)}" type="button">Restaurar</button></div>${scenarioComparisonMarkup(s)}<p class="scenario-status" role="status"></p></article>`;
  }).join("") : '<p class="status">No hay escenarios guardados.</p>';
  $$(".restore-scenario", container).forEach((button) => button.addEventListener("click", () => restoreScenario(button.dataset.id)));
  $$(".recalculate-scenario", container).forEach((button) => button.addEventListener("click", () => recalculateScenario(button.dataset.id, button)));
}
function recalculateScenario(id, button) {
  const scenarios = JSON.parse(localStorage.getItem("financialScenarios") || "[]");
  const scenario = scenarios.find((item) => item.id === id);
  const card = button.closest(".scenario-item");
  const status = $(".scenario-status", card);
  const cutoffDate = $("[data-scenario-date]", card).value;
  try {
    if (!scenario) throw new Error("No se encontró el escenario guardado.");
    const rate = resolveScenarioRate(scenario, state.rates, cutoffDate);
    const assumptions = scenario.assumptions || {};
    const rateChangeMonth = Number(assumptions.rateChangeMonth || 0);
    const result = calculateLoan({
      principal: Number(scenario.principal), annualRate: rate.annualRate, months: Number(scenario.months),
      extraPayment: Number(assumptions.extraPayment || 0), extraMode: assumptions.extraMode || "reduceTerm",
      extraStartMonth: Number(assumptions.extraStartMonth || 1),
      rateChanges: rateChangeMonth >= 2 ? [{ month: rateChangeMonth, annualRate: Number(assumptions.rateChangeValue) }] : [],
    });
    const rateDescription = rate.benchmark
      ? `${rate.benchmark} ${rate.baseRate.toFixed(2)}% + ${rate.spread.toFixed(2)}% spread = ${rate.annualRate.toFixed(2)}% anual · dato BCCR ${rate.referenceDate}`
      : `Tasa fija guardada ${rate.annualRate.toFixed(2)}% anual`;
    scenario.recalculations = [...(scenario.recalculations || []), {
      cutoffDate, createdAt: new Date().toISOString(), rate: { ...rate }, rateDescription,
      result: { regularPayment: result.regularPayment, totalInterest: result.totalInterest, totalPaid: result.totalPaid, monthsPaid: result.monthsPaid },
    }].slice(-20);
    localStorage.setItem("financialScenarios", JSON.stringify(scenarios));
    loadScenarios();
  } catch (error) {
    status.textContent = error.message;
  }
}
function restoreScenario(id) {
  const s = JSON.parse(localStorage.getItem("financialScenarios") || "[]").find((item) => item.id === id); if (!s) return;
  const code = ({ tbp: "423", ted: "23698", tpm: "3541" })[s.rateType];
  $("#currency").value = s.currency; $("#amount").value = String(s.principal); $("#rate-type").value = s.rateType || "fixed";
  $("#rate").value = String(s.annualRate); $("#spread").value = String(s.spread || 0); $("#term").value = String(s.months);
  $("#extra-payment").value = String(s.assumptions?.extraPayment || 0); $("#extra-mode").value = s.assumptions?.extraMode || "reduceTerm";
  $("#extra-start-month").value = String(s.assumptions?.extraStartMonth || 1);
  $("#rate-change-month").value = String(s.assumptions?.rateChangeMonth || 0); $("#rate-change-value").value = String(s.assumptions?.rateChangeValue ?? s.annualRate);
  $("#cutoff-date").value = s.cutoffDate || "";
  const currentRate = code && rateByCode(code);
  state.activeRateCode = s.rateSnapshot?.source === "BCCR SDDE" ? code : currentRate && Number(currentRate.value) === Number(s.annualRate) ? code : null;
  updateCalculator(); $("#scenario-status").textContent = "Escenario restaurado.";
}

const rateByCode = (code) => state.rates.find((rate) => String(rate.code) === String(code));
function renderRateCard(rate) {
  const currencyLabel = rate.unit === "CRC" ? "CRC por USD" : rate.currency === "USD" ? "USD ($)" : "CRC (₡)";
  const isPercent = rate.unit === "percent";
  const current = Number(rate.value);
  const history = Array.isArray(rate.history) ? rate.history : [];
  const previous = rate.previous_value === null ? null : Number(rate.previous_value);
  const change = previous === null ? "Sin dato anterior" : current === previous ? "Sin cambios" : `${current > previous ? "↑ +" : "↓ −"}${new Intl.NumberFormat("es-CR", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Math.abs(current - previous))}${isPercent ? " pp" : " ₡"}`;
  const trend = history.length > 1 ? `<svg class="trend-chart" viewBox="0 0 300 72" role="img" aria-label="Tendencia reciente de ${escapeHtml(rate.short_name)}">${(() => { const values = history.map((item) => Number(item.value)); const min = Math.min(...values); const max = Math.max(...values); const span = max - min || 1; return `<polyline points="${values.map((value, index) => `${index * 300 / (values.length - 1)},${64 - (value - min) / span * 56}`).join(" ")}" />`; })()}</svg><p>${history.length} cambios recientes registrados</p>` : '<p>Aún no hay suficientes cambios de valor para mostrar una tendencia.</p>';
  return `<article class="rate-card"><div class="rate-card-head"><span class="rate-code">${escapeHtml(rate.short_name || rate.name)}</span><span class="rate-currency">${currencyLabel}</span></div><h2>${escapeHtml(rate.name)}</h2><strong class="rate-value">${isPercent ? `${current.toFixed(2)}% anual` : formatMoney(current, "CRC", 2)}</strong><p class="rate-change">${escapeHtml(change)} respecto al valor anterior</p><dl><div><dt>Fecha oficial del dato</dt><dd>${escapeHtml(rate.reference_date || "Sin fecha")}</dd></div><div><dt>Última verificación</dt><dd>${rate.last_verification ? escapeHtml(new Intl.DateTimeFormat("es-CR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Costa_Rica" }).format(new Date(rate.last_verification))) : "Sin verificación"}</dd></div></dl><p class="rate-description">${escapeHtml(rate.description || "Indicador publicado por el BCCR.")}</p><div class="rate-card-actions"><button class="primary use-rate" data-code="${escapeHtml(rate.code)}">Usar en calculadora</button><button class="secondary toggle-trend" aria-expanded="false">Ver tendencia</button></div><div class="trend-content" hidden>${trend}</div></article>`;
}
function renderRates() {
  const visible = state.rates.filter((rate) => state.rateFilter === "ALL" || rate.currency === state.rateFilter);
  $("#rates-grid").innerHTML = visible.length ? visible.map(renderRateCard).join("") : '<article class="panel"><p>No hay datos BCCR disponibles todavía. El Worker conservará y mostrará el último dato válido cuando la API responda.</p></article>';
  $$(".use-rate").forEach((button) => button.addEventListener("click", () => useRate(button.dataset.code)));
  $$(".toggle-trend").forEach((button) => button.addEventListener("click", () => { const content = button.closest(".rate-card").querySelector(".trend-content"); content.hidden = !content.hidden; button.setAttribute("aria-expanded", String(!content.hidden)); button.textContent = content.hidden ? "Ver tendencia" : "Ocultar tendencia"; }));
}
async function loadRates() {
  const badge = $("#rates-service-status"); let stale = false;
  try {
    const response = await fetch(`${API_BASE}/rates`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Worker HTTP ${response.status}`);
    const payload = await response.json(); state.rates = payload.rates || [];
    localStorage.setItem("bccrRatesPublicCache", JSON.stringify({ rates: state.rates, checkedAt: payload.checkedAt }));
  } catch {
    stale = true; const cached = JSON.parse(localStorage.getItem("bccrRatesPublicCache") || "null"); state.rates = cached?.rates || [];
  }
  const hasError = state.rates.some((rate) => rate.service_status === "error");
  const verification = state.rates.map((rate) => rate.last_verification).filter(Boolean).sort().at(-1);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const checkedToday = verification && new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(verification)) === today;
  const latestReference = state.rates.map((rate) => rate.reference_date).filter(Boolean).sort().at(-1);
  badge.textContent = !state.rates.length && stale ? "Worker sin conexión · todavía no hay datos locales" : stale || hasError ? `Mostrando último dato válido${latestReference ? ` del ${new Intl.DateTimeFormat("es-CR", { dateStyle: "short", timeZone: "America/Costa_Rica" }).format(new Date(`${latestReference}T12:00:00`))}` : ""}` : checkedToday ? "Actualizado hoy · BCCR" : verification ? `Verificado ${new Intl.DateTimeFormat("es-CR", { dateStyle: "short", timeZone: "America/Costa_Rica" }).format(new Date(verification))}` : "A la espera de la primera sincronización";
  badge.classList.toggle("stale", stale || hasError); renderRates(); updateFxResult();
}
function useRate(code) {
  const rate = rateByCode(code); if (!rate) return;
  switchView("calculator");
  if (rate.unit === "percent") {
    state.activeRateCode = String(code);
    $("#currency").value = rate.currency;
    $("#rate-type").value = ({ "423": "tbp", "23698": "ted", "3541": "tpm" })[String(code)] || "fixed";
    $("#rate").value = String(Number(rate.value).toFixed(2));
    updateCalculator();
    $("#spread").focus();
  } else {
    $("#fx-direction").value = String(code) === "317" ? "USD_CRC" : "CRC_USD";
    updateFxResult(); $("#fx-amount").focus();
    $("#scenario-status").textContent = `Tipo de cambio ${rate.short_name} cargado en el conversor.`;
  }
}
function selectRateType() {
  const code = ({ tbp: "423", ted: "23698", tpm: "3541" })[$("#rate-type").value];
  const rate = code && rateByCode(code);
  if (!rate) { state.activeRateCode = null; updateCalculator(); return; }
  $("#currency").value = rate.currency; state.activeRateCode = code; state.applyingRate = true; $("#rate").value = String(Number(rate.value).toFixed(2)); state.applyingRate = false; updateCalculator();
}
function changeCurrency() {
  const currentType = $("#rate-type").value;
  const code = ({ tbp: "423", ted: "23698", tpm: "3541" })[currentType];
  const rate = code && rateByCode(code);
  if (currentType !== "fixed" && (!rate || rate.currency !== $("#currency").value)) { $("#rate-type").value = "fixed"; state.activeRateCode = null; }
  updateCalculator();
}
function updateFxResult() {
  const amount = Number($("#fx-amount")?.value || 0); const direction = $("#fx-direction")?.value || "USD_CRC";
  const code = direction === "USD_CRC" ? "317" : "318"; const rate = rateByCode(code);
  $("#fx-result").textContent = rate ? formatMoney(direction === "USD_CRC" ? amount * Number(rate.value) : amount / Number(rate.value), direction === "USD_CRC" ? "CRC" : "USD", 2) : "Tasas BCCR pendientes";
}
function useFxRate() { const code = $("#fx-direction").value === "USD_CRC" ? "317" : "318"; const rate = rateByCode(code); if (!rate) return; $("#fx-amount").value = String(Number($("#amount").value) || 0); updateFxResult(); $("#scenario-status").textContent = `Conversión referencial lista con tipo de cambio ${rate.short_name}. No modifica el préstamo.`; }

function drawRedactions() {
  const canvas = $("#redaction-canvas"); const rects = state.redactions.get(state.page) || [];
  const ctx = canvas.getContext("2d"); rects.forEach((r) => { ctx.fillStyle = "#000"; ctx.fillRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height); });
}
async function renderDocumentPage() {
  const canvas = $("#redaction-canvas"); const ctx = canvas.getContext("2d");
  if (state.pdf) {
    const page = await state.pdf.getPage(state.page); const viewport = page.getViewport({ scale: Math.min(1.6, 1100 / page.getViewport({ scale: 1 }).width) });
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); await page.render({ canvasContext: ctx, viewport }).promise;
  } else if (state.image) {
    const image = state.image; const scale = Math.min(1, 1200 / image.width); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  drawRedactions();
  $("#page-indicator").textContent = state.pdf ? `Página ${state.page} de ${state.pageCount}` : "Imagen · página 1 de 1";
  $("#prev-page").disabled = state.page <= 1; $("#next-page").disabled = state.page >= state.pageCount;
  $("#flatten-ocr").disabled = !state.pdf && !state.image;
  $("#undo-redaction").disabled = !(state.redactions.get(state.page) || []).length;
}
async function readDocumentFile(file) {
  clearDocument({ keepStatus: true }); state.source = file; state.redactions = new Map(); state.flatDocument = null;
  $("#privacy-status").textContent = "Abriendo el archivo en memoria local…";
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error("El documento supera el límite local de 25 MB.");
    if (file.type === "application/pdf") {
      if (!window.pdfjsLib) throw new Error("PDF.js no se cargó. Compruebe la conexión y vuelva a abrir el archivo.");
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      state.pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise; state.pageCount = state.pdf.numPages;
      if (state.pageCount > 40) throw new Error("El PDF supera el límite local de 40 páginas.");
    } else if (file.type.startsWith("image/")) {
      state.image = await createImageBitmap(file);
      if (state.image.width * state.image.height > 40000000) throw new Error("La imagen supera el límite local de 40 megapíxeles.");
      state.pageCount = 1; state.page = 1;
    } else { throw new Error("Para proteger el documento, cargue PDF o imagen. Puede ingresar CSV en la pestaña manual."); }
    await renderDocumentPage(); $("#privacy-status").textContent = "Dibuja rectángulos negros sobre cada dato personal. Luego confirma para aplanar y extraer localmente.";
  } catch (error) { clearDocument({ keepStatus: true }); $("#privacy-status").textContent = error.message; }
}
function pointerPosition(event) { const canvas = $("#redaction-canvas"); const r = canvas.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (event.clientY - r.top) / r.height)) }; }
function beginRedaction(event) { if (!state.source) return; event.preventDefault(); state.pointerStart = pointerPosition(event); $("#redaction-canvas").setPointerCapture(event.pointerId); }
function finishRedaction(event) {
  if (!state.pointerStart) return; const end = pointerPosition(event); const x = Math.min(state.pointerStart.x, end.x); const y = Math.min(state.pointerStart.y, end.y); const w = Math.abs(end.x - state.pointerStart.x); const h = Math.abs(end.y - state.pointerStart.y); state.pointerStart = null;
  if (w < 0.004 || h < 0.004) return;
  const rects = state.redactions.get(state.page) || []; rects.push({ x, y, w, h }); state.redactions.set(state.page, rects); renderDocumentPage();
}
function undoRedaction() { const rects = state.redactions.get(state.page) || []; rects.pop(); state.redactions.set(state.page, rects); renderDocumentPage(); }
async function flattenAndExtract() {
  if (!state.pdf && !state.image) return;
  const button = $("#flatten-ocr"); button.disabled = true; button.textContent = "Aplanando y extrayendo…";
  try {
    const canvases = [];
    if (state.pdf) {
      for (let pageNumber = 1; pageNumber <= state.pageCount; pageNumber += 1) {
        const page = await state.pdf.getPage(pageNumber); const viewport = page.getViewport({ scale: Math.min(1.6, 1100 / page.getViewport({ scale: 1 }).width) });
        const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        (state.redactions.get(pageNumber) || []).forEach((r) => { const c = canvas.getContext("2d"); c.fillStyle = "#000"; c.fillRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height); }); canvases.push(canvas);
      }
    } else {
      const canvas = document.createElement("canvas"); canvas.width = $("#redaction-canvas").width; canvas.height = $("#redaction-canvas").height; canvas.getContext("2d").drawImage($("#redaction-canvas"), 0, 0); canvases.push(canvas);
    }
    const flattenedPages = await Promise.all(canvases.map((canvas) => new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("No se pudo aplanar la página")), "image/png"))));
    if (!window.Tesseract) throw new Error("Tesseract.js no se cargó. Compruebe la conexión y vuelva a intentar.");
    const worker = await Tesseract.createWorker("spa"); const text = [];
    try { for (const page of flattenedPages) text.push((await worker.recognize(page)).data.text); }
    finally { await worker.terminate(); }
    state.pdf?.destroy(); state.pdf = null; state.image?.close?.(); state.image = null; state.source = null; state.flatDocument = null; $("#document-file").value = "";
    $("#document-preview").innerHTML = `<p>Documento aplanado en memoria; ${canvases.length} página(s) procesada(s). No se guarda ni se transmite.</p><pre>${escapeHtml(text.join("\n"))}</pre>`;
    state.sourceText = text.join("\n"); extractFinancialData(state.sourceText); $("#privacy-status").textContent = "OCR local completado. Corrige y revisa los campos y cada consumo antes de comparar deudas.";
    $("#redaction-canvas").getContext("2d").clearRect(0, 0, $("#redaction-canvas").width, $("#redaction-canvas").height); $("#page-indicator").textContent = "Documento aplanado y descartado";
  } catch (error) { $("#privacy-status").textContent = `No se pudo completar el OCR local: ${error.message}`; }
  button.textContent = "Confirmar censura y extraer datos"; button.disabled = !state.source;
}
function normalizeDate(value) { return normalizeFinancialDate(value); }
function validFinancialField(id) {
  const value = $(`#${id}`).value.trim();
  if (!value) return false;
  if (id === "financial-date") return normalizeFinancialDate(value) === value;
  if (id === "financial-rate") { const rate = Number(value); return Number.isFinite(rate) && rate >= 0 && rate <= 100; }
  const amount = parseFinancialNumber(value);
  return Number.isFinite(amount) && amount > 0;
}
function updateExtractionReview() {
  const inputIds = { date: "financial-date", amount: "financial-amount", payment: "financial-payment", balance: "financial-balance", annualRate: "financial-rate", minimumPayment: "financial-minimum" };
  state.extractionIssues = state.extractionIssues.filter((issue) => !validFinancialField(inputIds[issue.id]));
  const messages = state.extractionIssues.map((issue) => issue.message);
  if (state.extractionMissing.length) messages.push(`No se detectó: ${state.extractionMissing.join(", ")}.`);
  if (state.rejectedTransactions) messages.push(`${state.rejectedTransactions} fila(s) de consumo se descartaron por fecha o monto incompleto/inválido.`);
  if (!messages.length) messages.push("Revise los campos detectados y confirme antes de guardar.");
  const review = $("#extraction-review");
  review.textContent = messages.join(" ");
  review.classList.toggle("warning", state.extractionIssues.length > 0 || state.rejectedTransactions > 0);
  $("#save-anonymized").disabled = !$("#consent").checked || state.extractionIssues.length > 0;
  return state.extractionIssues.length === 0;
}
function extractFinancialData(text) {
  const extracted = parseDocumentFields(text, $("#financial-currency").value);
  const inputIds = { date: "financial-date", amount: "financial-amount", payment: "financial-payment", balance: "financial-balance", annualRate: "financial-rate", minimumPayment: "financial-minimum" };
  Object.entries(inputIds).forEach(([field, id]) => { $(`#${id}`).value = extracted.fields[field].value ?? ""; });
  state.extractionIssues = extracted.issues;
  state.extractionMissing = extracted.missing;
  state.rejectedTransactions = extracted.rejectedTransactions;
  state.transactions = extracted.transactions;
  if (state.transactions.length && state.transactions.every((row) => row.currency === state.transactions[0].currency)) $("#financial-currency").value = state.transactions[0].currency;
  renderTransactions(); renderDebts(); updateExtractionReview();
}
function renderTransactions() {
  $("#transactions-body").innerHTML = state.transactions.map((row, index) => `<tr><td><input type="date" data-tx="${index}" data-field="date" value="${escapeHtml(row.date)}"></td><td><input type="text" maxlength="120" data-tx="${index}" data-field="concept" value="${escapeHtml(row.concept)}"></td><td><input type="number" min="0" step="0.01" data-tx="${index}" data-field="amount" value="${Number(row.amount) || 0}"></td><td><select data-tx="${index}" data-field="currency"><option value="CRC" ${row.currency === "CRC" ? "selected" : ""}>CRC</option><option value="USD" ${row.currency === "USD" ? "selected" : ""}>USD</option></select></td><td><button type="button" class="danger remove-transaction" data-index="${index}" aria-label="Eliminar consumo">×</button></td></tr>`).join("");
  $$('[data-tx]', $("#transactions-body")).forEach((input) => input.addEventListener("change", () => { const row = state.transactions[Number(input.dataset.tx)]; row[input.dataset.field] = input.dataset.field === "amount" ? Number(input.value) : input.value; }));
  $$(".remove-transaction").forEach((button) => button.addEventListener("click", () => { state.transactions.splice(Number(button.dataset.index), 1); renderTransactions(); }));
}
function renderDebts() {
  $("#debts-body").innerHTML = state.debts.map((debt, index) => `<tr><td><input type="text" maxlength="100" data-debt="${index}" data-field="name" value="${escapeHtml(debt.name)}"></td><td><input type="number" min="0" step="0.01" data-debt="${index}" data-field="balance" value="${Number(debt.balance) || 0}"></td><td><input type="number" min="0" max="100" step="0.01" data-debt="${index}" data-field="annualRate" value="${Number(debt.annualRate) || 0}"></td><td><input type="number" min="0" step="0.01" data-debt="${index}" data-field="minimumPayment" value="${Number(debt.minimumPayment) || 0}"></td><td><select data-debt="${index}" data-field="currency"><option value="CRC" ${debt.currency === "CRC" ? "selected" : ""}>CRC</option><option value="USD" ${debt.currency === "USD" ? "selected" : ""}>USD</option></select></td><td><button class="danger remove-debt" data-index="${index}" type="button" aria-label="Quitar deuda">×</button></td></tr>`).join("");
  $$('[data-debt]', $("#debts-body")).forEach((input) => input.addEventListener("change", () => { const debt = state.debts[Number(input.dataset.debt)]; debt[input.dataset.field] = ["balance", "annualRate", "minimumPayment"].includes(input.dataset.field) ? Number(input.value) : input.value; }));
  $$(".remove-debt").forEach((button) => button.addEventListener("click", () => { state.debts.splice(Number(button.dataset.index), 1); renderDebts(); }));
}
function addTransaction() { state.transactions.push({ date: "", concept: "", amount: 0, currency: $("#financial-currency").value }); renderTransactions(); }
function addCurrentDebt() {
  const balance = parseAmount($("#financial-balance").value); const annualRate = Number($("#financial-rate").value); const minimumPayment = Number($("#financial-minimum").value || parseAmount($("#financial-payment").value));
  if (!(balance > 0) || !(annualRate >= 0)) { $("#debt-strategy-result").textContent = "Complete un saldo y una tasa válidos en los campos del resumen."; return; }
  state.debts.push({ name: $("#financial-concept").value.trim() || `Deuda ${state.debts.length + 1}`, balance, annualRate, minimumPayment: parseAmount(minimumPayment), currency: $("#financial-currency").value }); renderDebts();
}
function addEmptyDebt() { state.debts.push({ name: `Deuda ${state.debts.length + 1}`, balance: 0, annualRate: 0, minimumPayment: 0, currency: $("#financial-currency").value }); renderDebts(); }
function importTransactions() {
  const lines = $("#manual-transactions").value.split(/\r?\n/).filter((line) => line.trim()); const rows = [];
  for (const line of lines) { const [dateRaw, concept, amountRaw, currencyRaw] = line.split(","); const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw?.trim()) ? dateRaw.trim() : normalizeDate(dateRaw?.trim() || ""); const amount = parseAmount(amountRaw); const currency = ["USD", "CRC"].includes(currencyRaw?.trim().toUpperCase()) ? currencyRaw.trim().toUpperCase() : $("#financial-currency").value; if (date && concept?.trim() && amount > 0) rows.push({ date, concept: concept.trim(), amount, currency }); }
  state.transactions.push(...rows); renderTransactions(); $("#privacy-status").textContent = `${rows.length} fila(s) cargadas. Revísalas en la tabla editable.`;
}
function saveAnonymizedSummary() {
  if (!$("#consent").checked) return;
  if (!updateExtractionReview()) { $("#privacy-status").textContent = "Resuelva manualmente los campos ambiguos antes de guardar."; return; }
  try {
    const rawDate = $("#financial-date").value;
    const date = rawDate ? normalizeFinancialDate(rawDate) : null;
    if (rawDate && !date) throw new Error("La fecha no es válida.");
    const optionalAmount = (id) => {
      const value = $(`#${id}`).value.trim();
      if (!value) return null;
      const parsed = parseFinancialNumber(value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Revise el campo ${id.replace("financial-", "").replace("-", " ")}.`);
      return parsed;
    };
    const rawRate = $("#financial-rate").value.trim();
    const annualRate = rawRate ? Number(rawRate) : null;
    if (annualRate !== null && (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100)) throw new Error("La tasa debe estar entre 0% y 100%.");
    const transactions = state.transactions.map((row) => {
      const amount = Number(row.amount);
      const transactionDate = normalizeFinancialDate(row.date);
      if (!transactionDate || !row.concept.trim() || !Number.isFinite(amount) || amount <= 0) throw new Error("Complete fecha, comercio y monto válido en cada consumo.");
      return { ...row, date: transactionDate, amount };
    });
    const amount = optionalAmount("financial-amount"); const payment = optionalAmount("financial-payment");
    const balance = optionalAmount("financial-balance"); const minimumPayment = optionalAmount("financial-minimum");
    if (![amount, payment, balance, minimumPayment].some((value) => value !== null) && !transactions.length) throw new Error("No hay montos financieros válidos para guardar.");
    const summary = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), date, concept: $("#financial-concept").value.trim(), amount, payment, minimumPayment, balance, annualRate, currency: $("#financial-currency").value, transactions };
    const saved = JSON.parse(localStorage.getItem("anonymizedDebtSummaries") || "[]"); saved.push(summary); localStorage.setItem("anonymizedDebtSummaries", JSON.stringify(saved));
    $("#privacy-status").textContent = "Resumen financiero guardado en este dispositivo. No se envió al servidor.";
  } catch (error) { $("#privacy-status").textContent = error.message; }
}
async function compareDebtStrategies() {
  const budget = Number($("#debt-budget").value); const currency = $("#financial-currency").value;
  const debts = state.debts.filter((debt) => (debt.currency || currency) === currency);
  const resultBox = $("#debt-strategy-result");
  if (!debts.length) { resultBox.textContent = "Agrega al menos una deuda de la moneda seleccionada."; return; }
  if (debts.length !== state.debts.length) { resultBox.textContent = `La comparación usa ${currency}; separa deudas en colones y dólares para comparar cada grupo con su propio presupuesto.`; return; }
  try {
    const numericDebts = debts.map(({ balance, annualRate, minimumPayment }) => ({ balance, annualRate, minimumPayment }));
    const response = await fetch(`${API_BASE}/debt/strategies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthlyBudget: budget, debts: numericDebts }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "No se pudo calcular");
    resultBox.innerHTML = `<strong>Avalancha</strong>: ${result.avalanche.months} meses · ${formatMoney(result.avalanche.interestPaid, currency, 2)} de intereses<br><strong>Bola de nieve</strong>: ${result.snowball.months} meses · ${formatMoney(result.snowball.interestPaid, currency, 2)} de intereses`;
  } catch (error) { resultBox.textContent = error.message; }
}
function clearDocument(options = {}) {
  state.source?.close?.(); state.pdf?.destroy?.(); state.source = null; state.pdf = null; state.image?.close?.(); state.image = null; state.redactions = new Map(); state.flatDocument = null; state.sourceText = ""; state.transactions = [];
  state.extractionIssues = []; state.extractionMissing = []; state.rejectedTransactions = 0;
  $("#document-file").value = ""; $("#document-text").value = ""; $("#document-preview").textContent = "Sin contenido cargado. El original no se conserva."; $("#redaction-canvas").getContext("2d").clearRect(0, 0, $("#redaction-canvas").width, $("#redaction-canvas").height); $("#page-indicator").textContent = "Sin documento"; $("#prev-page").disabled = true; $("#next-page").disabled = true; $("#flatten-ocr").disabled = true; $("#undo-redaction").disabled = true; $("#consent").checked = false; $("#save-anonymized").disabled = true; renderTransactions();
  ["financial-date", "financial-concept", "financial-amount", "financial-payment", "financial-balance", "financial-rate", "financial-minimum"].forEach((id) => { $(`#${id}`).value = ""; });
  updateExtractionReview();
  if (!options.keepStatus) $("#privacy-status").textContent = "Archivo y campos temporales descartados.";
}

function bindEvents() {
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  ["#amount", "#term", "#spread", "#extra-payment", "#extra-start-month"].forEach((selector) => $(selector)?.addEventListener("input", updateCalculator));
  ["#rate-change-month", "#rate-change-value"].forEach((selector) => $(selector)?.addEventListener("input", updateCalculator));
  $("#rate").addEventListener("input", () => { if (!state.applyingRate) state.activeRateCode = null; updateCalculator(); });
  $("#extra-mode").addEventListener("change", updateCalculator); $("#rate-type").addEventListener("change", selectRateType); $("#currency").addEventListener("change", changeCurrency);
  $("#export-csv").addEventListener("click", exportSchedule); $("#save-scenario").addEventListener("click", saveScenario); $("#clear-scenarios").addEventListener("click", () => { localStorage.removeItem("financialScenarios"); loadScenarios(); $("#scenario-status").textContent = "Escenarios locales eliminados."; });
  $("#fx-amount").addEventListener("input", updateFxResult); $("#fx-direction").addEventListener("change", updateFxResult); $("#use-fx-rate").addEventListener("click", useFxRate);
  $$("[data-currency-filter]").forEach((button) => button.addEventListener("click", () => { state.rateFilter = button.dataset.currencyFilter; $$("[data-currency-filter]").forEach((item) => item.classList.toggle("active", item === button)); renderRates(); }));
  $$("[data-entry]").forEach((button) => button.addEventListener("click", () => { $$("[data-entry]").forEach((item) => item.classList.toggle("active", item === button)); $("#document-entry").hidden = button.dataset.entry !== "document"; $("#manual-entry").hidden = button.dataset.entry !== "manual"; $("#scan-actions").hidden = button.dataset.entry !== "document"; if (button.dataset.entry === "manual" && state.source) clearDocument(); }));
  $("#document-file").addEventListener("change", (event) => { if (event.target.files[0]) readDocumentFile(event.target.files[0]); });
  $("#redaction-canvas").addEventListener("pointerdown", beginRedaction); $("#redaction-canvas").addEventListener("pointerup", finishRedaction);
  $("#undo-redaction").addEventListener("click", undoRedaction); $("#flatten-ocr").addEventListener("click", flattenAndExtract); $("#prev-page").addEventListener("click", () => { if (state.page > 1) { state.page -= 1; renderDocumentPage(); } }); $("#next-page").addEventListener("click", () => { if (state.page < state.pageCount) { state.page += 1; renderDocumentPage(); } });
  $("#scan-document").addEventListener("click", () => { extractFinancialData($("#document-text").value); $("#privacy-status").textContent = "Texto analizado localmente. Revise el resumen y las filas extraídas."; });
  $("#clear-document").addEventListener("click", () => clearDocument()); $("#save-anonymized").addEventListener("click", saveAnonymizedSummary); $("#consent").addEventListener("change", updateExtractionReview);
  ["#financial-date", "#financial-amount", "#financial-payment", "#financial-balance", "#financial-rate", "#financial-minimum"].forEach((selector) => $(selector).addEventListener("input", updateExtractionReview));
  $("#add-transaction").addEventListener("click", addTransaction); $("#import-transactions").addEventListener("click", importTransactions); $("#add-debt").addEventListener("click", addCurrentDebt); $("#add-empty-debt").addEventListener("click", addEmptyDebt); $("#compare-debt-strategies").addEventListener("click", compareDebtStrategies);
  window.addEventListener("resize", () => requestAnimationFrame(drawChart));
}

$("#cutoff-date").value = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
bindEvents(); loadScenarios(); loadRates(); renderTransactions(); renderDebts(); updateCalculator();
