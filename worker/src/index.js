import { calculateLoan } from "./loan.js";
import { calculateDebtStrategies } from "./debt.js";

const INDICATORS = [
  { code: "423", name: "Tasa Básica Pasiva", shortName: "TBP", currency: "CRC", unit: "percent", description: "Referencia para préstamos en colones.", max: 100 },
  { code: "23698", name: "Tasa Efectiva en Dólares", shortName: "TED", currency: "USD", unit: "percent", description: "Referencia para préstamos en dólares.", max: 100 },
  { code: "317", name: "Tipo de cambio de compra del dólar", shortName: "Compra", currency: "CRC", unit: "CRC", description: "Referencia para convertir dólares a colones al tipo de compra.", max: 100000 },
  { code: "318", name: "Tipo de cambio de venta del dólar", shortName: "Venta", currency: "CRC", unit: "CRC", description: "Referencia para convertir colones a dólares al tipo de venta.", max: 100000 },
  { code: "3541", name: "Tasa de Política Monetaria", shortName: "TPM", currency: "CRC", unit: "percent", description: "Tasa de referencia de política monetaria del BCCR.", max: 100 },
];
const RATE_HISTORY_LIMIT = 365;

const MAX_JSON_BODY_BYTES = 16 * 1024;
const DEFAULT_DEV_ORIGINS = ["http://localhost:5500", "http://127.0.0.1:5500"];
const corsHeaders = {
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Vary": "Origin",
};

function corsFor(request, env) {
  const origin = request.headers.get("Origin");
  const configured = env.CORS_ALLOWED_ORIGINS
    ? env.CORS_ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean)
    : DEFAULT_DEV_ORIGINS;
  const allowed = !origin || configured.includes(origin);
  return {
    allowed,
    headers: { ...corsHeaders, ...(origin && allowed ? { "Access-Control-Allow-Origin": origin } : {}) },
  };
}

function json(body, status = 200, headers = corsHeaders) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

function requestError(message, status) {
  return Object.assign(new Error(message), { status });
}

async function readJsonBody(request) {
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw requestError("El contenido debe ser JSON.", 415);
  }
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) throw requestError("La solicitud supera el tamaño permitido.", 413);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_JSON_BODY_BYTES) throw requestError("La solicitud supera el tamaño permitido.", 413);
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw requestError("El cuerpo JSON no es válido.", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw requestError("El cuerpo JSON debe ser un objeto.", 400);
  return body;
}

async function isCalculationRateLimited(request, env, endpoint) {
  if (!env.CALCULATOR_LIMITER) return false;
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  const result = await env.CALCULATOR_LIMITER.limit({ key: `${endpoint}:${address}` });
  return !result.success;
}

async function supabaseRequest(env, path, options = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase no está configurado");
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  return response;
}

function rowsFromBccr(payload, code) {
  const groups = Array.isArray(payload) ? payload : payload?.datos || payload?.data || payload?.series || [];
  const rows = [];
  for (const group of groups) {
    const indicators = group?.indicadores || [group];
    for (const indicator of indicators) {
      if (indicator?.codigoIndicador && String(indicator.codigoIndicador) !== String(code)) continue;
      const series = indicator?.series || (indicator?.fecha ? [indicator] : []);
      for (const point of series) rows.push({
        date: point.fecha || point.Fecha || point.date,
        value: point.valorDatoPorPeriodo ?? point.valor ?? point.Valor ?? point.value,
      });
    }
  }
  return rows.filter((row) => row.date && row.value !== null && row.value !== undefined && Number.isFinite(Number(row.value)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

async function fetchIndicator(env, indicator) {
  const end = new Date();
  const start = new Date(end.getTime() - 365 * 86400000);
  const fmt = (date) => `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
  const query = new URLSearchParams({ fechaInicio: fmt(start), fechaFin: fmt(end), idioma: "ES" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.BCCR_TIMEOUT_MS || 15000));
  try {
    const response = await fetch(`${env.BCCR_API_BASE_URL || "https://apim.bccr.fi.cr/SDDE/api/Bccr.GE.SDDE.Publico.Indicadores.API"}/indicadoresEconomicos/${indicator.code}/series?${query}`, {
      headers: { Authorization: `Bearer ${env.BCCR_API_TOKEN}`, Accept: "application/json" }, signal: controller.signal,
    });
    if (!response.ok) throw new Error(`BCCR HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.estado === false) throw new Error(payload.mensaje || "El BCCR rechazó la consulta");
    const rows = rowsFromBccr(payload, indicator.code);
    const latest = rows.at(-1);
    if (!latest) throw new Error("La respuesta no contiene observaciones numéricas");
    const value = Number(latest.value);
    if (!Number.isFinite(value) || value < 0 || value > indicator.max || !/^\d{4}-\d{2}-\d{2}/.test(latest.date)) throw new Error("Valor o fecha fuera de rango");
    return { ...indicator, value, referenceDate: latest.date.slice(0, 10) };
  } finally {
    clearTimeout(timer);
  }
}

async function recordVerification(env, indicator, status, error = null) {
  await supabaseRequest(env, "bccr_rate_status?on_conflict=code", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ code: indicator.code, last_verification: new Date().toISOString(), ...(status === "ok" ? { last_success: new Date().toISOString() } : {}), status, last_error: error, indicator_name: indicator.name }),
  });
}

async function refreshRates(env) {
  if (!env.BCCR_API_TOKEN) throw new Error("Falta el secreto BCCR_API_TOKEN");
  const result = { indicators: [], errors: [], checkedAt: new Date().toISOString() };
  const logRetentionCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  await supabaseRequest(env, `bccr_job_logs?executed_at=lt.${encodeURIComponent(logRetentionCutoff)}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  }).catch((error) => console.error("No se pudieron purgar logs BCCR antiguos", error.message));
  for (const indicator of INDICATORS) {
    const startedAt = Date.now();
    try {
      const current = await fetchIndicator(env, indicator);
      const previousResponse = await supabaseRequest(env, `bccr_rates?code=eq.${indicator.code}&select=id,value,reference_date&order=reference_date.desc&limit=1`);
      const previous = (await previousResponse.json())[0];
      if (!previous || Number(previous.value) !== current.value) {
        await supabaseRequest(env, "bccr_rates", {
          method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ code: current.code, name: current.name, short_name: current.shortName, currency: current.currency, unit: current.unit, description: current.description, value: current.value, reference_date: current.referenceDate, last_verification: new Date().toISOString(), source: "BCCR SDDE" }),
        });
      } else if (current.referenceDate > previous.reference_date) {
        await supabaseRequest(env, `bccr_rates?id=eq.${previous.id}`, {
          method: "PATCH",
          body: JSON.stringify({ reference_date: current.referenceDate, last_verification: new Date().toISOString() }),
        });
      }
      await recordVerification(env, current, "ok");
      result.indicators.push({ code: current.code, value: current.value, referenceDate: current.referenceDate, changed: !previous || Number(previous.value) !== current.value });
      await supabaseRequest(env, "bccr_job_logs", {
        method: "POST", body: JSON.stringify({ code: current.code, status: "ok", executed_at: new Date().toISOString(), duration_ms: Date.now() - startedAt }),
      }).catch((error) => console.error("No se pudo registrar ejecución BCCR", error.message));
    } catch (error) {
      const message = error.name === "AbortError" ? "Tiempo de espera agotado" : error.message;
      result.errors.push({ code: indicator.code, error: message });
      await recordVerification(env, indicator, "error", message).catch((logError) => console.error("No se pudo registrar estado BCCR", logError.message));
      await supabaseRequest(env, "bccr_job_logs", {
        method: "POST", body: JSON.stringify({ code: indicator.code, status: "error", error: message, executed_at: new Date().toISOString(), duration_ms: Date.now() - startedAt }),
      }).catch((logError) => console.error("No se pudo registrar error BCCR", logError.message));
    }
  }
  return result;
}

async function getRates(env) {
  const [historyResponses, statusResponse] = await Promise.all([
    Promise.all(INDICATORS.map((indicator) => supabaseRequest(env, `bccr_rates?code=eq.${indicator.code}&select=*&order=reference_date.desc&limit=${RATE_HISTORY_LIMIT}`))),
    supabaseRequest(env, "bccr_rate_status?select=code,last_verification,last_success,status,last_error,indicator_name"),
  ]);
  const histories = await Promise.all(historyResponses.map((response) => response.json()));
  const status = await statusResponse.json();
  const rates = INDICATORS.map((indicator, index) => {
    const history = histories[index];
    const row = history[0];
    const check = status.find((entry) => entry.code === indicator.code);
    const previous = history.find((entry) => entry.code === indicator.code && row && Number(entry.value) !== Number(row.value));
    return row ? { ...row, name: indicator.name, short_name: indicator.shortName, unit: indicator.unit, description: indicator.description,
      last_verification: check?.last_verification || null, last_success: check?.last_success || null, service_status: check?.status || "unknown", last_error: check?.last_error || null,
      previous_value: previous?.value ?? null, history: history.slice(0, RATE_HISTORY_LIMIT).reverse() } : null;
  }).filter(Boolean);
  return { rates, source: "BCCR SDDE", checkedAt: status.map((item) => item.last_verification).sort().at(-1) || null, serviceStatus: status.some((item) => item.status === "error") ? "partial" : "ok" };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshRates(env).then((result) => console.log("BCCR job", JSON.stringify(result))).catch((error) => console.error("BCCR job error", error.message)));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsFor(request, env);
    const respond = (body, status = 200, headers = {}) => json(body, status, { ...cors.headers, ...headers });
    if (request.method === "OPTIONS") return new Response(null, { status: cors.allowed ? 204 : 403, headers: cors.headers });
    if (!cors.allowed) return respond({ error: "Origen no permitido." }, 403);
    if (url.pathname === "/api/health") return respond({ ok: true, service: "calculadora-finanzas" });
    if (url.pathname === "/api/rates" && request.method === "GET") {
      try { return respond(await getRates(env)); } catch (error) { return respond({ rates: [], source: "No disponible", error: error.message }, 503); }
    }
    if (url.pathname.startsWith("/api/rates/") && request.method === "GET") {
      try {
        const code = url.pathname.split("/").at(-1);
        const response = await supabaseRequest(env, `bccr_rates?code=eq.${encodeURIComponent(code)}&select=code,name,short_name,currency,unit,value,reference_date&order=reference_date.desc&limit=${RATE_HISTORY_LIMIT}`);
        return respond({ history: (await response.json()).reverse() });
      } catch (error) { return respond({ error: error.message }, 503); }
    }
    if (url.pathname === "/api/bccr/refresh" && request.method === "POST") {
      if (!env.CRON_TRIGGER_SECRET || request.headers.get("X-Job-Secret") !== env.CRON_TRIGGER_SECRET) return respond({ error: "No autorizado" }, 401);
      try { const result = await refreshRates(env); return respond({ ok: result.errors.length === 0, ...result }, result.errors.length ? 207 : 200); }
      catch (error) { return respond({ error: error.message }, 500); }
    }
    if (url.pathname === "/api/loans/calculate" && request.method === "POST") {
      try {
        if (await isCalculationRateLimited(request, env, "loan")) return respond({ error: "Demasiadas solicitudes. Intente de nuevo en un minuto." }, 429, { "Retry-After": "60" });
        const body = await readJsonBody(request);
        const input = {
          principal: body.principal, annualRate: body.annualRate, months: body.months,
          extraPayment: body.extraPayment, extraMode: body.extraMode, extraStartMonth: body.extraStartMonth,
          rateChanges: Array.isArray(body.rateChanges) ? body.rateChanges.map((change) => ({ month: change?.month, annualRate: change?.annualRate })) : body.rateChanges,
        };
        return respond(calculateLoan(input));
      } catch (error) { return respond({ error: error.message }, error.status || 400); }
    }
    if (url.pathname === "/api/debt/strategies" && request.method === "POST") {
      try {
        if (await isCalculationRateLimited(request, env, "debt")) return respond({ error: "Demasiadas solicitudes. Intente de nuevo en un minuto." }, 429, { "Retry-After": "60" });
        const body = await readJsonBody(request);
        const debts = Array.isArray(body.debts)
          ? body.debts.map((debt) => ({ balance: debt?.balance, annualRate: debt?.annualRate, minimumPayment: debt?.minimumPayment }))
          : body.debts;
        return respond(calculateDebtStrategies({ monthlyBudget: body.monthlyBudget, debts }));
      } catch (error) { return respond({ error: error.message }, error.status || 400); }
    }
    return respond({ error: "Ruta no encontrada" }, 404);
  },
};
