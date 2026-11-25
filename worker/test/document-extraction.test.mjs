import test from "node:test";
import assert from "node:assert/strict";
import { detectPersonalData, extractFinancialData, getSummaryCoverage, normalizeFinancialDate, parseFinancialNumber, projectAnonymizedSummary } from "../../document-extraction.mjs";

test("parses Costa Rican and international monetary separators", () => {
  assert.equal(parseFinancialNumber("₡1.250.500,75"), 1250500.75);
  assert.equal(parseFinancialNumber("USD 1,250.50"), 1250.5);
  assert.equal(parseFinancialNumber("1,250"), 1250);
});

test("accepts real dates and rejects impossible dates", () => {
  assert.equal(normalizeFinancialDate("25/11/2026"), "2026-11-25");
  assert.equal(normalizeFinancialDate("2026-02-31"), "");
});

test("extracts labeled fields and valid transactions", () => {
  const result = extractFinancialData([
    "Fecha de corte: 25/11/2026",
    "Monto original: CRC 1.250.000,00",
    "Cuota mensual: ₡45.000",
    "Saldo al corte: ₡900.000",
    "Tasa anual efectiva: 18,5%",
    "Pago mínimo: CRC 25.000",
    "2026-11-01 Supermercado 25.000,00 CRC",
  ].join("\n"));

  assert.equal(result.fields.date.value, "2026-11-25");
  assert.equal(result.fields.amount.value, 1250000);
  assert.equal(result.fields.annualRate.value, 18.5);
  assert.equal(result.fields.minimumPayment.value, 25000);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, 25000);
  assert.deepEqual(result.issues, []);
});

test("does not choose between conflicting values", () => {
  const result = extractFinancialData("Tasa anual: 18%\nTasa anual: 24%");
  assert.equal(result.fields.annualRate.value, null);
  assert.match(result.fields.annualRate.issue, /varios valores/);
  assert.equal(result.issues.length, 1);
});

test("flags invalid labeled values for manual correction", () => {
  const result = extractFinancialData("Tasa anual: 140%");
  assert.equal(result.fields.annualRate.value, null);
  assert.match(result.fields.annualRate.issue, /no es válido/);
});

test("detects common personal data categories in editable descriptions", () => {
  assert.deepEqual(detectPersonalData("Nombre: María Pérez · correo: maria@example.com · teléfono: 8888-1234"), ["correo", "teléfono", "nombre o titular"]);
  assert.deepEqual(detectPersonalData("Cédula: 1-2345-6789 · tarjeta: 4111 1111 1111 1111"), ["identificación", "tarjeta"]);
  assert.deepEqual(detectPersonalData("Supermercado central"), []);
});

test("reports required-field coverage and permits clearly partial summaries", () => {
  const partial = getSummaryCoverage({ type: "loan", amount: 250000 });
  assert.equal(partial.hasFinancialData, true);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missingRequiredFields, ["fecha del estado", "tasa anual"]);

  const complete = getSummaryCoverage({ type: "creditCard", date: "2026-11-25", balance: 90000 });
  assert.equal(complete.complete, true);
});

test("projects only the approved anonymized summary fields", () => {
  const projected = projectAnonymizedSummary({
    id: "summary-1", createdAt: "2026-11-25T00:00:00.000Z", consentAt: "2026-11-25T00:00:00.000Z", consentVersion: 1,
    documentType: "loan", date: "2026-11-25", concept: "Préstamo", amount: 1000, payment: null, minimumPayment: null,
    balance: 900, annualRate: 10, currency: "CRC", coverage: "partial", missingRequiredFields: ["tasa anual"],
    rawOcr: "private text", transactions: [{ date: "2026-11-01", concept: "Comercio", amount: 10, currency: "CRC", accountNumber: "123456" }],
  });
  assert.equal(Object.hasOwn(projected, "rawOcr"), false);
  assert.equal(Object.hasOwn(projected.transactions[0], "accountNumber"), false);
});