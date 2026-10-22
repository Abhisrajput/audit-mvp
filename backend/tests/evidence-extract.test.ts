import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContentMismatch, sniff, zipUncompressedSize } from '../src/evidence/sniff';
import { EXTRACT_SOFT_CAP_CHARS } from '../src/evidence/extract/types';
import ExcelJS from 'exceljs';
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

  it('refuses more contradictions and keeps unrecognised images as binary', () => {
    expect(() => sniff(Buffer.from([0, 1, 2, 3]), 'text/csv', 'a.csv')).toThrow(ContentMismatch);
    expect(() => sniff(Buffer.from('hello'), 'image/png', 'a.png')).toThrow(ContentMismatch);
    expect(sniff(Buffer.from([0x42, 0x4d, 0, 1, 2]), 'image/bmp', 'a.bmp')).toEqual({ type: 'binary', mime: 'application/octet-stream' });
  });
  it('reads zip sizes exactly and gives Infinity for garbage or truncation', () => {
    expect(zipUncompressedSize(docx)).toBe(959); // sum of file_size from Python zipfile
    expect(zipUncompressedSize(Buffer.from('not a zip at all, just garbage bytes'))).toBe(Infinity);
    expect(zipUncompressedSize(docx.subarray(0, docx.length - 30))).toBe(Infinity);
  });
  it('applies the 20 non-whitespace character threshold to PDFs', async () => {
    await expect(EXTRACTORS.pdf!.extract(fx('chars19.pdf'))).rejects.toBeInstanceOf(NoTextLayer);
    await expect(EXTRACTORS.pdf!.extract(fx('chars20.pdf'))).resolves.toMatchObject({ pages: 1 });
  });
  it('rejects a corrupt PDF with a parse error, not NoTextLayer', async () => {
    const err = await EXTRACTORS.pdf!.extract(Buffer.from('%PDF-1.4\nthis is not a pdf')).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NoTextLayer);
  });
  it('trims trailing empty cells and rows in xlsx', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Wide');
    ws.getCell(1, 200).value = 'x'; ws.getCell(2, 1).value = 'a'; ws.getCell(3, 1).value = 'b'; ws.getCell(5, 1).value = '';
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await EXTRACTORS.xlsx!.extract(buf);
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('# Wide');
    expect(lines[2]).toBe('a'); expect(lines[3]).toBe('b');
    expect(lines.slice(2).some((l) => l.endsWith('\t'))).toBe(false);
    expect(lines[lines.length - 1]).toBe('b');
  });
  it('stops at the soft cap', async () => {
    const big = Buffer.alloc(EXTRACT_SOFT_CAP_CHARS + 5000, 'a');
    expect((await EXTRACTORS.text!.extract(big)).text.length).toBe(EXTRACT_SOFT_CAP_CHARS);
  });
});
