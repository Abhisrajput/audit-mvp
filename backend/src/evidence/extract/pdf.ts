import { EXTRACT_SOFT_CAP_CHARS, NoTextLayer, type Extractor } from './types';

let pdfjs: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;
// pdfjs-dist 6 is ESM-only; under module nodenext this stays a real import() in dist/.
const loadPdfjs = () => (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs').catch((e) => {
  pdfjs = undefined; // do not cache a failed import
  throw e;
}));

export const pdfExtractor: Extractor = {
  name: 'pdfjs-dist',
  version: '6',
  async extract(bytes) {
    const lib = await loadPdfjs();
    const task = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
    try {
      const doc = await task.promise;
      const pageStarts: number[] = [];
      const pages: string[] = [];
      let offset = 0;
      for (let i = 1; i <= doc.numPages && offset <= EXTRACT_SOFT_CAP_CHARS; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        let text = '';
        for (const item of content.items) {
          if (!('str' in item)) continue;
          text += item.str + (item.hasEOL ? '\n' : ' ');
        }
        text = text.trim();
        pageStarts.push(offset);
        pages.push(text);
        offset += text.length + 2;
        page.cleanup();
      }
      const text = pages.join('\n\n').slice(0, EXTRACT_SOFT_CAP_CHARS);
      if (text.replace(/\s/g, '').length < 20) throw new NoTextLayer();
      return { text, pageStarts, pages: doc.numPages };
    } finally {
      await task.destroy();
    }
  },
};
