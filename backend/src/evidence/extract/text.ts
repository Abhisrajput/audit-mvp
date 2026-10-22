import { EXTRACT_SOFT_CAP_CHARS, type Extractor } from './types';

export const textExtractor: Extractor = {
  name: 'utf8',
  version: '1',
  async extract(bytes) {
    // 4 bytes per char is the UTF-8 maximum, so this slice never drops chars below the cap.
    const text = bytes.subarray(0, EXTRACT_SOFT_CAP_CHARS * 4).toString('utf8').slice(0, EXTRACT_SOFT_CAP_CHARS);
    return { text, pageStarts: null, pages: null };
  },
};
