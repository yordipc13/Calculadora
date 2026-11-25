function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateLoan(input) {
  const principal = Number(input.principal);
  const annualRate = Number(input.annualRate);
  const months = Number(input.months);
  const extraPayment = Number(input.extraPayment || 0);
  const extraMode = input.extraMode === "reducePayment" ? "reducePayment" : "reduceTerm";
  const extraStartMonth = Number(input.extraStartMonth || 1);
  const rateChanges = Array.isArray(input.rateChanges) ? input.rateChanges : [];
  if (Number.isInteger(months) && months >= 1 && months <= 360 && (!Number.isInteger(extraStartMonth) || extraStartMonth < 1 || extraStartMonth > months)) throw new Error("Invalid extra payment start month");
  if (rateChanges.length > 60 || rateChanges.some((change) => !Number.isInteger(Number(change.month)) || Number(change.month) < 2 || Number(change.month) > months || !Number.isFinite(Number(change.annualRate)) || Number(change.annualRate) < 0 || Number(change.annualRate) > 100)) throw new Error("Invalid rate adjustment");

  if (!Number.isFinite(principal) || principal <= 0) throw new Error("Monto inválido");
  if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100) throw new Error("Tasa inválida");
  if (!Number.isInteger(months) || months < 1 || months > 360) throw new Error("Plazo inválido");
  if (!Number.isFinite(extraPayment) || extraPayment < 0) throw new Error("Abono inválido");

  // Inputs are effective annual rates; convert to an equivalent effective monthly rate.
  let monthlyRate = Math.pow(1 + annualRate / 100, 1 / 12) - 1;
  const regularPayment = monthlyRate === 0
    ? principal / months
    : principal * monthlyRate * Math.pow(1 + monthlyRate, months) / (Math.pow(1 + monthlyRate, months) - 1);

  let balance = principal;
  let payment = regularPayment;
  let totalInterest = 0;
  const schedule = [];

  for (let month = 1; balance > 0.01 && month <= months * 2; month += 1) {
    const rateChange = rateChanges.find((change) => Number(change.month) === month);
    if (rateChange) {
      monthlyRate = Math.pow(1 + Number(rateChange.annualRate) / 100, 1 / 12) - 1;
      const periodsLeft = Math.max(1, months - month + 1);
      payment = monthlyRate === 0 ? balance / periodsLeft : balance * monthlyRate / (1 - Math.pow(1 + monthlyRate, -periodsLeft));
    }
    const interest = balance * monthlyRate;
    let extra = month >= extraStartMonth ? extraPayment : 0;
    let plannedPayment = Math.min(balance + interest, month === months ? balance + interest : payment);

    if (plannedPayment - interest >= balance) {
      extra = 0;
      plannedPayment = balance + interest;
    }

    let capital = plannedPayment - interest;
    let remainingExtra = extra;
    if (capital + remainingExtra > balance) remainingExtra = balance - capital;

    if (capital < 0) capital = 0;
    const beforeExtraBalance = balance - capital;
    balance = Math.max(0, beforeExtraBalance - remainingExtra);

    if (extraMode === "reducePayment" && extraStartMonth <= month && remainingExtra > 0 && balance > 0) {
      const periodsLeft = months - month;
      const newRate = monthlyRate;
      payment = periodsLeft <= 0 ? balance : (newRate === 0
        ? balance / periodsLeft
        : balance * newRate * Math.pow(1 + newRate, periodsLeft) / (Math.pow(1 + newRate, periodsLeft) - 1));
    }

    totalInterest += interest;
    schedule.push({
      month,
      payment: roundMoney(plannedPayment + remainingExtra),
      capital: roundMoney(capital),
      extraCapital: roundMoney(remainingExtra),
      interest: roundMoney(interest),
      balance: roundMoney(balance),
    });
  }

  return {
    regularPayment: roundMoney(regularPayment),
    finalPayment: roundMoney(schedule.at(-1)?.payment || 0),
    totalInterest: roundMoney(totalInterest),
    totalPaid: roundMoney(principal + totalInterest),
    monthsPaid: schedule.length,
    schedule,
  };
}
