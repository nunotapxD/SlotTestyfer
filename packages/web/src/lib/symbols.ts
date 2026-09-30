/**
 * How each symbol looks. Known fruit-machine symbols get a glyph; anything else (a game added
 * through the API with its own symbol ids) gets its initials and a stable colour from its id.
 */

export interface SymbolLook {
  readonly glyph: string;
  readonly label: string;
  /** Hue 0-359 for the tile background. */
  readonly hue: number;
  /** Rendered as text (initials) rather than an emoji glyph. */
  readonly isText: boolean;
}

const KNOWN: Record<string, { glyph: string; hue: number }> = {
  CHERRY: { glyph: '🍒', hue: 350 },
  LEMON: { glyph: '🍋', hue: 52 },
  BELL: { glyph: '🔔', hue: 38 },
  SEVEN: { glyph: '7', hue: 0 },
  WILD: { glyph: 'W', hue: 280 },
  STAR: { glyph: '⭐', hue: 205 },
  BAR: { glyph: 'BAR', hue: 220 },
  GRAPE: { glyph: '🍇', hue: 285 },
  ORANGE: { glyph: '🍊', hue: 25 },
  PLUM: { glyph: '🫐', hue: 250 },
  WATERMELON: { glyph: '🍉', hue: 130 },
  DIAMOND: { glyph: '💎', hue: 190 },
};

const TEXT_GLYPHS = new Set(['7', 'W', 'BAR']);

/** Stable hash of a string to a hue, so a symbol keeps its colour between renders. */
export function hueOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function symbolLook(id: string): SymbolLook {
  const label = id.charAt(0) + id.slice(1).toLowerCase().replaceAll('_', ' ');
  const known = KNOWN[id];
  if (known) {
    return { glyph: known.glyph, label, hue: known.hue, isText: TEXT_GLYPHS.has(known.glyph) };
  }
  const initials = id
    .split('_')
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 3);
  return { glyph: initials || '?', label, hue: hueOf(id), isText: true };
}
