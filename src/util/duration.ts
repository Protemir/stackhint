/** Parse "30m", "12h", "7d", "2w" into milliseconds. */
export function parseDuration(input: string): number | undefined {
  const m = /^\s*(\d{1,4})\s*([mhdw])\s*$/i.exec(input);
  if (!m || m[1] === undefined || m[2] === undefined) return undefined;
  const n = Number(m[1]);
  if (n <= 0) return undefined;
  const unit = m[2].toLowerCase();
  const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 7 * 86_400_000;
  return n * ms;
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString();
}
