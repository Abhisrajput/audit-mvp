export type DocType = 'pdf' | 'docx' | 'xlsx' | 'text' | 'image' | 'zip' | 'binary';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export class ContentMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentMismatch';
  }
}

const TEXT_EXTENSIONS: Record<string, string> = {
  csv: 'text/csv', tsv: 'text/plain', md: 'text/markdown', txt: 'text/plain', json: 'application/json',
};
const TEXT_MIMES = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json']);

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i < 0 ? '' : filename.slice(i + 1).toLowerCase();
}

function startsWith(bytes: Buffer, sig: number[], at = 0): boolean {
  return bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);
}

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The central directory's entries: [name, uncompressed size]; null when it cannot be read. */
function zipEntries(bytes: Buffer): Array<[string, number]> | null {
  const minEocd = 22;
  if (bytes.length < minEocd) return null;
  let eocd = -1;
  for (let i = bytes.length - minEocd; i >= Math.max(0, bytes.length - minEocd - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = bytes.readUInt16LE(eocd + 10);
  let p = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) return null; // zip64: not supported, treated as unreadable
  const out: Array<[string, number]> = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== 0x02014b50) return null;
    const size = bytes.readUInt32LE(p + 24);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    if (size === 0xffffffff || p + 46 + nameLen > bytes.length) return null;
    out.push([bytes.toString('utf8', p + 46, p + 46 + nameLen), size]);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Sum of the central directory's uncompressed sizes; Infinity when the directory is unreadable. */
export function zipUncompressedSize(bytes: Buffer): number {
  const entries = zipEntries(bytes);
  if (!entries) return Infinity;
  return entries.reduce((sum, [, size]) => sum + size, 0);
}

type Family = 'pdf' | 'docx' | 'xlsx' | 'image' | 'text' | null;

function declaredFamily(mime: string): Family {
  const m = mime.split(';')[0].trim().toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m === DOCX_MIME) return 'docx';
  if (m === XLSX_MIME) return 'xlsx';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('text/') || m === 'application/json') return 'text';
  return null;
}

export function sniff(bytes: Buffer, declaredMime: string, filename: string): { type: DocType; mime: string } {
  const ext = extensionOf(filename);
  const declared = declaredMime.split(';')[0].trim().toLowerCase();
  let found: { type: DocType; mime: string };

  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    found = { type: 'pdf', mime: 'application/pdf' };
  } else if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const names = (zipEntries(bytes) ?? []).map(([n]) => n);
    if (names.includes('word/document.xml')) found = { type: 'docx', mime: DOCX_MIME };
    else if (names.includes('xl/workbook.xml')) found = { type: 'xlsx', mime: XLSX_MIME };
    else found = { type: 'zip', mime: 'application/zip' };
  } else if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    found = { type: 'image', mime: 'image/png' };
  } else if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    found = { type: 'image', mime: 'image/jpeg' };
  } else if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    found = { type: 'image', mime: 'image/gif' };
  } else if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    found = { type: 'image', mime: 'image/webp' };
  } else if (isUtf8Text(bytes) && (declaredFamily(declared) === 'text' || ext in TEXT_EXTENSIONS)) {
    const mime = ext in TEXT_EXTENSIONS ? TEXT_EXTENSIONS[ext] : TEXT_MIMES.has(declared) ? declared : 'text/plain';
    found = { type: 'text', mime };
  } else {
    found = { type: 'binary', mime: 'application/octet-stream' };
  }

  const family = declaredFamily(declared);
  const mismatch = () => new ContentMismatch(`declared ${declared} but the content is ${found.type}`);
  if (family === 'pdf' && found.type !== 'pdf') throw mismatch();
  if ((family === 'docx' || family === 'xlsx') && found.type !== family) throw mismatch();
  // image/* declared: text bytes contradict it; other unrecognised binary (bmp, tiff) is stored as binary.
  if (family === 'image' && found.type !== 'image' && (found.type !== 'binary' || isUtf8Text(bytes))) throw mismatch();
  if (family === 'text' && found.type !== 'text') throw mismatch();
  return found;
}
