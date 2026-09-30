/** Parsing of the simulator form fields. Pure functions, tested in test/lib.test.ts. */

/** Parses an optional whole number from a text field. Empty means undefined. */
export function parseOptionalInt(value: string, min: number, max: number): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed.replaceAll(',', '').replaceAll('_', ''));
  if (!Number.isInteger(n) || n < min || n > max) {
    const range = `${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}`;
    throw new RangeError(`must be a whole number from ${range}`);
  }
  return n;
}

/** Parses an optional percentage ("96" or "96.5%") into a fraction. Empty means undefined. */
export function parseOptionalPercent(value: string, max = 1000): number | undefined {
  const trimmed = value.trim().replace(/%$/, '');
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    throw new RangeError('must be a percentage such as 96');
  }
  return n / 100;
}
