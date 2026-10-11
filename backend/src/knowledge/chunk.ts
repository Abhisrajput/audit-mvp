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

/** Paragraphs (split on blank lines) with their offsets; over-long paragraphs are cut at word boundaries. */
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
        const space = para.lastIndexOf(' ', end);
        if (space > offset) end = space;
      }
      out.push({ start: m.index! + offset, text: para.slice(offset, end).trim() });
      offset = end;
      while (para[offset] === ' ') offset++;
    }
  }
  return out;
}

/**
 * Splits document text into paragraph-aligned chunks of about CHUNK_TARGET_CHARS.
 * pageStarts holds the character offset where each page begins (page 1 first).
 */
export function chunkText(text: string, pageStarts: number[] = []): TextChunk[] {
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
    if (current.length && size + piece.text.length > CHUNK_TARGET_CHARS) flush();
    current.push(piece);
  }
  flush();
  return chunks;
}
