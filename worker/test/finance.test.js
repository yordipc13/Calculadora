import test from "node:test";
import assert from "node:assert/strict";
import { calculateLoan } from "../src/loan.js";
import { calculateDebtStrategies } from "../src/debt.js";

test("calcula amortización francesa y líquido cero", () => {
  const result = calculateLoan({ principal: 1000000, annualRate: 12, months: 12 });
  assert.equal(result.monthsPaid, 12);
  assert.equal(result.schedule.at(-1).balance, 0);
  assert.ok(result.totalPaid > 1000000);
});

test("rechaza entradas inválidas", () => {
  assert.throws(() => calculateLoan({ principal: -1, annualRate: 12, months: 12 }), /Monto inválido/);
  assert.throws(() => calculateLoan({ principal: 1000, annualRate: 12, months: 0 }), /Plazo inválido/);
});

test("calcula avalancha y bola de nieve", () => {
  const result = calculateDebtStrategies({
    monthlyBudget: 250,
    debts: [
      { name: "Tarjeta A", balance: 1000, annualRate: 30, minimumPayment: 50 },
      { name: "Tarjeta B", balance: 600, annualRate: 12, minimumPayment: 30 },
    ],
  });
  assert.ok(result.avalanche.months > 0);
  assert.ok(result.snowball.months > 0);
});
