import ExcelJS from 'exceljs';
import type { Extractor } from './types';

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
      const lines = [`# ${sheet.name}`];
      sheet.eachRow({ includeEmpty: true }, (row) => {
        const cells: string[] = [];
        for (let c = 1; c <= row.cellCount; c++) cells.push(row.getCell(c).text);
        lines.push(cells.join('\t'));
      });
      const page = lines.join('\n');
      pageStarts.push(offset);
      pages.push(page);
      offset += page.length + 2;
    }
    return { text: pages.join('\n\n'), pageStarts, pages: pages.length };
  },
};
