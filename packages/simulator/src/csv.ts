/**
 * Reports as CSV, for spreadsheets. Pure function, used by the CLI and the API.
 */
import type { Report, Verdict } from './report.js';

function cell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * One table with three columns (section, name, value), so it opens cleanly in any spreadsheet:
 * the summary, the verdict, the RTP by feature and by symbol, and the win distribution.
 * Fractions are written as fractions (0.9594), not percentages, to keep them computable.
 */
export function reportToCsv(
  report: Report,
  verdict: Verdict | null = null,
  meta: Readonly<Record<string, string | number>> = {},
): string {
  const rows: (string | number)[][] = [['section', 'name', 'value']];
  for (const [name, value] of Object.entries(meta)) rows.push(['run', name, value]);
  rows.push(
    ['summary', 'rounds', report.rounds],
    ['summary', 'rtp', report.rtp],
    ['summary', 'ci_low', report.interval.low],
    ['summary', 'ci_high', report.interval.high],
    ['summary', 'standard_error', report.standardError],
    ['summary', 'hit_frequency', report.hitFrequency],
    ['summary', 'max_win', report.maxWin],
    ['summary', 'std_dev', report.stdDev],
    ['summary', 'feature_frequency', report.featureFrequency],
  );
  if (verdict) {
    rows.push(
      ['verdict', 'status', verdict.status],
      ['verdict', 'target', verdict.target],
      ['verdict', 'tolerance', verdict.tolerance],
      ['verdict', 'reason', verdict.reason],
    );
  }
  for (const [name, value] of Object.entries(report.rtpByFeature)) {
    rows.push(['rtp_by_feature', name, value]);
  }
  for (const { symbol, rtp } of report.rtpBySymbol) rows.push(['rtp_by_symbol', symbol, rtp]);
  for (const bucket of report.histogram) {
    rows.push(['histogram_rounds', bucket.label, bucket.rounds]);
  }
  return `${rows.map((row) => row.map(cell).join(',')).join('\n')}\n`;
}
