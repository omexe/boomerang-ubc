// Which characters of a plate's figure changed, counted from the right, so a plate flips only the
// digits that moved. Right-aligned because figures grow on the left ("999.00" to "1,000.00").

export function changedPositions(before: string, after: string): number[] {
  const out: number[] = [];
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const a = before[before.length - 1 - i];
    const b = after[after.length - 1 - i];
    if (a !== b) out.push(i);
  }
  return out;
}
