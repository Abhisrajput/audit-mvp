export interface TextChunk {
  ordinal: number;
  /** 1-based page the chunk starts on, or null when page offsets are unknown. */
  page: number | null;
  text: string;
}

/** Chunks aim for about this many characters; a chunk only exceeds it when one paragraph does. */
export const CHUNK_TARGET_CHARS = 1200;

interface Piece {
  start: number;
  text: string;
}

/** Paragraphs (split on blank lines) with their offsets; over-long paragraphs are cut at whitespace (word boundaries). */
function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  const re = /\S[\s\S]*?(?=\n\s*\n|$)/g;
  for (const m of text.matchAll(re)) {
    const para = m[0].trim();
    if (!para) continue;
    if (para.length <= CHUNK_TARGET_CHARS) {
      out.push({ start: m.index!, text: para });
      continue;
    }
    let offset = 0;
    while (offset < para.length) {
      let end = Math.min(offset + CHUNK_TARGET_CHARS, para.length);
      if (end < para.length) {
        const cut = lastWhitespace(para, offset, end);
        if (cut > offset) end = cut;
      }
      out.push({ start: m.index! + offset, text: para.slice(offset, end).trim() });
      offset = end;
      while (offset < para.length && /\s/.test(para[offset])) offset++;
    }
  }
  return out;
}

/** Index of the last whitespace character in para[from, to], or -1. */
function lastWhitespace(para: string, from: number, to: number): number {
  for (let i = to; i > from; i--) if (/\s/.test(para[i])) return i;
  return -1;
}

/** Page start offsets as the chunker needs them: whole, non-negative, distinct and ascending. */
export function normalisePageStarts(pageStarts: readonly number[] = []): number[] {
  return [...new Set(pageStarts.filter((s) => Number.isInteger(s) && s >= 0))].sort((a, b) => a - b);
}

/**
 * Splits document text into paragraph-aligned chunks of about CHUNK_TARGET_CHARS.
 * pageStarts holds the character offset where each page begins (page 1 first; sorted and de-duplicated here).
 */
export function chunkText(text: string, pageStartsIn: readonly number[] = []): TextChunk[] {
  const pageStarts = normalisePageStarts(pageStartsIn);
  const pageOf = (offset: number) => (pageStarts.length ? Math.max(1, pageStarts.filter((s) => s <= offset).length) : null);
  const chunks: TextChunk[] = [];
  let current: Piece[] = [];
  const flush = () => {
    if (!current.length) return;
    chunks.push({ ordinal: chunks.length, page: pageOf(current[0].start), text: current.map((p) => p.text).join('\n\n') });
    current = [];
  };
  for (const piece of pieces(text)) {
    const size = current.reduce((n, p) => n + p.text.length + 2, 0);
    // A chunk never spans a page break, so its page is the page every word of it is on.
    if (current.length && (size + piece.text.length > CHUNK_TARGET_CHARS || pageOf(piece.start) !== pageOf(current[0].start))) flush();
    current.push(piece);
  }
  flush();
  return chunks;
}
