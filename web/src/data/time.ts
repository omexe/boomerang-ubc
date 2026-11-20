// How long is left, in the two largest units that matter.

/** "3 days 4 hours", "2 hours 5 min", "4 min 10 s", "9 s". Zero or less reads "0 s". */
export function timeLeft(seconds: bigint): string {
  if (seconds <= 0n) return "0 s";
  const s = Number(seconds > 10n ** 12n ? 10n ** 12n : seconds);
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const secs = s % 60;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (days > 0) return hours > 0 ? `${plural(days, "day")} ${plural(hours, "hour")}` : plural(days, "day");
  if (hours > 0) return minutes > 0 ? `${plural(hours, "hour")} ${minutes} min` : plural(hours, "hour");
  if (minutes > 0) return secs > 0 ? `${minutes} min ${secs} s` : `${minutes} min`;
  return `${secs} s`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A chain time as a date anyone reads the same way: "18 Nov 2026, 14:05 UTC". */
export function utcStamp(seconds: bigint): string {
  if (seconds < 0n || seconds > 253_402_300_799n) return "an unreadable date"; // outside years 1970 to 9999
  const d = new Date(Number(seconds) * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}
