import { z } from 'zod';

/** Longest text kept for one document, in characters; longer text is cut at a paragraph and marked [truncated]. */
export const MAX_TEXT_CHARS = 900_000;

export interface EvidenceConfig {
  /** Largest file the server will try to extract, in bytes. */
  extractMaxBytes: number;
  /** How long a registration request waits for an extractor. */
  extractTimeoutMs: number;
  /** A zip-based file (docx, xlsx) whose entries would inflate past this is refused before parsing. */
  zipMaxUncompressedBytes: number;
  /** Default retention for new evidence, in years; null means none is applied. */
  retentionYears: number | null;
}

const DEFAULT_EXTRACT_MAX_BYTES = 25 * 1024 * 1024;

const Env = z.object({
  EXTRACT_MAX_BYTES: z.coerce.number().int().min(1).optional(),
  EXTRACT_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),
  ZIP_MAX_UNCOMPRESSED_BYTES: z.coerce.number().int().min(1).default(268_435_456),
  EVIDENCE_RETENTION_YEARS: z.coerce.number().int().min(1).max(100).optional(),
});

export function loadEvidenceConfig(env: NodeJS.ProcessEnv = process.env, storage?: { maxBytes: number }): EvidenceConfig {
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = Env.safeParse(present);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const e = parsed.data;
  return {
    extractMaxBytes: e.EXTRACT_MAX_BYTES ?? storage?.maxBytes ?? DEFAULT_EXTRACT_MAX_BYTES,
    extractTimeoutMs: e.EXTRACT_TIMEOUT_MS,
    zipMaxUncompressedBytes: e.ZIP_MAX_UNCOMPRESSED_BYTES,
    retentionYears: e.EVIDENCE_RETENTION_YEARS ?? null,
  };
}
