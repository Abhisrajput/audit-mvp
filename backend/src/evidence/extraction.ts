import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../db/schema';
import type { Executor } from '../db/trail-repo';
import type { User } from '../engine/types';
import { AppError } from '../errors';
import { setDocumentText, type DocumentRecord } from '../knowledge/document-repo';
import { recordExtractionEvent } from '../knowledge/trail';
import { logger } from '../observability/log';
import { BlobNotFound, sha256Of, type BlobStore } from '../storage/blob-store';
import { MAX_TEXT_CHARS, type EvidenceConfig } from './config';
import { EXTRACTORS, NoTextLayer, type Extracted } from './extract';
import { insertExtraction, type ExtractionRow, type ExtractionStatus } from './extraction-repo';
import { ContentMismatch, sniff, zipUncompressedSize } from './sniff';

const NO_EXTRACTOR = { name: 'none', version: '1' };
const TRUNCATED = '\n\n[truncated]';

export interface ExtractionDeps {
  db: Executor;
  blobs: BlobStore;
  config: EvidenceConfig;
}

async function readAll(blobs: BlobStore, sha256: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of await blobs.get(sha256)) parts.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(parts);
}

/**
 * Races the extractor against a timer. This bounds the request, not the parser: a parser stuck in synchronous
 * code or a slow promise keeps running after we answer 'failed', and its result is discarded.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Extraction timed out after ${ms} ms`)), ms);
  });
  work.catch(() => undefined); // a late failure after the timeout must not become an unhandled rejection
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Cuts at the last paragraph break before the limit (or at the limit when there is none) and marks the cut. */
function truncate(x: Extracted): Extracted {
  if (x.text.length <= MAX_TEXT_CHARS) return x;
  const para = x.text.lastIndexOf('\n\n', MAX_TEXT_CHARS - 1);
  const cut = para > 0 ? para : MAX_TEXT_CHARS;
  return { ...x, text: x.text.slice(0, cut) + TRUNCATED, pageStarts: x.pageStarts?.filter((p) => p < cut) ?? null };
}

type Outcome = { status: ExtractionStatus; extractor: { name: string; version: string }; chars: number; pages: number | null; error: string | null; extracted?: Extracted };

async function attempt(deps: ExtractionDeps, doc: DocumentRecord, given?: Buffer): Promise<Outcome> {
  const { config } = deps;
  const base = { extractor: NO_EXTRACTOR, chars: 0, pages: null, error: null };
  const failed = (err: unknown, extractor = NO_EXTRACTOR): Outcome => ({ ...base, status: 'failed', extractor, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });

  if (doc.size > config.extractMaxBytes) return { ...base, status: 'too_large' };
  let bytes = given;
  if (!bytes) {
    try {
      bytes = await readAll(deps.blobs, doc.sha256);
    } catch (err) {
      // The driver's message can carry endpoint, bucket or credential detail; the row is append-only and served by the API.
      logger.error({ err, documentId: doc.id, notFound: err instanceof BlobNotFound }, 'Stored file could not be read for extraction');
      return failed(new Error('Stored file could not be read'));
    }
  }
  if (bytes.length > config.extractMaxBytes) return { ...base, status: 'too_large' };

  let type: ReturnType<typeof sniff>['type'];
  try {
    type = sniff(bytes, doc.mime, doc.filename).type;
  } catch (err) {
    if (err instanceof ContentMismatch) return failed(err);
    throw err;
  }
  const extractor = EXTRACTORS[type];
  if (!extractor) return { ...base, status: 'unsupported' };
  const identity = { name: extractor.name, version: extractor.version };
  if ((type === 'docx' || type === 'xlsx') && zipUncompressedSize(bytes) > config.zipMaxUncompressedBytes) return { ...base, status: 'too_large', extractor: identity };

  try {
    const raw = await withTimeout(extractor.extract(bytes), config.extractTimeoutMs);
    // Nothing but whitespace is no text at all: record it as such so the document stays retryable.
    if (!/\S/.test(raw.text)) return { ...base, status: 'no_text', extractor: identity };
    // chars records the length before any cut, so a truncated document shows how much was left out.
    return { status: 'ok', extractor: identity, chars: raw.text.length, pages: raw.pages, error: null, extracted: truncate(raw) };
  } catch (err) {
    if (err instanceof NoTextLayer) return { ...base, status: 'no_text', extractor: identity };
    return failed(err, identity);
  }
}

/**
 * Turns a registered document's stored bytes into text and chunks, or records why it could not. The bytes come from
 * the blob store unless the caller already holds them (an upload in hand), in which case they must hash to the
 * document's sha256: text may derive only from the bytes the registry names. The row, the text, its chunks and the
 * trail entry commit together, so a failure leaves nothing half-written.
 */
export async function runExtraction(deps: ExtractionDeps, doc: DocumentRecord, actor: User, opts: { bytes?: Buffer } = {}): Promise<ExtractionRow> {
  if (opts.bytes && sha256Of(opts.bytes) !== doc.sha256) throw new AppError(400, `The bytes do not match document ${doc.id}: SHA-256 hash differs from the registered one`);
  const out = await attempt(deps, doc, opts.bytes);
  const write = async (trx: Transaction<DB>) => {
    let chunks = 0;
    if (out.status === 'ok' && out.extracted) {
      chunks = await setDocumentText(trx, doc, { extractor: out.extractor.name, extractorVersion: out.extractor.version, text: out.extracted.text, pageStarts: out.extracted.pageStarts ?? undefined });
    }
    const row = await insertExtraction(trx, {
      documentId: doc.id, extractor: out.extractor.name, extractorVersion: out.extractor.version, status: out.status, chars: out.chars, pages: out.pages, error: out.error, by: actor.id,
    });
    await recordExtractionEvent(trx, actor, doc, row, chunks);
    return row;
  };
  try {
    return await (deps.db.isTransaction ? write(deps.db as Transaction<DB>) : (deps.db as Kysely<DB>).transaction().execute(write));
  } catch (err) {
    // Two attempts drew the same number: the UNIQUE (document_id, attempt) key lets only one commit.
    if ((err as { code?: string }).code === '23505' && String((err as { constraint?: string }).constraint ?? 'document_extractions').includes('document_extractions')) {
      throw new AppError(409, 'Another extraction of this document is in progress', 'CONFLICT');
    }
    throw err;
  }
}
