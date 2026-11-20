// Test USDC amounts as people read and type them. The contract counts in millionths of a
// dollar (6 decimals); the page shows dollars and cents and never rounds up, so it never
// shows more than a person has or will get.

export const UNIT = 1_000_000n; // one dollar
export const CENT = 10_000n;

/**
 * "1,234.56" from 1234567890n. Cut to the cent, never rounded up. An amount above zero and below
 * one cent reads "less than 0.01", so a figure a person was paid is never shown as "0.00"; zero
 * itself still reads "0.00". This is the one money formatter for anything a person reads.
 */
export function formatUsd(units: bigint): string {
  if (units > 0n && units < CENT) return "less than 0.01";
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const dollars = (abs / UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = ((abs % UNIT) / CENT).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${dollars}.${cents}`;
}

/**
 * The exact amount, all six decimals, trailing zeros trimmed: "25", "25.5", "0.000001". For text
 * a person must be able to type or a field value, where the rounded formatUsd would mislead.
 */
export function exactUsd(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const dollars = (abs / UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (abs % UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${dollars}${fraction === "" ? "" : `.${fraction}`}`;
}

/** A bonus estimate in a sentence: "about 1.58", or "less than 0.01" for anything under a cent. */
export function about(units: bigint): string {
  return units > 0n && units < CENT ? "less than 0.01" : `about ${formatUsd(units)}`;
}

/**
 * What a person typed, as millionths of a dollar; null if it is not an amount.
 * Accepts "25", "25.5", "1,000.25", "$25", ".5" and spaces around them. Refuses a sign,
 * letters, more than six decimals, a second dot, and commas that are not thousands marks.
 */
export function parseUsd(text: string): bigint | null {
  let t = text.trim();
  if (t.startsWith("$")) t = t.slice(1).trim();
  if (!/^(\d{1,3}(,\d{3})+|\d*)(\.\d{0,6})?$/.test(t)) return null;
  t = t.replace(/,/g, "");
  if (t === "" || t === ".") return null;
  const [whole, fraction = ""] = t.split(".");
  if (whole.length > 15) return null; // more test dollars than exist
  return BigInt(whole || "0") * UNIT + BigInt(fraction.padEnd(6, "0") || "0");
}
