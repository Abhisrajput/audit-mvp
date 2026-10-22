import type { Extractor } from './types';

export const textExtractor: Extractor = {
  name: 'utf8',
  version: '1',
  async extract(bytes) {
    return { text: bytes.toString('utf8'), pageStarts: null, pages: null };
  },
};
