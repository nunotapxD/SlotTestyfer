/** Engine version, bumped when game results for the same seed would change. */
export const ENGINE_VERSION = '0.1.0';

/**
 * Formats an amount of fictional credits with two decimal places.
 * Credits are stored as integers in cents to avoid floating point drift.
 */
export function formatCredits(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`Credits must be an integer number of cents, got ${cents}`);
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const units = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${units}.${rest}`;
}
