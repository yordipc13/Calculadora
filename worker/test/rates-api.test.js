import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const indicatorCodes = ["423", "23698", "317", "318", "3541"];

test("rates endpoint returns up to 365 observations for each indicator", async () => {
  const originalFetch = globalThis.fetch;
  const requestedLimits = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/bccr_rate_status")) {
      return Response.json(indicatorCodes.map((code) => ({ code, status: "ok", last_verification: "2026-11-25T18:00:00Z" })));
    }
    if (url.pathname.endsWith("/bccr_rates")) {
      const code = url.searchParams.get("code").replace("eq.", "");
      const limit = Number(url.searchParams.get("limit"));
      requestedLimits.push({ code, limit });
      const observations = Array.from({ length: 400 }, (_, index) => ({
        code,
        value: 4 + index / 100,
        reference_date: new Date(Date.UTC(2026, 0, 1) - index * 86400000).toISOString().slice(0, 10),
      }));
      return Response.json(observations.slice(0, limit));
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const response = await worker.fetch(new Request("https://worker.test/api/rates"), {
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(requestedLimits, indicatorCodes.map((code) => ({ code, limit: 365 })));
    assert.equal(payload.rates.length, indicatorCodes.length);
    for (const rate of payload.rates) {
      assert.equal(rate.history.length, 365);
      assert.equal(rate.history.at(-1).value, rate.value);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refresh records successful indicators with duration and purges expired logs", async () => {
  const originalFetch = globalThis.fetch;
  const logs = [];
  const requests = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    requests.push({ url, method: options.method || "GET" });
    if (url.hostname === "apim.bccr.fi.cr") return Response.json([{ fecha: "2026-11-25", valor: 4.5 }]);
    if (url.pathname.endsWith("/bccr_rate_status")) return new Response(null, { status: 201 });
    if (url.pathname.endsWith("/bccr_rates") && (options.method || "GET") === "GET") return Response.json([]);
    if (url.pathname.endsWith("/bccr_rates")) return new Response(null, { status: 201 });
    if (url.pathname.endsWith("/bccr_job_logs") && options.method === "DELETE") return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/bccr_job_logs")) { logs.push(JSON.parse(options.body)); return new Response(null, { status: 201 }); }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const response = await worker.fetch(new Request("https://worker.test/api/bccr/refresh", {
      method: "POST", headers: { "X-Job-Secret": "job-secret" },
    }), {
      BCCR_API_TOKEN: "test-token", SUPABASE_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "test-key", CRON_TRIGGER_SECRET: "job-secret",
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.indicators.length, indicatorCodes.length);
    assert.equal(logs.length, indicatorCodes.length);
    assert.ok(logs.every((entry) => entry.status === "ok" && Number.isInteger(entry.duration_ms) && entry.duration_ms >= 0));
    assert.ok(requests.some(({ url, method }) => method === "DELETE" && url.pathname.endsWith("/bccr_job_logs")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});