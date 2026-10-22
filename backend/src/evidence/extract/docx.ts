import mammoth from 'mammoth';
import { EXTRACT_SOFT_CAP_CHARS, type Extractor } from './types';

export const docxExtractor: Extractor = {
  name: 'mammoth',
  version: '1',
  async extract(bytes) {
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return { text: value.slice(0, EXTRACT_SOFT_CAP_CHARS), pageStarts: null, pages: null };
  },
};
