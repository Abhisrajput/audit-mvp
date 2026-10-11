import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError } from '../errors';

/**
 * Content-addressed object storage. An object's key is its own SHA-256, so
 * every stored file carries proof it is unchanged and duplicates are stored once.
 */
export interface BlobStore {
  readonly driver: 'local' | 's3' | 'azure';
  put(bytes: Buffer, meta: { mime: string }): Promise<{ sha256: string; size: number }>;
  /** Throws BlobNotFound for an unknown object. */
  get(sha256: string): Promise<Readable>;
  head(sha256: string): Promise<{ size: number } | null>;
  /** A time-limited download URL, or null when downloads must stream through the API. */
  presignedGet(sha256: string, ttlSeconds: number): Promise<string | null>;
}

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class BlobNotFound extends Error {
  constructor(sha256: string) {
    super(`Blob ${sha256} not found`);
    this.name = 'BlobNotFound';
  }
}

/** Accepts only a lowercase hex SHA-256; anything else (including path tricks) is a 400 before any storage call. */
export function assertSha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) throw new AppError(400, 'Not a SHA-256 content hash');
  return value;
}

export const blobKey = (sha256: string) => `sha256/${sha256.slice(0, 2)}/${sha256}`;

export const sha256Of = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
