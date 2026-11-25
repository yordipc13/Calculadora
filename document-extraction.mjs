export function parseFinancialNumber(input) {
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  let value = String(input ?? "").replace(/[^\d.,+-]/g, "");
  if (!value || !/^[+-]?\d[\d.,]*$/.test(value)) return null;
  const sign = value.startsWith("-") ? -1 : 1;
  value = value.replace(/^[+-]/, "");
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const grouping = decimal === "," ? /\./g : /,/g;
    const parsed = Number(value.replace(grouping, "").replace(decimal, "."));
    return Number.isFinite(parsed) ? sign * parsed : null;
  }
  if (comma >= 0 || dot >= 0) {
    const parts = value.split(comma >= 0 ? "," : ".");
    const grouped = parts.length > 1 && parts.slice(1).every((part) => part.length === 3);
    const normalized = grouped ? parts.join("") : `${parts.slice(0, -1).join("")}.${parts.at(-1)}`;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? sign * parsed : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? sign * parsed : null;
}

export function normalizeFinancialDate(input) {
  const value = String(input ?? "").trim();
  let year; let month; let day;
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const local = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (iso) [, year, month, day] = iso;
  else if (local) {
    [, day, month, year] = local;
    if (year.length === 2) year = `20${year}`;
  } else return "";
  const parts = [Number(year), Number(month), Number(day)];
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] - 1 || date.getUTCDate() !== parts[2]) return "";
  return `${String(parts[0]).padStart(4, "0")}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}`;
}

const definitions = [
  { id: "date", label: "fecha de corte", labelPattern: /\bfecha\s+(?:de\s+)?(?:corte|estado)\b|\bstatement\s+date\b/i, valuePattern: /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/, parse: normalizeFinancialDate, validate: Boolean },
  { id: "amount", label: "monto", labelPattern: /\b(?:monto(?:\s+(?:original|inicial|total|del\s+cr[eé]dito))?|principal|importe(?:\s+total)?)\b/i, valuePattern: /[-+]?\s*(?:(?:US\$|USD|CRC|[$₡])\s*)?\d[\d.,]*/i, parse: parseFinancialNumber, validate: (value) => Number.isFinite(value) && value > 0 },
  { id: "payment", label: "cuota", labelPattern: /\b(?:cuota(?:\s+mensual)?|pago\s+mensual|monthly\s+payment)\b/i, valuePattern: /[-+]?\s*(?:(?:US\$|USD|CRC|[$₡])\s*)?\d[\d.,]*/i, parse: parseFinancialNumber, validate: (value) => Number.isFinite(value) && value > 0 },
  { id: "balance", label: "saldo al corte", labelPattern: /\b(?:saldo(?:\s+(?:total|al\s+corte|actual|pendiente))?|balance)\b/i, valuePattern: /[-+]?\s*(?:(?:US\$|USD|CRC|[$₡])\s*)?\d[\d.,]*/i, parse: parseFinancialNumber, validate: (value) => Number.isFinite(value) && value > 0 },
  { id: "annualRate", label: "tasa anual", labelPattern: /\b(?:tasa(?:\s+(?:de\s+)?inter[eé]s)?|inter[eé]s|tea)\b(?:\s+anual(?:\s+efectiva)?)?/i, valuePattern: /[-+]?\s*\d+(?:[.,]\d+)?\s*%?/, parse: (value) => parseFinancialNumber(value.replace(/%/g, "")), validate: (value) => Number.isFinite(value) && value >= 0 && value <= 100 },
  { id: "minimumPayment", label: "pago mínimo", labelPattern: /\b(?:pago\s*m[ií]nimo|minimum\s+payment)\b/i, valuePattern: /[-+]?\s*(?:(?:US\$|USD|CRC|[$₡])\s*)?\d[\d.,]*/i, parse: parseFinancialNumber, validate: (value) => Number.isFinite(value) && value > 0 },
];

function collectField(lines, definition) {
  let matchedLabel = false;
  const candidates = [];
  for (const line of lines) {
    const labelMatch = definition.labelPattern.exec(line);
    if (!labelMatch) continue;
    matchedLabel = true;
    const raw = line.slice(labelMatch.index + labelMatch[0].length).match(definition.valuePattern)?.[0];
    if (raw !== undefined) candidates.push(definition.parse(raw.trim()));
  }
  const values = [...new Map(candidates.map((candidate) => [String(candidate), candidate])).values()];
  if (values.length > 1) return { value: null, issue: `Se detectaron varios valores para ${definition.label}; ingréselo manualmente.` };
  if (values.length === 1 && !definition.validate(values[0])) return { value: null, issue: `El valor detectado para ${definition.label} está fuera de rango o no es válido; corríjalo manualmente.` };
  if (values.length === 1) return { value: values[0], issue: null };
  if (matchedLabel) return { value: null, issue: `No se pudo interpretar ${definition.label}; ingréselo manualmente.` };
  return { value: null, issue: null };
}

export function extractFinancialData(text, defaultCurrency = "CRC") {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fields = Object.fromEntries(definitions.map((definition) => [definition.id, collectField(lines, definition)]));
  const transactions = [];
  let rejectedTransactions = 0;
  const rowPattern = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s+(.+?)\s+(?:(?:US\$|USD|CRC|[$₡])\s*)?(-?\d[\d.,]*)\s*(?:US\$|USD|CRC|[$₡])?$/i;
  for (const line of lines) {
    const match = line.match(rowPattern);
    if (!match || /\b(?:saldo|pago\s*m[ií]nimo|total|tasa|cuota)\b/i.test(line)) continue;
    const date = normalizeFinancialDate(match[1]);
    const amount = parseFinancialNumber(match[3]);
    const concept = match[2].trim();
    if (!date || !concept || !Number.isFinite(amount) || amount <= 0) {
      rejectedTransactions += 1;
      continue;
    }
    const currency = /US\$|\bUSD\b/i.test(line) ? "USD" : /₡|\bCRC\b/i.test(line) ? "CRC" : defaultCurrency;
    transactions.push({ date, concept, amount, currency });
  }
  const issues = Object.entries(fields).filter(([, field]) => field.issue).map(([id, field]) => ({ id, message: field.issue }));
  const missing = definitions.filter(({ id }) => fields[id].value === null && !fields[id].issue).map(({ label }) => label);
  return { fields, issues, missing, transactions, rejectedTransactions };
}