import ExcelJS from 'exceljs';
import { EXTRACT_SOFT_CAP_CHARS, type Extractor } from './types';

export const xlsxExtractor: Extractor = {
  name: 'exceljs',
  version: '4',
  async extract(bytes) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const pageStarts: number[] = [];
    const pages: string[] = [];
    let offset = 0;
    for (const sheet of wb.worksheets) {
      if (offset > EXTRACT_SOFT_CAP_CHARS) break;
      const lines = [`# ${sheet.name}`];
      let size = lines[0].length;
      sheet.eachRow({ includeEmpty: true }, (row) => {
        if (size > EXTRACT_SOFT_CAP_CHARS) return;
        const cells: string[] = [];
        for (let c = 1; c <= row.cellCount; c++) cells.push(row.getCell(c).text);
        while (cells.length && cells[cells.length - 1] === '') cells.pop();
        const line = cells.join('\t');
        lines.push(line);
        size += line.length + 1;
      });
      while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const page = lines.join('\n');
      pageStarts.push(offset);
      pages.push(page);
      offset += page.length + 2;
    }
    return { text: pages.join('\n\n').slice(0, EXTRACT_SOFT_CAP_CHARS), pageStarts, pages: pages.length };
  },
};
