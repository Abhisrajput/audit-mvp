import mammoth from 'mammoth';
import type { Extractor } from './types';

export const docxExtractor: Extractor = {
  name: 'mammoth',
  version: '1',
  async extract(bytes) {
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return { text: value, pageStarts: null, pages: null };
  },
};
