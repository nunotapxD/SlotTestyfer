/** Formatting helpers. Pure functions, tested in test/lib.test.ts. */

/** 1234 cents -> "12.34". Credits are always whole cents. */
export function formatCredits(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/** 0.95937 -> "95.94%". */
export function formatPercent(fraction: number, digits = 2): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** 10000000 -> "10,000,000". */
export function formatInt(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** 10000000 -> "10M", 250000 -> "250k". */
export function formatCompact(value: number): string {
  if (value >= 1e9) return `${trim(value / 1e9)}B`;
  if (value >= 1e6) return `${trim(value / 1e6)}M`;
  if (value >= 1e3) return `${trim(value / 1e3)}k`;
  return String(value);
}

function trim(value: number): string {
  return value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, '');
}

/** 2.5 -> "2.5x", 44 -> "44x". */
export function formatMultiplier(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0$/, '')}x`;
}

/** Milliseconds -> "850 ms", "4.2 s", "1 min 5 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}
