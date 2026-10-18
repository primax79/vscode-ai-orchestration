export interface ShortTitleItem {
  id?: string;
  title?: string;
  question?: string;
  short_title?: string;
  short_title_source?: string;
  [key: string]: any;
}

const LEADING_ARTICLES = new Set(['a', 'an', 'the']);
const TRAILING_STOP_WORDS = new Set([
  'for', 'and', 'to', 'in', 'of', 'on', 'with', 'by', 'at', 'from', 'as', 'into', 'or'
]);

/**
 * Deterministically derives a 3-4 word short title from a full title or question text.
 * Drops leading articles (a, an, the), strips ids, backticks, parentheticals, and
 * selects the first 3-4 significant words.
 */
export function deriveShortTitle(rawText: string): string {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }

  // 1. Strip parentheticals: ( ... ) and [ ... ]
  let s = rawText.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');

  // 2. Strip backticks
  s = s.replace(/`+/g, '');

  // 3. Strip IDs: T###, Q###, N###, INIT-###, numeric dotted IDs like 12.16 or 01.1.2, #12
  s = s.replace(/\b(?:T\d{3,}|Q\d{3,}|N\d{3,}|INIT-\d+)\b[:\s-]*/gi, ' ');
  s = s.replace(/(?:^|\s)#?\d+(\.\d+)+[:\s-]*/g, ' ');
  s = s.replace(/(?:^|\s)#\d+[:\s-]*/g, ' ');

  // 4. Clean up separators: replace em/en dashes, slashes, colons, underscores with spaces
  s = s.replace(/[—–:/_]/g, ' ');

  // 5. Extract words and strip edge punctuation
  const rawWords = s
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ''))
    .filter(Boolean);

  if (rawWords.length === 0) {
    return '';
  }

  // 6. Drop leading articles (a, an, the)
  let words = [...rawWords];
  while (words.length > 0 && LEADING_ARTICLES.has(words[0].toLowerCase())) {
    words.shift();
  }
  if (words.length === 0) {
    words = [...rawWords];
  }

  // 7. Take first 3-4 significant words
  // If 4 or more words, take 4 words, but if 4th word is a trailing preposition/conjunction, take 3 words
  if (words.length > 3) {
    if (TRAILING_STOP_WORDS.has(words[3].toLowerCase())) {
      words = words.slice(0, 3);
    } else {
      words = words.slice(0, 4);
    }
  }

  // 8. Enforce <= 40 chars and no trailing punctuation
  let candidate = words.join(' ');
  while (candidate.length > 40 && words.length > 1) {
    words.pop();
    candidate = words.join(' ');
  }
  if (candidate.length > 40) {
    candidate = candidate.slice(0, 40).replace(/[^a-zA-Z0-9]+$/g, '');
  }

  return candidate;
}

/**
 * Returns item.short_title if present, or deterministically derives a 3-4 word
 * short title from item's title or question.
 */
export function shortTitle(item?: string | ShortTitleItem | null): string {
  if (!item) {
    return '';
  }

  if (typeof item === 'string') {
    return deriveShortTitle(item);
  }

  if (typeof item === 'object') {
    const explicit = item.short_title ?? item.shortTitle;
    if (typeof explicit === 'string' && explicit.trim()) {
      return explicit.trim();
    }
    const candidate = item.title || item.question || '';
    return deriveShortTitle(candidate);
  }

  return '';
}
