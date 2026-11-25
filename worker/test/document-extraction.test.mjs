import test from "node:test";
import assert from "node:assert/strict";
import { extractFinancialData, normalizeFinancialDate, parseFinancialNumber } from "../../document-extraction.mjs";

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