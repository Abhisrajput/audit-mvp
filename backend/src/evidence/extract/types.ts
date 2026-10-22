export interface Extracted { text: string; pageStarts: number[] | null; pages: number | null }
export interface Extractor { name: string; version: string; extract(bytes: Buffer): Promise<Extracted> }
export class NoTextLayer extends Error {
  constructor(message = 'the PDF has no text layer') {
    super(message);
    this.name = 'NoTextLayer';
  }
}
