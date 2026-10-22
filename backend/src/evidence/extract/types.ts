export interface Extracted { text: string; pageStarts: number[] | null; pages: number | null }
export interface Extractor { name: string; version: string; extract(bytes: Buffer): Promise<Extracted> }
export class NoTextLayer extends Error {
  constructor(message = 'the PDF has no text layer') {
    super(message);
    this.name = 'NoTextLayer';
  }
}

/** Extractors stop accumulating past this many characters (2 x MAX_TEXT_CHARS); the caller cuts and marks truncation. */
export const EXTRACT_SOFT_CAP_CHARS = 1_800_000;
