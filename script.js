const $ = (selector) => document.querySelector(selector);

const state = {
  schedule: [],
  sourceText: "",
  detected: [],
};

function formatMoney(value) {
  const currency = $("#currency")?.value || "CRC";
  const formatter = new Intl.NumberFormat("es-CR", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });
  return formatter.format(Number.isFinite(value) ? value : 0);
}

function calculateSchedule(principal, annualRate, months, selectedRateType) {
  const baseRate = selectedRateType === "fixed" ? annualRate : annualRate;
  const spread = selectedRateType === "fixed" ? 0 : Number($("#spread").value);
  const monthlyRate = (baseRate + spread) / 100 / 12;
  const payment = monthlyRate === 0
    ? principal / months
    : principal * (monthlyRate * Math.pow(1 + monthlyRate, months)) /
      (Math.pow(1 + monthlyRate, months) - 1);

  let balance = principal;
  const schedule = [];
  let totalInterest = 0;

  for (let month = 1; month <= months; month += 1) {
    const interest = balance * monthlyRate;
    let capital = payment - interest;

    if (month === months) {
      capital = balance;
    }

    balance = Math.max(0, balance - capital);
    totalInterest += interest;
    schedule.push({
      month,
      payment: month === months ? capital + interest : payment,
      capital,
      interest,
      balance,
    });
  }

  return { schedule, payment, totalInterest, monthlyRate: (baseRate + spread) / 100 / 12 };
}

function updateCalculator() {
  let principal = Number($("#amount").value);
  const fixedRate = Number($("#rate").value);
  const months = Number($("#term").value);
  const selectedRateType = $("#rate-type").value;
  const spread = selectedRateType === "fixed" ? 0 : Number($("#spread").value);

  $("#amount-output").textContent = formatMoney(principal);
  $("#rate-output").textContent = `${fixedRate.toFixed(1)}%`;
  $("#spread-output").textContent = `${spread.toFixed(1)}%`;
  $("#term-output").textContent = `${months} meses`;
  const currency = $("#currency").value;
  const amountInput = $("#amount");
  if (currency === "USD" && amountInput.max !== "300000") {
    amountInput.min = "1000";
    amountInput.max = "300000";
    amountInput.step = "1000";
    if (principal > 300000) {
      amountInput.value = "300000";
      principal = 300000;
    }
  }
  if (currency === "CRC" && amountInput.max !== "50000000") {
    amountInput.min = "300000";
    amountInput.max = "50000000";
    amountInput.step = "100000";
  }

  if (months > (currency === "USD" ? 240 : 360)) {
    $("#term").value = currency === "USD" ? "240" : "360";
  }

  $("#spread-label").style.opacity = selectedRateType === "fixed" ? "0.45" : "1";
  $("#spread").disabled = selectedRateType === "fixed";

  const result = calculateSchedule(principal, fixedRate, months, selectedRateType);
  state.schedule = result.schedule;

  $("#metric-principal").textContent = formatMoney(principal);
  $("#metric-term").textContent = `${months} meses`;
  $("#metric-rate").textContent = `${(fixedRate + spread).toFixed(1)}%`;
  $("#metric-payment").textContent = formatMoney(result.payment);
  $("#metric-interest").textContent = formatMoney(result.totalInterest);
  $("#metric-total").textContent = formatMoney(principal + result.totalInterest);

  renderSchedule();
  drawChart();
}

function renderSchedule() {
  const body = $("#schedule-body");
  body.innerHTML = state.schedule.map((row) => `
    <tr>
      <td>${row.month}</td>
      <td>${formatMoney(row.payment)}</td>
      <td>${formatMoney(row.capital)}</td>
      <td>${formatMoney(row.interest)}</td>
      <td>${formatMoney(row.balance)}</td>
    </tr>
  `).join("");
}

function drawChart() {
  const canvas = $("#balance-chart");
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = rect.width * scale;
  canvas.height = rect.height * scale;

  const context = canvas.getContext("2d");
  context.scale(scale, scale);
  context.clearRect(0, 0, rect.width, rect.height);

  const padding = { left: 70, right: 18, top: 18, bottom: 42 };
  const width = rect.width - padding.left - padding.right;
  const height = rect.height - padding.top - padding.bottom;
  if (!state.schedule.length || width <= 0 || height <= 0) return;

  const principal = Number($("#amount").value);
  context.strokeStyle = "rgba(32, 40, 38, 0.16)";
  context.fillStyle = "#59635f";
  context.font = "12px Trebuchet MS";
  context.lineWidth = 1;

  const steps = 4;
  for (let index = 0; index <= steps; index += 1) {
    const y = padding.top + (height * index) / steps;
    const value = principal * (1 - index / steps);
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(padding.left + width, y);
    context.stroke();
    context.textAlign = "right";
    context.fillText(formatMoney(value).replace("CRC", "₡"), padding.left - 10, y + 4);
  }

  context.strokeStyle = "#247f6b";
  context.fillStyle = "rgba(36, 127, 107, 0.16)";
  context.lineWidth = 3;
  context.beginPath();

  state.schedule.forEach((row, index) => {
    const x = padding.left + (index / Math.max(1, state.schedule.length - 1)) * width;
    const y = padding.top + (row.balance / principal) * height;
    if (index === 0) context.moveTo(padding.left, padding.top);
    context.lineTo(x, y);
  });

  context.lineTo(padding.left + width, padding.top + height);
  context.lineTo(padding.left, padding.top + height);
  context.closePath();
  context.fill();

  context.beginPath();
  context.moveTo(padding.left, padding.top);
  state.schedule.forEach((row, index) => {
    const x = padding.left + (index / Math.max(1, state.schedule.length - 1)) * width;
    const y = padding.top + (row.balance / principal) * height;
    context.lineTo(x, y);
  });
  context.stroke();

  context.fillStyle = "#9fa6cc";
  context.textAlign = "left";
  context.fillStyle = "#59635f";
  context.fillText("0", padding.left, rect.height - 12);
  context.textAlign = "right";
  context.fillText(String(state.schedule.length), padding.left + width, rect.height - 12);
}

function switchView(viewName) {
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
  $(`#${viewName}-view`).classList.add("active");
  document.querySelector(`.tab[data-view="${viewName}"]`)?.classList.add("active");
  if (viewName === "calculator") requestAnimationFrame(drawChart);
}

function exportSchedule() {
  if (!state.schedule.length) return;
  const rows = [["Mes", "Cuota", "Capital", "Interes", "Saldo"], ...state.schedule.map((row) => [
    row.month,
    row.payment.toFixed(2),
    row.capital.toFixed(2),
    row.interest.toFixed(2),
    row.balance.toFixed(2),
  ])];
  const csv = rows.map((row) => row.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "plan-amortizacion.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function saveScenario() {
  const principal = Number($("#amount").value);
  const annualRate = Number($("#rate").value);
  const months = Number($("#term").value);
  const currency = $("#currency").value;
  const cutoffDate = $("#cutoff-date").value;

  if (principal <= 0 || annualRate < 0 || annualRate > 60 || months < 1) {
    $("#scenario-status").textContent = "Revise monto, tasa y plazo antes de guardar.";
    return;
  }

  if (!cutoffDate) {
    $("#scenario-status").textContent = "Seleccione una fecha de corte para conservar la vigencia.";
    return;
  }

  const scenario = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    cutoffDate,
    currency,
    principal,
    rateType: $("#rate-type").value,
    annualRate,
    spread: Number($("#spread").value),
    months,
    schedule: state.schedule.map((row) => ({ ...row })),
    snapshot: {
      payment: state.schedule[0]?.payment || 0,
      totalInterest: state.schedule.reduce((sum, row) => sum + row.interest, 0),
      effectiveRate: annualRate + ( $("#rate-type").value === "fixed" ? 0 : Number($("#spread").value) ),
    },
  };
  const scenarios = JSON.parse(localStorage.getItem("financialScenarios") || "[]");
  scenarios.push(scenario);
  localStorage.setItem("financialScenarios", JSON.stringify(scenarios));
  $("#scenario-status").textContent = "Escenario guardado con tasa, moneda y fecha de corte.";
  loadScenarios();
}

function loadScenarios() {
  const container = $("#scenario-list");
  const scenarios = JSON.parse(localStorage.getItem("financialScenarios") || "[]");
  if (!container) return;

  container.innerHTML = scenarios.length ? scenarios.slice().reverse().map((scenario) => `
    <article class="scenario-item" data-scenario-id="${escapeHtml(scenario.id)}">
      <div>
        <strong>${escapeHtml(scenario.currency)} · ${formatMoney(scenario.principal)}</strong>
        <span>${Number(scenario.snapshot?.effectiveRate || 0).toFixed(2)}% anual · ${scenario.months} meses</span>
      </div>
      <div>
        <span>Corte: ${escapeHtml(scenario.cutoffDate)}</span>
        <button type="button" class="secondary restore-scenario" data-scenario-id="${escapeHtml(scenario.id)}">Restaurar</button>
      </div>
    </article>
  `).join("") : '<p class="status">No hay escenarios guardados.</p>';

  container.querySelectorAll(".restore-scenario").forEach((button) => {
    button.addEventListener("click", () => restoreScenario(button.dataset.scenarioId));
  });
}

function restoreScenario(id) {
  const scenarios = JSON.parse(localStorage.getItem("financialScenarios") || "[]");
  const scenario = scenarios.find((item) => item.id === id);
  if (!scenario) return;

  $("#currency").value = scenario.currency;
  $("#amount").value = String(scenario.principal);
  $("#rate-type").value = scenario.rateType;
  $("#rate").value = String(scenario.annualRate);
  $("#spread").value = String(scenario.spread);
  $("#term").value = String(scenario.months);
  $("#cutoff-date").value = scenario.cutoffDate;
  updateCalculator();
  $("#scenario-status").textContent = "Escenario restaurado con su snapshot original.";
}

function clearScenarios() {
  localStorage.removeItem("financialScenarios");
  loadScenarios();
  $("#scenario-status").textContent = "Escenarios locales eliminados.";
}

function loadRates() {
  const body = $("#rates-body");
  const rates = JSON.parse(localStorage.getItem("financialRates") || "[]");
  body.innerHTML = rates.length ? rates.map((rate) => `
    <tr><td>${escapeHtml(rate.name)}</td><td>${Number(rate.value).toFixed(2)}%</td><td>${escapeHtml(rate.validFrom)}</td><td>${escapeHtml(rate.source)}</td></tr>
  `).join("") : '<tr><td colspan="4">Sin tasas registradas.</td></tr>';
}

function addRate() {
  const name = $("#rate-name").value;
  const value = Number($("#rate-value").value);
  const validFrom = $("#rate-date").value;
  if (!Number.isFinite(value) || value < 0 || value > 100 || !validFrom) {
    $("#rate-status").textContent = "Ingrese un valor entre 0 y 100 y una fecha válida.";
    return;
  }

  const rates = JSON.parse(localStorage.getItem("financialRates") || "[]");
  rates.push({
    id: crypto.randomUUID(),
    name,
    value,
    validFrom,
    source: "Carga manual",
    fetchedAt: new Date().toISOString(),
  });
  localStorage.setItem("financialRates", JSON.stringify(rates));
  $("#rate-status").textContent = "Tasa registrada sin modificar registros anteriores.";
  $("#rate-value").value = "";
  loadRates();
}

function escapeHtml(value) {
  const node = document.createElement("div");
  node.textContent = String(value);
  return node.innerHTML;
}

function detectSensitivePatterns(text) {
  const patterns = [
    { name: "Identificación", regex: /\b(?:\d{1}-\d{4}-\d{4}|\d{9,12}|[A-Z]{1,2}-\d{6,12})\b/gi },
    { name: "Correo", regex: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
    { name: "Teléfono", regex: /(?:\+506\s*)?(?:\d[\s-]?){7,11}\d/gi },
    { name: "Tarjeta", regex: /\b(?:\d[ -]*?){13,19}\b/g },
    { name: "Monto", regex: /(?:₡|CRC|USD|US\$)\s*[\d.,]+/gi },
  ];

  const matches = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      matches.push({ name: pattern.name, value: match[0] });
    }
  }
  return matches;
}

function scanDocument() {
  const text = $("#document-text").value || state.sourceText;
  if (!text.trim()) {
    $("#privacy-status").textContent = "Agregue texto o cargue un archivo compatible.";
    return;
  }

  state.detected = detectSensitivePatterns(text);
  let preview = escapeHtml(text);
  for (const match of state.detected) {
    preview = preview.replaceAll(escapeHtml(match.value), `<mark>${escapeHtml(match.value)}</mark>`);
  }

  $("#document-preview").innerHTML = preview;

  const dates = text.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g) || [];
  const amounts = text.match(/(?:₡|CRC|USD|US\$)\s*[\d.,]+/gi) || [];
  const rateMatch = text.match(/(?:tasa|interest|interés)[^\d]{0,20}(\d+(?:[.,]\d+)?)\s*%/i);

  if (dates[0]) $("#financial-date").value = normalizeDate(dates[0]);
  if (amounts[0]) $("#financial-amount").value = amounts[0];
  if (amounts[1]) $("#financial-payment").value = amounts[1];
  if (amounts[2]) $("#financial-balance").value = amounts[2];
  if (rateMatch) $("#financial-rate").value = rateMatch[1].replace(",", ".");

  $("#privacy-status").textContent = `Se detectaron ${state.detected.length} patrones posibles. Complete y confirme manualmente los campos financieros.`;
  $("#consent").checked = false;
  $("#save-anonymized").disabled = true;
}

async function readDocumentFile(file) {
  $("#privacy-status").textContent = "Leyendo el archivo localmente...";
  if (file.type === "application/pdf") {
    state.sourceText = "[PDF cargado] Este visor requiere OCR/extracción local para convertir el contenido en texto. El archivo no se ha enviado a ningún servidor.";
  } else if (file.type.startsWith("image/")) {
    const url = URL.createObjectURL(file);
    state.sourceText = "[IMAGEN CARGADA] La detección automática requiere OCR local. Revise visualmente antes de guardar datos.";
    $("#document-preview").innerHTML = `<img src="${url}" alt="Vista previa local" style="max-width:100%; max-height:380px" />`;
  } else {
    state.sourceText = await file.text();
  }
  $("#document-text").value = state.sourceText;
  $("#privacy-status").textContent = "Archivo leído en memoria. Revise antes de guardar.";
}

function normalizeDate(value) {
  const parts = value.match(/\d+/g);
  if (!parts || parts.length !== 3) return "";
  let year = Number(parts[2]);
  if (year < 100) year += 2000;
  return `${String(year).padStart(4, "0")}-${String(parts[1]).padStart(2, "0")}-${String(parts[0]).padStart(2, "0")}`;
}

function saveAnonymizedSummary() {
  if (!$("#consent").checked) return;
  const financialFields = {
    date: $("#financial-date").value,
    concept: $("#financial-concept").value.trim(),
    amount: $("#financial-amount").value.trim(),
    payment: $("#financial-payment").value.trim(),
    balance: $("#financial-balance").value.trim(),
    annualRate: $("#financial-rate").value,
  };
  const summaries = JSON.parse(localStorage.getItem("anonymizedDebtSummaries") || "[]");
  summaries.push({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), financialFields });
  localStorage.setItem("anonymizedDebtSummaries", JSON.stringify(summaries));
  $("#privacy-status").textContent = "Resumen financiero anónimo guardado localmente. El documento original no se conserva.";
  clearDocument();
}

function clearDocument() {
  state.sourceText = "";
  state.detected = [];
  $("#document-file").value = "";
  $("#document-text").value = "";
  $("#document-preview").textContent = "Sin contenido cargado.";
  $("#consent").checked = false;
  $("#save-anonymized").disabled = true;
  ["financial-date", "financial-concept", "financial-amount", "financial-payment", "financial-balance", "financial-rate"]
    .forEach((id) => { $(`#${id}`).value = ""; });
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

["#amount", "#rate", "#term", "#spread"].forEach((selector) => $(selector).addEventListener("input", updateCalculator));
$("#rate-type").addEventListener("change", updateCalculator);
$("#currency").addEventListener("change", updateCalculator);
$("#export-csv").addEventListener("click", exportSchedule);
$("#save-scenario").addEventListener("click", saveScenario);
$("#clear-scenarios").addEventListener("click", clearScenarios);
$("#add-rate").addEventListener("click", addRate);
$("#scan-document").addEventListener("click", scanDocument);
$("#clear-document").addEventListener("click", clearDocument);
$("#save-anonymized").addEventListener("click", saveAnonymizedSummary);
$("#consent").addEventListener("change", (event) => {
  $("#save-anonymized").disabled = !event.target.checked;
});
$("#document-file").addEventListener("change", (event) => {
  if (event.target.files[0]) readDocumentFile(event.target.files[0]);
});

window.addEventListener("resize", () => requestAnimationFrame(drawChart));

$("#rate-date").value = new Date().toISOString().slice(0, 10);
$("#cutoff-date").value = new Date().toISOString().slice(0, 10);
loadRates();
loadScenarios();
updateCalculator();
