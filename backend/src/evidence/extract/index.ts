import type { DocType } from '../sniff';
import { docxExtractor } from './docx';
import { pdfExtractor } from './pdf';
import { textExtractor } from './text';
import type { Extractor } from './types';
import { xlsxExtractor } from './xlsx';

export type { Extracted, Extractor } from './types';
export { NoTextLayer } from './types';

export const EXTRACTORS: Partial<Record<DocType, Extractor>> = {
  pdf: pdfExtractor,
  docx: docxExtractor,
  xlsx: xlsxExtractor,
  text: textExtractor,
};
