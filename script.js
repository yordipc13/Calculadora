import { calculateLoan } from "./worker/src/loan.js";
import { detectPersonalData, extractFinancialData as parseDocumentFields, getSummaryCoverage, normalizeFinancialDate, parseFinancialNumber, projectAnonymizedSummary } from "./document-extraction.mjs";
import { resolveScenarioRate } from "./scenario-history.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API_BASE = document.querySelector('meta[name="api-base"]')?.content.replace(/\/$/, "") || "/api";
const LOCAL_DATA_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const LOCAL_FINANCIAL_KEYS = ["financialScenarios", "anonymizedDebtSummaries"];
const state = {
  schedule: [], rates: [], rateFilter: "ALL", ratesError: null, source: null, pdf: null, image: null,
  page: 1, pageCount: 1, redactions: new Map(), pointerStart: null, flatDocument: null,
  transactions: [], debts: [], calculationSequence: 0, activeRateCode: null, applyingRate: false,
  extractionIssues: [], extractionMissing: [], rejectedTransactions: 0,
  chartPoints: [], chartPlot: null, selectedChartPoint: null,
};

function formatMoney(value, currency = $("#currency")?.value || "CRC", digits = 0) {
  return new Intl.NumberFormat("es-CR", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number.isFinite(Number(value)) ? Number(value) : 0);
}
function escapeHtml(value) { const node = document.createElement("span"); node.textContent = String(value ?? ""); return node.innerHTML; }
function parseAmount(value) {
  return parseFinancialNumber(value) ?? 0;
}

function setPrivacyStep(step, scroll = false) {
  $(".privacy-steps [data-step]") && $$(".privacy-steps [data-step]").forEach((item) => {
    const number = Number(item.dataset.step);
    item.classList.toggle("current", number === step);
    item.classList.toggle("complete", number < step);
    if (number === step) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
  });
  if (scroll) {
    const heading = step === 3 ? $("#debt-heading") : step === 2 ? $("#review-heading") : $("#privacy-entry-heading");
    heading?.closest(".privacy-step")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function currentSummaryCoverage() {
  return getSummaryCoverage({
    type: $("#document-type").value,
    date: $("#financial-date").value,
    amount: parseAmount($("#financial-amount").value),
    payment: parseAmount($("#financial-payment").value),
    balance: parseAmount($("#financial-balance").value),
    annualRate: $("#financial-rate").value.trim() ? Number($("#financial-rate").value) : null,
    minimumPayment: parseAmount($("#financial-minimum").value),
    transactions: state.transactions,
  });
}

function currentPersonalDataWarnings() {
  const warnings = [];
  const conceptMatches = detectPersonalData($("#financial-concept").value);
  if (conceptMatches.length) warnings.push(`concepto principal (${conceptMatches.join(", ")})`);
  state.transactions.forEach((transaction, index) => {
    const matches = detectPersonalData(transaction.concept);
    if (matches.length) warnings.push(`comercio de consumo ${index + 1} (${matches.join(", ")})`);
  });
  return warnings;
}

function pruneExpiredLocalFinancialData() {
  const expiration = Date.now() - LOCAL_DATA_RETENTION_MS;
  for (const key of LOCAL_FINANCIAL_KEYS) {
    try {
      const records = JSON.parse(localStorage.getItem(key) || "[]");
      if (!Array.isArray(records)) continue;
      const retained = records.filter((record) => {
        const createdAt = Date.parse(record?.createdAt);
        return !Number.isFinite(createdAt) || createdAt >= expiration;
      });
      if (retained.length !== records.length) localStorage.setItem(key, JSON.stringify(retained));
    } catch { /* Leave unreadable local data untouched. */ }
  }
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
  $("#spread-label").classList.toggle("rate-spread-muted", rateType === "fixed");
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
function buildChartPoints() {
  const principal = Number($("#amount").value) || 0;
  let accumulatedInterest = 0;
  return [
    { month: 0, balance: principal, capitalPaid: 0, accumulatedInterest: 0, payment: 0 },
    ...state.schedule.map((row) => {
      accumulatedInterest += Number(row.interest) || 0;
      return {
        month: Number(row.month), balance: Number(row.balance) || 0,
        capitalPaid: principal - (Number(row.balance) || 0),
        accumulatedInterest, payment: Number(row.payment) || 0,
      };
    }),
  ];
}

function chartY(value, maxValue, plot) {
  return plot.top + plot.height - (value / maxValue) * plot.height;
}

function drawChart() {
  const canvas = $("#balance-chart");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * scale);
  canvas.height = Math.round(rect.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  state.chartPoints = buildChartPoints();
  const pad = { left: 96, right: 16, top: 16, bottom: 40 };
  const plot = { left: pad.left, top: pad.top, width: rect.width - pad.left - pad.right, height: rect.height - pad.top - pad.bottom };
  if (!state.chartPoints.length || plot.width <= 0 || plot.height <= 0) return;
  const maxValue = Math.max(1, ...state.chartPoints.map((point) => Math.max(point.balance, point.accumulatedInterest)));
  state.chartPlot = { ...plot, maxValue, width: rect.width, height: rect.height };
  const xForIndex = (index) => plot.left + plot.width * index / Math.max(1, state.chartPoints.length - 1);
  ctx.font = "12px system-ui, sans-serif";
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#E2E6E3";
  ctx.fillStyle = "#5A655F";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = maxValue * (4 - tick) / 4;
    const y = plot.top + plot.height * tick / 4;
    ctx.beginPath(); ctx.moveTo(plot.left, y); ctx.lineTo(plot.left + plot.width, y); ctx.stroke();
    ctx.fillText(formatMoney(value, $("#currency").value), plot.left - 8, y);
  }
  const drawSeries = (key, color) => {
    ctx.beginPath();
    state.chartPoints.forEach((point, index) => {
      const x = xForIndex(index); const y = chartY(point[key], maxValue, plot);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
  };
  drawSeries("balance", "#0F3D2E");
  drawSeries("accumulatedInterest", "#2B6CB0");
  ctx.fillStyle = "#5A655F"; ctx.textBaseline = "top";
  const lastMonth = state.chartPoints.at(-1)?.month || 0;
  const ticks = [...new Set([0, Math.round(lastMonth / 4), Math.round(lastMonth / 2), Math.round(lastMonth * 3 / 4), lastMonth])];
  ticks.forEach((month) => {
    const index = state.chartPoints.findIndex((point) => point.month === month);
    const x = xForIndex(Math.max(0, index));
    ctx.textAlign = month === 0 ? "left" : month === lastMonth ? "right" : "center";
    ctx.fillText(month === 0 ? "Inicio" : `Mes ${month}`, x, plot.top + plot.height + 12);
  });
  if (state.selectedChartPoint !== null) drawChartFocus(state.selectedChartPoint);
}

function drawChartFocus(index) {
  const canvas = $("#balance-chart"); const plot = state.chartPlot; const point = state.chartPoints[index];
  if (!canvas || !plot || !point) return;
  const ctx = canvas.getContext("2d"); const scale = window.devicePixelRatio || 1;
  const x = plot.left + plot.width * index / Math.max(1, state.chartPoints.length - 1);
  ctx.save(); ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.strokeStyle = "#5A655F"; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x, plot.top); ctx.lineTo(x, plot.top + plot.height); ctx.stroke(); ctx.restore();
  showChartTooltip(index, x, plot.top + 8);
}

function showChartTooltip(index, x, y) {
  const tooltip = $("#chart-tooltip"); const point = state.chartPoints[index]; const wrap = $(".chart-wrap");
  if (!tooltip || !point || !wrap) return;
  tooltip.innerHTML = `<strong>${point.month === 0 ? "Inicio del préstamo" : `Mes ${point.month}`}</strong><span><span>Saldo pendiente</span><b>${formatMoney(point.balance, $("#currency").value)}</b></span><span><span>Capital amortizado</span><b>${formatMoney(point.capitalPaid, $("#currency").value)}</b></span><span><span>Intereses acumulados</span><b>${formatMoney(point.accumulatedInterest, $("#currency").value)}</b></span>`;
  tooltip.hidden = false;
  const maxLeft = Math.max(8, wrap.clientWidth - tooltip.offsetWidth - 8);
  const left = Math.max(8, Math.min(maxLeft, x + 12));
  const maxTop = Math.max(8, wrap.clientHeight - tooltip.offsetHeight - 8);
  const top = Math.max(8, Math.min(maxTop, y));
  tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`;
  state.selectedChartPoint = index;
}

function selectChartPointFromPointer(event) {
  const canvas = $("#balance-chart"); const plot = state.chartPlot;
  if (!canvas || !plot || !state.chartPoints.length) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const ratio = Math.max(0, Math.min(1, (x - plot.left) / plot.width));
  state.selectedChartPoint = Math.round(ratio * (state.chartPoints.length - 1));
  drawChart();
}

function hideChartTooltip() {
  if (document.activeElement === $("#balance-chart")) return;
  $("#chart-tooltip").hidden = true;
  state.selectedChartPoint = null;
}

let activeHelpButton = null;
let pinnedHelp = false;

function closeHelp() {
  if (activeHelpButton) {
    activeHelpButton.setAttribute("aria-expanded", "false");
    activeHelpButton.removeAttribute("aria-describedby");
  }
  activeHelpButton = null;
  pinnedHelp = false;
  const popover = $("#help-popover");
  if (popover) popover.hidden = true;
}

function openHelp(button, pin = false) {
  const popover = $("#help-popover");
  if (!popover || !button?.dataset.help) return;
  if (activeHelpButton && activeHelpButton !== button) activeHelpButton.setAttribute("aria-expanded", "false");
  activeHelpButton = button;
  pinnedHelp = pin;
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-describedby", "help-popover");
  popover.textContent = button.dataset.help;
  popover.hidden = false;
  const rect = button.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const gap = 8;
  let left = rect.right + gap;
  let top = rect.top;
  if (left + width > window.innerWidth - 16) left = rect.left - width - gap;
  if (left < 16) {
    left = Math.max(16, Math.min(window.innerWidth - width - 16, rect.left - width / 2));
    top = rect.top - height - gap;
    if (top < 16) top = Math.min(window.innerHeight - height - 16, rect.bottom + gap);
  }
  top = Math.max(16, Math.min(window.innerHeight - height - 16, top));
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function bindHelpEvents() {
  document.addEventListener("pointerover", (event) => {
    if (event.pointerType !== "mouse") return;
    const button = event.target.closest?.(".help-trigger[data-help]");
    if (button && !pinnedHelp) openHelp(button);
  });
  document.addEventListener("pointerout", (event) => {
    const button = event.target.closest?.(".help-trigger[data-help]");
    if (!button || event.pointerType !== "mouse" || button.contains(event.relatedTarget)) return;
    window.setTimeout(() => {
      if (activeHelpButton === button && !pinnedHelp && document.activeElement !== button) closeHelp();
    }, 80);
  });
  document.addEventListener("focusin", (event) => {
    const button = event.target.closest?.(".help-trigger[data-help]");
    if (button) openHelp(button);
    else if (!pinnedHelp) closeHelp();
  });
  document.addEventListener("focusout", (event) => {
    const button = event.target.closest?.(".help-trigger[data-help]");
    if (!button) return;
    window.setTimeout(() => {
      if (activeHelpButton === button && !pinnedHelp && document.activeElement !== button) closeHelp();
    }, 0);
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.(".help-trigger[data-help]");
    if (button) {
      if (activeHelpButton === button && pinnedHelp) closeHelp();
      else openHelp(button, true);
    } else if (!event.target.closest?.("#help-popover")) closeHelp();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activeHelpButton) {
      const button = activeHelpButton;
      closeHelp();
      button.focus();
    }
  });
  window.addEventListener("resize", closeHelp);
  window.addEventListener("scroll", closeHelp, true);
}

function bindChartEvents() {
  const canvas = $("#balance-chart");
  canvas.addEventListener("pointermove", selectChartPointFromPointer);
  canvas.addEventListener("pointerdown", selectChartPointFromPointer);
  canvas.addEventListener("pointerleave", hideChartTooltip);
  canvas.addEventListener("focus", () => {
    if (state.selectedChartPoint === null) state.selectedChartPoint = 0;
    drawChart();
  });
  canvas.addEventListener("blur", () => window.setTimeout(hideChartTooltip, 0));
  canvas.addEventListener("keydown", (event) => {
    if (!state.chartPoints.length) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = state.selectedChartPoint ?? 0;
    const last = state.chartPoints.length - 1;
    const next = event.key === "Home" ? 0 : event.key === "End" ? last : Math.max(0, Math.min(last, current + (event.key === "ArrowRight" ? 1 : -1)));
    state.selectedChartPoint = next;
    drawChart();
  });
}

function switchView(name) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `${name}-view`));
  $$(".tab").forEach((tab) => {
    const selected = tab.dataset.view === name;
    tab.classList.toggle("active", selected);
    if (selected) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
  });
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
  return `<div class="scenario-comparison"><strong>Recálculo al ${escapeHtml(last.cutoffDate)} <span class="help-wrap"><button class="help-trigger" type="button" data-help="Compara la cuota, intereses y total del recálculo con el escenario original guardado." aria-label="Ayuda: comparación del escenario" aria-expanded="false">?</button></span></strong><span>${escapeHtml(last.rateDescription)}</span><span>Δ cuota ${formatDifference(last.result.regularPayment - Number(original.payment || 0), scenario.currency)} · Δ intereses ${formatDifference(last.result.totalInterest - Number(original.totalInterest || 0), scenario.currency)} · Δ total ${formatDifference(last.result.totalPaid - Number(original.totalPaid || 0), scenario.currency)}</span></div>`;
}
function loadScenarios() {
  const scenarios = JSON.parse(localStorage.getItem("financialScenarios") || "[]"); const container = $("#scenario-list"); if (!container) return;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  container.innerHTML = scenarios.length ? scenarios.slice().reverse().map((s) => {
    const savedRate = s.rateSnapshot?.source === "BCCR SDDE" && s.rateSnapshot.referenceDate
      ? `${escapeHtml(s.rateSnapshot.benchmark || "BCCR")} ${Number(s.rateSnapshot.referenceValue).toFixed(2)}% del ${escapeHtml(s.rateSnapshot.referenceDate)}`
      : `${s.rateType === "fixed" ? "Tasa fija" : "Base manual"} ${Number(s.annualRate || 0).toFixed(2)}%${s.spread ? ` + ${Number(s.spread).toFixed(2)}% spread` : ""}`;
    return `<article class="scenario-item" data-scenario-id="${escapeHtml(s.id)}"><div class="scenario-summary"><strong>${escapeHtml(s.currency)} · ${formatMoney(s.principal, s.currency)}</strong><span>${Number(s.snapshot?.effectiveRate ?? (Number(s.annualRate || 0) + Number(s.spread || 0))).toFixed(2)}% anual · ${s.months} meses <span class="help-wrap"><button class="help-trigger" type="button" data-help="Resumen de las condiciones con las que se guardó este escenario: moneda, monto, tasa efectiva y plazo." aria-label="Ayuda: escenario guardado" aria-expanded="false">?</button></span></span><span>${savedRate} · corte ${escapeHtml(s.cutoffDate || "sin fecha")}</span></div><div class="scenario-actions"><label class="field"><span class="field-label">Fecha de recálculo <span class="help-wrap"><button class="help-trigger" type="button" data-help="Elige la fecha cuyos datos de tasa se usarán para recalcular el escenario." aria-label="Ayuda: fecha de recálculo" aria-expanded="false">?</button></span></span><input type="date" data-scenario-date value="${escapeHtml(s.cutoffDate || "")}" max="${today}" /></label><button class="secondary recalculate-scenario" data-id="${escapeHtml(s.id)}" type="button">Recalcular</button><button class="secondary restore-scenario" data-id="${escapeHtml(s.id)}" type="button">Restaurar</button></div>${scenarioComparisonMarkup(s)}<p class="scenario-status" role="status"></p></article>`;
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
    const rateDescription = rate.source === "BCCR SDDE"
      ? `${rate.benchmark} ${rate.baseRate.toFixed(2)}% + ${rate.spread.toFixed(2)}% spread = ${rate.annualRate.toFixed(2)}% anual · dato BCCR ${rate.referenceDate}`
      : rate.source === "Manual"
        ? `Tasa base manual ${rate.baseRate.toFixed(2)}% + ${rate.spread.toFixed(2)}% spread = ${rate.annualRate.toFixed(2)}% anual`
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
function clearLocalFinancialData() {
  const confirmed = window.confirm("Se eliminarán los escenarios y resúmenes guardados, el documento cargado y los valores del simulador en este navegador. Las tasas públicas se conservarán.");
  if (!confirmed) return;
  localStorage.removeItem("financialScenarios");
  localStorage.removeItem("anonymizedDebtSummaries");
  state.debts = [];
  $("#financial-currency").value = "CRC";
  clearDocument({ keepStatus: true });
  renderDebts();
  $("#manual-transactions").value = "";
  $("#debt-budget").value = "100000";
  $("#debt-strategy-result").textContent = "";
  $("#currency").value = "CRC";
  $("#rate-type").value = "fixed";
  $("#amount").value = "3000000";
  $("#rate").value = "16";
  $("#spread").value = "0";
  $("#term").value = "36";
  $("#rate-change-month").value = "0";
  $("#rate-change-value").value = "16";
  $("#extra-payment").value = "0";
  $("#extra-mode").value = "reduceTerm";
  $("#extra-start-month").value = "1";
  $("#cutoff-date").value = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  state.activeRateCode = null;
  updateCalculator();
  loadScenarios();
  $$(".local-data-status").forEach((status) => { status.textContent = "Se borraron los datos financieros de este navegador. La caché pública del BCCR se conservó."; });
  $("#privacy-status").textContent = "Datos financieros locales eliminados. No se envió información al servidor.";
}

const rateByCode = (code) => state.rates.find((rate) => String(rate.code) === String(code));
function dateKeyInCostaRica(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}
function formatBccrDate(value, withTime = false) {
  if (!value) return "Sin fecha";
  const dateText = String(value).slice(0, 10);
  const date = new Date(`${dateText}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("es-CR", { dateStyle: "short", ...(withTime ? { timeStyle: "short" } : {}), timeZone: "America/Costa_Rica" }).format(withTime ? new Date(value) : date);
}
function rateCurrencyLabel(rate) {
  return rate.unit === "CRC" ? "CRC por USD" : rate.currency === "USD" ? "USD ($)" : "CRC (₡)";
}
function rateNumber(rate, value = rate.value) {
  const number = Number(value);
  return rate.unit === "percent"
    ? `${new Intl.NumberFormat("es-CR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number)}%`
    : formatMoney(number, "CRC", 2);
}
function rateValueLabel(rate, value = rate.value) {
  return rate.unit === "percent" ? `${rateNumber(rate, value)} anual` : rateNumber(rate, value);
}
function rateVariation(rate) {
  const previous = rate.previous_value;
  if (previous === null || previous === undefined || !Number.isFinite(Number(previous))) return { text: "Sin variación anterior guardada", direction: "same" };
  const difference = Number(rate.value) - Number(previous);
  if (difference === 0) return { text: "Sin cambios", direction: "same" };
  const absolute = Math.abs(difference);
  const amount = rate.unit === "percent"
    ? `${new Intl.NumberFormat("es-CR", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(absolute)} pp`
    : formatMoney(absolute, "CRC", 2);
  return { text: `${difference > 0 ? "↑ +" : "↓ −"}${amount}`, direction: difference > 0 ? "up" : "down" };
}
function rateObservations(rate) {
  const byDate = new Map();
  [...(Array.isArray(rate.history) ? rate.history : []), rate].forEach((item) => {
    const date = String(item.reference_date || "").slice(0, 10);
    const value = Number(item.value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value)) byDate.set(date, { date, value });
  });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
function rateTrendMarkup(rate, days) {
  const today = dateKeyInCostaRica();
  const startDate = new Date(`${today}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  const start = startDate.toISOString().slice(0, 10);
  const points = rateObservations(rate).filter((point) => point.date >= start && point.date <= today);
  const controls = `<div class="trend-range" role="group" aria-label="Periodo de tendencia"><button class="secondary trend-range-button ${days === 7 ? "active" : ""}" type="button" data-code="${escapeHtml(rate.code)}" data-days="7" aria-pressed="${days === 7}">7 días</button><button class="secondary trend-range-button ${days === 30 ? "active" : ""}" type="button" data-code="${escapeHtml(rate.code)}" data-days="30" aria-pressed="${days === 30}">30 días</button></div>`;
  if (!points.length) return `${controls}<p class="no-trend-state">No hay cambios registrados en los últimos ${days} días. El último valor oficial disponible es ${escapeHtml(rateValueLabel(rate))}, del ${escapeHtml(formatBccrDate(rate.reference_date))}.</p>`;
  const width = 600; const height = 208; const pad = { left: 88, right: 16, top: 16, bottom: 40 };
  const plotWidth = width - pad.left - pad.right; const plotHeight = height - pad.top - pad.bottom;
  const startTime = Date.parse(`${start}T00:00:00Z`); const endTime = Date.parse(`${today}T23:59:59Z`); const maxValue = Math.max(1, ...points.map((point) => point.value)) * 1.08;
  const x = (point) => pad.left + plotWidth * Math.max(0, Math.min(1, (Date.parse(`${point.date}T12:00:00Z`) - startTime) / (endTime - startTime)));
  const y = (value) => pad.top + plotHeight - (value / maxValue) * plotHeight;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = maxValue * (4 - index) / 4; const yPos = pad.top + plotHeight * index / 4;
    return `<g><line class="trend-grid-line" x1="${pad.left}" y1="${yPos}" x2="${width - pad.right}" y2="${yPos}" /><text class="trend-axis-label" x="${pad.left - 8}" y="${yPos + 4}" text-anchor="end">${escapeHtml(rateNumber(rate, value))}</text></g>`;
  }).join("");
  const path = points.slice(1).reduce((d, point, index) => `${d} H ${x(point)} V ${y(point.value)}`, points.length ? `M ${x(points[0])} ${y(points[0].value)}` : "");
  const circles = points.map((point) => `<circle class="trend-point" cx="${x(point)}" cy="${y(point.value)}" r="6" tabindex="0" role="img" data-rate-point data-date="${escapeHtml(point.date)}" data-value="${point.value}" aria-label="${escapeHtml(formatBccrDate(point.date))}: ${escapeHtml(rateValueLabel(rate, point.value))}"><title>${escapeHtml(formatBccrDate(point.date))}: ${escapeHtml(rateValueLabel(rate, point.value))}</title></circle>`).join("");
  const chart = `<svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(rate.short_name)}: ${points.length} observación(es) oficiales en ${days} días">${grid}${points.length > 1 ? `<path class="trend-line" d="${path}" />` : ""}${circles}<text class="trend-axis-label" x="${pad.left}" y="${height - 8}" text-anchor="start">${escapeHtml(formatBccrDate(start))}</text><text class="trend-axis-label" x="${width - pad.right}" y="${height - 8}" text-anchor="end">${escapeHtml(formatBccrDate(today))}</text></svg>`;
  const note = points.length === 1 ? "Hay una observación oficial en este periodo; se mostrará la trayectoria cuando exista otro cambio." : "La línea escalonada conecta observaciones oficiales en sus fechas de publicación.";
  return `${controls}<div class="trend-chart-wrap">${chart}</div><p class="trend-detail" role="status" aria-live="polite">${note}</p>`;
}
function bindRateTrend(content, rate) {
  $$(".trend-range-button", content).forEach((button) => button.addEventListener("click", () => {
    content.innerHTML = rateTrendMarkup(rate, Number(button.dataset.days));
    bindRateTrend(content, rate);
  }));
  const showPoint = (point) => {
    const detail = $(".trend-detail", content);
    if (detail) detail.textContent = `${formatBccrDate(point.dataset.date)} · ${rateValueLabel(rate, Number(point.dataset.value))}`;
  };
  $$('[data-rate-point]', content).forEach((point) => {
    point.addEventListener("pointerenter", () => showPoint(point));
    point.addEventListener("pointerdown", () => showPoint(point));
    point.addEventListener("focus", () => showPoint(point));
  });
}
function renderRateCard(rate) {
  const current = Number(rate.value);
  const change = rateVariation(rate);
  const explanation = rate.description || "Indicador financiero oficial publicado por el BCCR.";
  return `<article class="rate-card" data-rate-card="${escapeHtml(rate.code)}"><div class="rate-card-head"><span class="rate-code">${escapeHtml(rate.short_name || rate.name)}</span><span class="rate-currency">${escapeHtml(rateCurrencyLabel(rate))}</span></div><h2>${escapeHtml(rate.name)} <span class="help-wrap"><button class="help-trigger" type="button" data-help="${escapeHtml(`${rate.name} (${rate.short_name || rate.code}) es un indicador oficial del BCCR. ${explanation}`)}" aria-label="Ayuda: ${escapeHtml(rate.short_name || rate.name)}" aria-expanded="false">?</button></span></h2><div class="rate-value-row"><div class="rate-value-line"><strong class="rate-value">${escapeHtml(rateValueLabel(rate, current))}</strong><span class="help-wrap"><button class="help-trigger" type="button" data-help="Valor vigente publicado por el BCCR para este indicador. La unidad y moneda aparecen en la tarjeta." aria-label="Ayuda: valor vigente" aria-expanded="false">?</button></span></div><p class="rate-change ${change.direction}"><span>${escapeHtml(change.text)}</span> <span class="help-wrap"><button class="help-trigger" type="button" data-help="Variación frente al valor anterior diferente que está guardado. Los valores repetidos no generan filas duplicadas." aria-label="Ayuda: variación reciente" aria-expanded="false">?</button></span></p></div><dl class="rate-meta"><div><dt>Fecha oficial <span class="help-wrap"><button class="help-trigger" type="button" data-help="Día al que corresponde el valor publicado por el BCCR." aria-label="Ayuda: fecha oficial del dato" aria-expanded="false">?</button></span></dt><dd>${escapeHtml(formatBccrDate(rate.reference_date))}</dd></div><div><dt>Última verificación <span class="help-wrap"><button class="help-trigger" type="button" data-help="Momento en que el Worker consultó el servicio del BCCR por última vez." aria-label="Ayuda: última verificación" aria-expanded="false">?</button></span></dt><dd>${escapeHtml(rate.last_verification ? formatBccrDate(rate.last_verification, true) : "Sin verificación")}</dd></div></dl><p class="rate-description">${escapeHtml(explanation)}</p><div class="rate-card-actions"><button class="primary use-rate" data-code="${escapeHtml(rate.code)}" type="button">${rate.unit === "percent" ? "Usar en calculadora" : "Usar tipo de cambio"}</button><button class="secondary toggle-trend" type="button" aria-expanded="false">Ver tendencia</button></div><div class="trend-content" hidden>${rateTrendMarkup(rate, 30)}</div></article>`;
}
function renderRates() {
  const grid = $("#rates-grid");
  const visible = state.rates.filter((rate) => state.rateFilter === "ALL" || rate.currency === state.rateFilter);
  grid.setAttribute("aria-busy", "false");
  if (visible.length) grid.innerHTML = visible.map(renderRateCard).join("");
  else if (state.rates.length) grid.innerHTML = '<article class="empty-state rates-empty"><strong>No hay indicadores para este filtro.</strong><p>Prueba con otra moneda para ver las tasas disponibles.</p></article>';
  else if (state.ratesError) grid.innerHTML = `<article class="empty-state rates-empty"><strong>No fue posible cargar los datos del BCCR.</strong><p>${escapeHtml(state.ratesError)}. Puedes volver a consultar el servicio.</p><button class="secondary retry-rates" type="button">Consultar de nuevo</button></article>`;
  else grid.innerHTML = '<article class="empty-state rates-empty"><strong>Aún no hay tasas disponibles.</strong><p>Cuando el Worker complete su primera consulta, los indicadores aparecerán aquí.</p><button class="secondary retry-rates" type="button">Consultar de nuevo</button></article>';
  $$(".use-rate").forEach((button) => button.addEventListener("click", () => useRate(button.dataset.code)));
  $$(".toggle-trend").forEach((button) => button.addEventListener("click", () => {
    const content = button.closest(".rate-card").querySelector(".trend-content");
    content.hidden = !content.hidden;
    button.setAttribute("aria-expanded", String(!content.hidden));
    button.textContent = content.hidden ? "Ver tendencia" : "Ocultar tendencia";
  }));
  $$(".rate-card").forEach((card) => {
    const rate = rateByCode(card.dataset.rateCard);
    if (rate) bindRateTrend($(".trend-content", card), rate);
  });
  $$(".retry-rates").forEach((button) => button.addEventListener("click", loadRates));
}
async function loadRates() {
  const badge = $("#rates-service-status"); const grid = $("#rates-grid");
  grid.setAttribute("aria-busy", "true");
  grid.innerHTML = '<p class="loading-state">Consultando las tasas del BCCR…</p>';
  badge.textContent = "Consultando el servicio del BCCR…";
  badge.classList.remove("stale", "error");
  let stale = false; let payload = null;
  try {
    const response = await fetch(`${API_BASE}/rates`, { headers: { Accept: "application/json" } });
    payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Worker HTTP ${response.status}`);
    state.rates = Array.isArray(payload.rates) ? payload.rates : [];
    state.ratesError = payload.error || null;
    try { localStorage.setItem("bccrRatesPublicCache", JSON.stringify({ rates: state.rates, checkedAt: payload.checkedAt })); } catch { /* Public cache is optional. */ }
  } catch (error) {
    stale = true; state.ratesError = error.message || "No se pudo conectar con el Worker.";
    try { const cached = JSON.parse(localStorage.getItem("bccrRatesPublicCache") || "null"); state.rates = cached?.rates || []; } catch { state.rates = []; }
  }
  const hasError = stale || payload?.serviceStatus === "partial" || state.rates.some((rate) => rate.service_status === "error");
  const verification = state.rates.map((rate) => rate.last_verification).filter(Boolean).sort().at(-1);
  const today = dateKeyInCostaRica();
  const checkedToday = verification && dateKeyInCostaRica(new Date(verification)) === today;
  const latestReference = state.rates.map((rate) => rate.reference_date).filter(Boolean).sort().at(-1);
  if (!state.rates.length) badge.textContent = state.ratesError ? "Sin conexión o datos BCCR disponibles" : "A la espera de la primera sincronización";
  else if (hasError) badge.textContent = `Mostrando último dato válido${latestReference ? ` · dato BCCR del ${formatBccrDate(latestReference)}` : ""}`;
  else if (checkedToday) badge.textContent = "Actualizado hoy · BCCR";
  else badge.textContent = verification ? `Verificado ${formatBccrDate(verification, true)}` : "Sin fecha de verificación";
  badge.classList.toggle("stale", hasError);
  badge.classList.toggle("error", !state.rates.length && Boolean(state.ratesError));
  renderRates(); updateFxResult();
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
    $(".fx-disclosure").open = true;
    $("#fx-direction").value = String(code) === "317" ? "USD_CRC" : "CRC_USD";
    updateFxResult(); $(".fx-disclosure").scrollIntoView({ behavior: "smooth", block: "center" }); $("#fx-amount").focus();
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
  canvas.hidden = false;
  if (state.pdf) {
    const page = await state.pdf.getPage(state.page); const viewport = page.getViewport({ scale: Math.min(1.6, 1100 / page.getViewport({ scale: 1 }).width) });
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); await page.render({ canvasContext: ctx, viewport }).promise;
  } else if (state.image) {
    const image = state.image; const scale = Math.min(1, 1200 / image.width); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  drawRedactions();
  $(".document-empty").hidden = Boolean(state.pdf || state.image);
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
    $("#redaction-canvas").getContext("2d").clearRect(0, 0, $("#redaction-canvas").width, $("#redaction-canvas").height); $("#redaction-canvas").hidden = true; $(".document-empty").hidden = false; $(".document-empty").textContent = "El archivo y la imagen aplanada se descartaron de la vista. Revisa el texto y los campos detectados en el paso 2."; $("#page-indicator").textContent = "Documento aplanado y descartado";
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
  if (state.extractionMissing.length) messages.push(`Campos opcionales no detectados: ${state.extractionMissing.join(", ")}.`);
  if (state.rejectedTransactions) messages.push(`${state.rejectedTransactions} fila(s) de consumo se descartaron por fecha o monto incompleto/inválido.`);
  const coverage = currentSummaryCoverage();
  const personalDataWarnings = currentPersonalDataWarnings();
  if (!coverage.hasFinancialData) messages.push("Para guardar, ingrese al menos un monto válido o un consumo completo.");
  else if (!coverage.complete) messages.push(`Resumen parcial: falta ${coverage.missingRequiredFields.join("; ")}. Puede guardarlo de todos modos.`);
  else messages.push("Se cumplen los campos mínimos para este tipo de documento.");
  if (personalDataWarnings.length) messages.push(`Posibles datos personales en ${personalDataWarnings.join("; ")}. Edite esos textos antes de guardar.`);
  if (!messages.length) messages.push("Revise los campos detectados y confirme antes de guardar.");
  const review = $("#extraction-review");
  review.textContent = messages.join(" ");
  review.classList.toggle("warning", state.extractionIssues.length > 0 || state.rejectedTransactions > 0 || !coverage.hasFinancialData || !coverage.complete || personalDataWarnings.length > 0);
  $("#save-anonymized").disabled = !$("#consent").checked || state.extractionIssues.length > 0 || !coverage.hasFinancialData || personalDataWarnings.length > 0;
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
  renderTransactions(); renderDebts(); updateExtractionReview(); setPrivacyStep(2, true);
}
function renderTransactions() {
  const empty = $("#transactions-empty");
  if (empty) empty.hidden = state.transactions.length > 0;
  $("#transactions-body").innerHTML = state.transactions.map((row, index) => `<tr><td><input type="date" aria-label="Fecha del consumo ${index + 1}" data-tx="${index}" data-field="date" value="${escapeHtml(row.date)}"></td><td><input type="text" maxlength="120" aria-label="Comercio o concepto del consumo ${index + 1}" data-tx="${index}" data-field="concept" value="${escapeHtml(row.concept)}"></td><td><input type="number" min="0" step="0.01" aria-label="Monto del consumo ${index + 1}" data-tx="${index}" data-field="amount" value="${Number(row.amount) || 0}"></td><td><select aria-label="Moneda del consumo ${index + 1}" data-tx="${index}" data-field="currency"><option value="CRC" ${row.currency === "CRC" ? "selected" : ""}>Colones (₡)</option><option value="USD" ${row.currency === "USD" ? "selected" : ""}>Dólares (US$)</option></select></td><td><button type="button" class="secondary remove-row remove-transaction" data-index="${index}" aria-label="Quitar consumo ${index + 1}">Quitar</button></td></tr>`).join("");
  $$('[data-tx]', $("#transactions-body")).forEach((input) => input.addEventListener("change", () => { const row = state.transactions[Number(input.dataset.tx)]; row[input.dataset.field] = input.dataset.field === "amount" ? Number(input.value) : input.value; updateExtractionReview(); }));
  $$(".remove-transaction").forEach((button) => button.addEventListener("click", () => { state.transactions.splice(Number(button.dataset.index), 1); renderTransactions(); updateExtractionReview(); }));
}
function renderDebts() {
  const empty = $("#debts-empty");
  if (empty) empty.hidden = state.debts.length > 0;
  $("#debts-body").innerHTML = state.debts.map((debt, index) => `<tr><td><input type="text" maxlength="100" aria-label="Nombre de la deuda ${index + 1}" data-debt="${index}" data-field="name" value="${escapeHtml(debt.name)}"></td><td><input type="number" min="0" step="0.01" aria-label="Saldo de la deuda ${index + 1}" data-debt="${index}" data-field="balance" value="${Number(debt.balance) || 0}"></td><td><input type="number" min="0" max="100" step="0.01" aria-label="Tasa anual de la deuda ${index + 1}" data-debt="${index}" data-field="annualRate" value="${Number(debt.annualRate) || 0}"></td><td><input type="number" min="0" step="0.01" aria-label="Pago mínimo de la deuda ${index + 1}" data-debt="${index}" data-field="minimumPayment" value="${Number(debt.minimumPayment) || 0}"></td><td><select aria-label="Moneda de la deuda ${index + 1}" data-debt="${index}" data-field="currency"><option value="CRC" ${debt.currency === "CRC" ? "selected" : ""}>Colones (₡)</option><option value="USD" ${debt.currency === "USD" ? "selected" : ""}>Dólares (US$)</option></select></td><td><button class="secondary remove-row remove-debt" data-index="${index}" type="button" aria-label="Quitar deuda ${index + 1}">Quitar</button></td></tr>`).join("");
  const resultBox = $("#debt-strategy-result");
  if (resultBox) { resultBox.classList.remove("error", "warning"); resultBox.innerHTML = '<p class="empty-state">Los resultados aparecen aquí después de comparar las estrategias.</p>'; }
  $$('[data-debt]', $("#debts-body")).forEach((input) => input.addEventListener("change", () => {
    const debt = state.debts[Number(input.dataset.debt)]; debt[input.dataset.field] = ["balance", "annualRate", "minimumPayment"].includes(input.dataset.field) ? Number(input.value) : input.value;
    if (resultBox) { resultBox.textContent = "La lista cambió. Vuelve a comparar para actualizar los resultados."; resultBox.classList.remove("error", "warning"); }
  }));
  $$(".remove-debt").forEach((button) => button.addEventListener("click", () => { state.debts.splice(Number(button.dataset.index), 1); renderDebts(); }));
}
function addTransaction() { state.transactions.push({ date: "", concept: "", amount: 0, currency: $("#financial-currency").value }); renderTransactions(); updateExtractionReview(); }
function addCurrentDebt() {
  const balance = parseAmount($("#financial-balance").value); const annualRate = Number($("#financial-rate").value); const minimumPayment = Number($("#financial-minimum").value || parseAmount($("#financial-payment").value));
  if (!(balance > 0) || !(annualRate >= 0)) { $("#debt-strategy-result").textContent = "Complete un saldo y una tasa válidos en los campos del resumen."; return; }
  state.debts.push({ name: $("#financial-concept").value.trim() || `Deuda ${state.debts.length + 1}`, balance, annualRate, minimumPayment: parseAmount(minimumPayment), currency: $("#financial-currency").value }); renderDebts(); setPrivacyStep(3, true);
}
function addEmptyDebt() { state.debts.push({ name: `Deuda ${state.debts.length + 1}`, balance: 0, annualRate: 0, minimumPayment: 0, currency: $("#financial-currency").value }); renderDebts(); setPrivacyStep(3, true); }
function importTransactions() {
  const lines = $("#manual-transactions").value.split(/\r?\n/).filter((line) => line.trim()); const rows = [];
  for (const line of lines) { const [dateRaw, concept, amountRaw, currencyRaw] = line.split(","); const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw?.trim()) ? dateRaw.trim() : normalizeDate(dateRaw?.trim() || ""); const amount = parseAmount(amountRaw); const currency = ["USD", "CRC"].includes(currencyRaw?.trim().toUpperCase()) ? currencyRaw.trim().toUpperCase() : $("#financial-currency").value; if (date && concept?.trim() && amount > 0) rows.push({ date, concept: concept.trim(), amount, currency }); }
  state.transactions.push(...rows); renderTransactions(); updateExtractionReview(); $("#privacy-status").textContent = `${rows.length} fila(s) cargadas. Revísalas en la tabla editable.`; setPrivacyStep(2, true);
}
function saveAnonymizedSummary() {
  if (!$("#consent").checked) return;
  if (!updateExtractionReview()) { $("#privacy-status").textContent = "Resuelva manualmente los campos ambiguos antes de guardar."; return; }
  try {
    const coverage = currentSummaryCoverage();
    if (!coverage.hasFinancialData) throw new Error("Ingrese al menos un monto válido o un consumo completo.");
    const personalDataWarnings = currentPersonalDataWarnings();
    if (personalDataWarnings.length) throw new Error(`Edite los posibles datos personales en ${personalDataWarnings.join("; ")} antes de guardar.`);
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
      return { date: transactionDate, concept: row.concept.trim(), amount, currency: row.currency };
    });
    const amount = optionalAmount("financial-amount"); const payment = optionalAmount("financial-payment");
    const balance = optionalAmount("financial-balance"); const minimumPayment = optionalAmount("financial-minimum");
    if (![amount, payment, balance, minimumPayment].some((value) => value !== null) && !transactions.length) throw new Error("No hay montos financieros válidos para guardar.");
    const now = new Date().toISOString();
    const summary = projectAnonymizedSummary({
      id: crypto.randomUUID(), createdAt: now, consentAt: now, consentVersion: 1,
      documentType: $("#document-type").value, date, concept: $("#financial-concept").value.trim(),
      amount, payment, minimumPayment, balance, annualRate, currency: $("#financial-currency").value,
      coverage: coverage.complete ? "complete" : "partial", missingRequiredFields: coverage.missingRequiredFields, transactions,
    });
    const saved = JSON.parse(localStorage.getItem("anonymizedDebtSummaries") || "[]"); saved.push(summary); localStorage.setItem("anonymizedDebtSummaries", JSON.stringify(saved));
    $("#privacy-status").textContent = "Resumen financiero guardado en este dispositivo. No se envió al servidor.";
  } catch (error) { $("#privacy-status").textContent = error.message; }
}
async function compareDebtStrategies() {
  setPrivacyStep(3, true);
  const budget = Number($("#debt-budget").value); const currency = $("#financial-currency").value;
  const debts = state.debts.filter((debt) => (debt.currency || currency) === currency);
  const resultBox = $("#debt-strategy-result");
  resultBox.classList.remove("error", "warning");
  if (!debts.length) { resultBox.textContent = "Agrega al menos una deuda de la moneda seleccionada."; resultBox.classList.add("warning"); return; }
  if (debts.length !== state.debts.length) { resultBox.textContent = `La comparación usa ${currency}; separa deudas en colones y dólares para comparar cada grupo con su propio presupuesto.`; resultBox.classList.add("warning"); return; }
  const compareButton = $("#compare-debt-strategies");
  try {
    compareButton.disabled = true;
    resultBox.innerHTML = '<p role="status">Calculando ambas estrategias…</p>';
    const numericDebts = debts.map(({ balance, annualRate, minimumPayment }) => ({ balance, annualRate, minimumPayment }));
    const response = await fetch(`${API_BASE}/debt/strategies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthlyBudget: budget, debts: numericDebts }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "No se pudo calcular");
    resultBox.innerHTML = `<div class="strategy-results"><article class="strategy-card avalanche"><h3><span class="strategy-mark" aria-hidden="true">↑</span>Avalancha</h3><p class="strategy-note">Prioriza primero la deuda con la tasa más alta.</p><div class="strategy-metrics"><div class="strategy-metric"><span>Tiempo estimado <span class="help-wrap"><button class="help-trigger" type="button" data-help="Cantidad de meses estimada para pagar todas las deudas siguiendo esta estrategia." aria-label="Ayuda: meses de avalancha" aria-expanded="false">?</button></span></span><strong>${result.avalanche.months} meses</strong></div><div class="strategy-metric"><span>Intereses estimados <span class="help-wrap"><button class="help-trigger" type="button" data-help="Total de intereses estimados para esta estrategia, según saldos, tasas, mínimos y presupuesto." aria-label="Ayuda: intereses de avalancha" aria-expanded="false">?</button></span></span><strong>${formatMoney(result.avalanche.interestPaid, currency, 2)}</strong></div></div></article><article class="strategy-card snowball"><h3><span class="strategy-mark" aria-hidden="true">●</span>Bola de nieve</h3><p class="strategy-note">Prioriza primero el saldo más pequeño.</p><div class="strategy-metrics"><div class="strategy-metric"><span>Tiempo estimado <span class="help-wrap"><button class="help-trigger" type="button" data-help="Cantidad de meses estimada para pagar todas las deudas siguiendo esta estrategia." aria-label="Ayuda: meses de bola de nieve" aria-expanded="false">?</button></span></span><strong>${result.snowball.months} meses</strong></div><div class="strategy-metric"><span>Intereses estimados <span class="help-wrap"><button class="help-trigger" type="button" data-help="Total de intereses estimados para esta estrategia, según saldos, tasas, mínimos y presupuesto." aria-label="Ayuda: intereses de bola de nieve" aria-expanded="false">?</button></span></span><strong>${formatMoney(result.snowball.interestPaid, currency, 2)}</strong></div></div></article></div>`;
  } catch (error) { resultBox.textContent = error.message; resultBox.classList.add("error"); }
  finally { compareButton.disabled = false; }
}
function clearDocument(options = {}) {
  state.source?.close?.(); state.pdf?.destroy?.(); state.source = null; state.pdf = null; state.image?.close?.(); state.image = null; state.redactions = new Map(); state.flatDocument = null; state.sourceText = ""; state.transactions = [];
  state.extractionIssues = []; state.extractionMissing = []; state.rejectedTransactions = 0;
  $("#document-file").value = ""; $("#document-text").value = ""; $("#document-preview").innerHTML = '<p class="empty-state">Aquí aparecerá la vista aplanada y el texto extraído. El archivo original no se conserva después de procesarlo.</p>'; $("#redaction-canvas").getContext("2d").clearRect(0, 0, $("#redaction-canvas").width, $("#redaction-canvas").height); $("#redaction-canvas").hidden = true; $(".document-empty").hidden = false; $(".document-empty").textContent = "Selecciona un PDF o imagen para ver aquí la página y cubrir la información privada."; $("#page-indicator").textContent = "Sin documento"; $("#prev-page").disabled = true; $("#next-page").disabled = true; $("#flatten-ocr").disabled = true; $("#undo-redaction").disabled = true; $("#consent").checked = false; $("#save-anonymized").disabled = true; renderTransactions();
  ["financial-date", "financial-concept", "financial-amount", "financial-payment", "financial-balance", "financial-rate", "financial-minimum"].forEach((id) => { $(`#${id}`).value = ""; });
  updateExtractionReview();
  if (!options.keepStatus) $("#privacy-status").textContent = "Archivo y campos temporales descartados.";
}

function hasUnstoredDocumentData() {
  return Boolean(state.source || state.pdf || state.image || state.sourceText || $("#document-text").value || state.transactions.length ||
    ["financial-date", "financial-concept", "financial-amount", "financial-payment", "financial-balance", "financial-rate", "financial-minimum"].some((id) => $(`#${id}`).value));
}

function confirmDiscardDocument(action) {
  if (!hasUnstoredDocumentData()) return true;
  return window.confirm(`${action} Se descartarán el archivo temporal, el texto OCR y los campos sin guardar. Los resúmenes ya guardados se conservarán.`);
}

function bindEvents() {
  bindHelpEvents();
  bindChartEvents();
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  ["#amount", "#term", "#spread", "#extra-payment", "#extra-start-month"].forEach((selector) => $(selector)?.addEventListener("input", updateCalculator));
  ["#rate-change-month", "#rate-change-value"].forEach((selector) => $(selector)?.addEventListener("input", updateCalculator));
  $("#rate").addEventListener("input", () => { if (!state.applyingRate) state.activeRateCode = null; updateCalculator(); });
  $("#extra-mode").addEventListener("change", updateCalculator); $("#rate-type").addEventListener("change", selectRateType); $("#currency").addEventListener("change", changeCurrency);
  $("#export-csv").addEventListener("click", exportSchedule); $("#save-scenario").addEventListener("click", saveScenario); $$(".clear-local-data").forEach((button) => button.addEventListener("click", clearLocalFinancialData));
  $("#fx-amount").addEventListener("input", updateFxResult); $("#fx-direction").addEventListener("change", updateFxResult); $("#use-fx-rate").addEventListener("click", useFxRate);
  $$("[data-currency-filter]").forEach((button) => button.addEventListener("click", () => {
    state.rateFilter = button.dataset.currencyFilter;
    $$("[data-currency-filter]").forEach((item) => { const selected = item === button; item.classList.toggle("active", selected); item.setAttribute("aria-pressed", String(selected)); });
    renderRates();
  }));
  $("#reload-rates").addEventListener("click", loadRates);
  $$("[data-entry]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.entry === "manual" && state.source && !confirmDiscardDocument("Cambiar a ingreso manual?")) return;
    if (button.dataset.entry === "manual" && state.source) clearDocument({ keepStatus: true });
    $$("[data-entry]").forEach((item) => { const selected = item === button; item.classList.toggle("active", selected); item.setAttribute("aria-selected", String(selected)); });
    $("#document-entry").hidden = button.dataset.entry !== "document";
    $("#manual-entry").hidden = button.dataset.entry !== "manual";
    $("#scan-actions").hidden = false;
  }));
  $("#document-file").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file && confirmDiscardDocument("Cargar otro archivo?")) readDocumentFile(file);
    else if (file) event.target.value = "";
  });
  const dropZone = $("#drop-zone");
  ["dragenter", "dragover"].forEach((eventName) => dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add("is-dragging"); }));
  ["dragleave", "dragend"].forEach((eventName) => dropZone.addEventListener(eventName, () => dropZone.classList.remove("is-dragging")));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault(); dropZone.classList.remove("is-dragging");
    const file = event.dataTransfer.files[0];
    if (file && confirmDiscardDocument("Cargar el archivo arrastrado?")) readDocumentFile(file);
  });
  $("#redaction-canvas").addEventListener("pointerdown", beginRedaction); $("#redaction-canvas").addEventListener("pointerup", finishRedaction);
  $("#undo-redaction").addEventListener("click", undoRedaction); $("#flatten-ocr").addEventListener("click", flattenAndExtract); $("#prev-page").addEventListener("click", () => { if (state.page > 1) { state.page -= 1; renderDocumentPage(); } }); $("#next-page").addEventListener("click", () => { if (state.page < state.pageCount) { state.page += 1; renderDocumentPage(); } });
  $("#scan-document").addEventListener("click", () => { extractFinancialData($("#document-text").value); $("#document-preview").innerHTML = '<p>Texto sanitizado analizado localmente. El contenido original no se guardó ni se envió al servidor.</p>'; $("#privacy-status").textContent = "Texto analizado localmente. Revise el resumen y las filas extraídas."; });
  $("#clear-document").addEventListener("click", () => { if (confirmDiscardDocument("Descartar el contenido actual?")) clearDocument(); }); $("#save-anonymized").addEventListener("click", saveAnonymizedSummary); $("#consent").addEventListener("change", updateExtractionReview);
  $("#document-type").addEventListener("change", updateExtractionReview);
  $("#financial-concept").addEventListener("input", updateExtractionReview);
  ["#financial-date", "#financial-amount", "#financial-payment", "#financial-balance", "#financial-rate", "#financial-minimum"].forEach((selector) => $(selector).addEventListener("input", updateExtractionReview));
  $("#debt-budget").addEventListener("input", () => { const result = $("#debt-strategy-result"); result.textContent = "El presupuesto cambió. Vuelve a comparar para actualizar los resultados."; result.classList.remove("error", "warning"); });
  $("#add-transaction").addEventListener("click", addTransaction); $("#import-transactions").addEventListener("click", importTransactions); $("#add-debt").addEventListener("click", addCurrentDebt); $("#add-empty-debt").addEventListener("click", addEmptyDebt); $("#compare-debt-strategies").addEventListener("click", compareDebtStrategies);
  window.addEventListener("resize", () => requestAnimationFrame(drawChart));
}

$("#cutoff-date").value = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
pruneExpiredLocalFinancialData();
bindEvents(); loadScenarios(); loadRates(); renderTransactions(); renderDebts(); updateCalculator();
