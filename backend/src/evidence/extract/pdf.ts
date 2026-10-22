import { NoTextLayer, type Extractor } from './types';

let pdfjs: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;
// pdfjs-dist 6 is ESM-only; under module nodenext this stays a real import() in dist/.
const loadPdfjs = () => (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

export const pdfExtractor: Extractor = {
  name: 'pdfjs-dist',
  version: '6',
  async extract(bytes) {
    const lib = await loadPdfjs();
    const task = lib.getDocument({ data: new Uint8Array(bytes), disableWorker: true, isEvalSupported: false } as never);
    const doc = await task.promise;
    try {
      const pageStarts: number[] = [];
      const pages: string[] = [];
      let offset = 0;
      for (let i = 1; i <= doc.numPages; i++) {
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
      const text = pages.join('\n\n');
      if (text.replace(/\s/g, '').length < 20) throw new NoTextLayer();
      return { text, pageStarts, pages: doc.numPages };
    } finally {
      await task.destroy();
    }
  },
};
