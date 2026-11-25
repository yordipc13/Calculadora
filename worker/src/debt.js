const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export function calculateDebtStrategies(input) {
  const debts = Array.isArray(input.debts) ? input.debts : [];
  const budget = Number(input.monthlyBudget);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("Presupuesto mensual inválido");
  if (!debts.length || debts.length > 50) throw new Error("Agregue de 1 a 50 deudas");

  const normalized = debts.map((debt, index) => {
    const balance = Number(debt.balance);
    const annualRate = Number(debt.annualRate);
    const minimumPayment = Number(debt.minimumPayment || 0);
    if (!Number.isFinite(balance) || balance <= 0) throw new Error(`Saldo inválido en deuda ${index + 1}`);
    if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100) throw new Error(`Tasa inválida en deuda ${index + 1}`);
    if (!Number.isFinite(minimumPayment) || minimumPayment < 0) throw new Error(`Pago mínimo inválido en deuda ${index + 1}`);
    return { id: String(debt.id || index), name: String(debt.name || `Deuda ${index + 1}`).slice(0, 100), balance, annualRate, minimumPayment };
  });
  const minimumTotal = normalized.reduce((sum, debt) => sum + debt.minimumPayment, 0);
  if (minimumTotal > budget) throw new Error("El presupuesto debe cubrir al menos los pagos mínimos de todas las deudas");

  function simulate(strategy) {
    const balances = normalized.map((debt) => ({ ...debt }));
    let totalInterest = 0;
    let totalPaid = 0;
    const maxMonths = 1200;
    for (let month = 1; month <= maxMonths; month += 1) {
      if (balances.every((debt) => debt.balance <= 0.005)) return {
        strategy, months: month - 1, interestPaid: round(totalInterest), totalPaid: round(totalPaid),
        order: balances.map((debt) => debt.name),
      };
      let available = budget;
      const openingBalance = balances.reduce((sum, debt) => sum + debt.balance, 0);
      for (const debt of balances) {
        if (debt.balance <= 0.005) continue;
        const interest = debt.balance * (Math.pow(1 + debt.annualRate / 100, 1 / 12) - 1);
        debt.balance += interest;
        totalInterest += interest;
        const payment = Math.min(debt.minimumPayment, debt.balance);
        debt.balance -= payment;
        available -= payment;
        totalPaid += payment;
      }
      const priority = balances.filter((debt) => debt.balance > 0.005).sort(strategy === "avalanche"
        ? (a, b) => b.annualRate - a.annualRate || a.balance - b.balance
        : (a, b) => a.balance - b.balance || b.annualRate - a.annualRate);
      for (const debt of priority) {
        if (available <= 0.005) break;
        const payment = Math.min(debt.balance, available);
        debt.balance -= payment;
        available -= payment;
        totalPaid += payment;
      }
      const closingBalance = balances.reduce((sum, debt) => sum + debt.balance, 0);
      if (closingBalance >= openingBalance - 0.005 && balances.some((debt) => debt.balance > 0.005)) throw new Error("El presupuesto no reduce el saldo. Auméntelo para cubrir los intereses.");
    }
    throw new Error("Con este presupuesto, el plan supera el límite de simulación de 100 años");
  }

  return { avalanche: simulate("avalanche"), snowball: simulate("snowball") };
}
