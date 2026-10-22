import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContentMismatch, sniff, zipUncompressedSize } from '../src/evidence/sniff';
import { EXTRACTORS, NoTextLayer } from '../src/evidence/extract';

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures', 'evidence', n));
const pdf = fx('sample.pdf');
const scanned = fx('scanned.pdf');
const docx = fx('sample.docx');
const xlsx = fx('sample.xlsx');

describe('evidence sniffing and extraction', () => {
  it('sniffs by magic bytes and refuses a declared type the bytes contradict', () => {
    expect(sniff(pdf, 'application/pdf', 'a.pdf').type).toBe('pdf');
    expect(sniff(docx, 'application/octet-stream', 'a.docx').type).toBe('docx');
    expect(sniff(xlsx, 'application/octet-stream', 'a.xlsx').type).toBe('xlsx');
    expect(sniff(Buffer.from('batch,result\n'), 'text/csv', 'a.csv')).toEqual({ type: 'text', mime: 'text/csv' });
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', 'a.png').type).toBe('image');
    expect(() => sniff(docx, 'application/pdf', 'a.pdf')).toThrow(ContentMismatch);
    expect(sniff(Buffer.from([0, 1, 2, 3]), 'application/octet-stream', 'a.bin')).toEqual({ type: 'binary', mime: 'application/octet-stream' });
  });
  it('sums a zip central directory', () => expect(zipUncompressedSize(docx)).toBeGreaterThan(100));
  it('extracts PDF text page by page', async () => {
    const r = await EXTRACTORS.pdf!.extract(pdf);
    expect(r.pages).toBe(2); expect(r.pageStarts).toEqual([0, expect.any(Number)]);
    expect(r.text).toContain('BMR-2026-0142'); expect(r.text.slice(r.pageStarts![1])).toContain('DEV-0031');
  });
  it('reports a PDF with no text layer', async () => { await expect(EXTRACTORS.pdf!.extract(scanned)).rejects.toBeInstanceOf(NoTextLayer); });
  it('extracts docx paragraphs', async () => { expect((await EXTRACTORS.docx!.extract(docx)).text).toMatch(/Training matrix\n+Operator A signed off/); });
  it('extracts xlsx as one page per sheet with tab-separated rows', async () => {
    const r = await EXTRACTORS.xlsx!.extract(xlsx);
    expect(r.pages).toBe(1); expect(r.text).toContain('# Log\nBatch\tResult\n0142\tpass\n0143\tfail');
  });
  it('passes text through', async () => { expect((await EXTRACTORS.text!.extract(Buffer.from('a,b\n'))).text).toBe('a,b\n'); });
});
