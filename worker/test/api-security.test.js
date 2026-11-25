import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function makeRequest(path, { origin, method = "GET", body = "", contentType = "application/json", headers = {} } = {}) {
  const requestHeaders = new Map(Object.entries({
    ...(origin ? { Origin: origin } : {}),
    ...(contentType ? { "Content-Type": contentType } : {}),
    ...headers,
  }).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const bytes = new TextEncoder().encode(body);
  return {
    url: `https://worker.test${path}`,
    method,
    headers: { get: (name) => requestHeaders.get(name.toLowerCase()) || null },
    arrayBuffer: async () => bytes.buffer,
  };
}

const allowedEnv = { CORS_ALLOWED_ORIGINS: "https://app.example" };

test("allows configured origins and rejects other browser origins", async () => {
  const allowed = await worker.fetch(makeRequest("/api/health", { origin: "https://app.example" }), allowedEnv);
  const denied = await worker.fetch(makeRequest("/api/health", { origin: "https://other.example" }), allowedEnv);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://app.example");
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
});

test("rejects oversized and non-JSON calculation requests", async () => {
  const oversized = await worker.fetch(makeRequest("/api/loans/calculate", {
    origin: "https://app.example",
    method: "POST",
    body: JSON.stringify({ payload: "x".repeat(17000) }),
  }), allowedEnv);
  const wrongContentType = await worker.fetch(makeRequest("/api/loans/calculate", {
    origin: "https://app.example",
    method: "POST",
    contentType: "text/plain",
    body: "{}",
  }), allowedEnv);
  assert.equal(oversized.status, 413);
  assert.equal(wrongContentType.status, 415);
});

test("loan calculation ignores extra identity fields and stays anonymous", async () => {
  const response = await worker.fetch(makeRequest("/api/loans/calculate", {
    origin: "https://app.example",
    method: "POST",
    body: JSON.stringify({ principal: 1000000, annualRate: 12, months: 12, fullName: "Private Person" }),
  }), allowedEnv);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.monthsPaid, 12);
  assert.equal(JSON.stringify(result).includes("Private Person"), false);
});

test("debt strategy drops names and returns generic labels", async () => {
  const response = await worker.fetch(makeRequest("/api/debt/strategies", {
    origin: "https://app.example",
    method: "POST",
    body: JSON.stringify({ monthlyBudget: 500, debts: [{ balance: 1000, annualRate: 12, minimumPayment: 50, name: "Private Account 1234" }] }),
  }), allowedEnv);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(result.avalanche.order, ["Deuda 1"]);
  assert.equal(JSON.stringify(result).includes("Private Account 1234"), false);
});

test("calculation rate limit returns 429 and refresh still requires its secret", async () => {
  let limiterKey = "";
  const limited = await worker.fetch(makeRequest("/api/loans/calculate", {
    origin: "https://app.example",
    method: "POST",
    headers: { "CF-Connecting-IP": "192.0.2.10" },
    body: JSON.stringify({ principal: 1000000, annualRate: 12, months: 12 }),
  }), { ...allowedEnv, CALCULATOR_LIMITER: { limit: async ({ key }) => { limiterKey = key; return { success: false }; } } });
  const refresh = await worker.fetch(makeRequest("/api/bccr/refresh", { origin: "https://app.example", method: "POST" }), allowedEnv);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal(limiterKey, "loan:192.0.2.10");
  assert.equal(refresh.status, 401);
});