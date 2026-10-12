import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError } from '../errors';

/**
 * Content-addressed object storage. An object's key is its own SHA-256, so
 * every stored file carries proof it is unchanged and duplicates are stored once.
 */
export interface BlobStore {
  readonly driver: 'local' | 's3' | 'azure';
  /**
   * Stores the bytes once (idempotent, atomic where the backend allows). Objects are always stored as
   * application/octet-stream: the uploader's Content-Type is never persisted. `meta.mime` is informational.
   */
  put(bytes: Buffer, meta: { mime: string }): Promise<{ sha256: string; size: number }>;
  /** Throws BlobNotFound only for a missing object; a missing bucket/container or a denied request throws the driver error. */
  get(sha256: string): Promise<Readable>;
  /** null only for a missing object; any other failure throws. */
  head(sha256: string): Promise<{ size: number } | null>;
  /**
   * A time-limited download URL that makes the storage service answer with the given Content-Type and an
   * attachment Content-Disposition, or null when downloads must stream through the API.
   */
  presignedGet(sha256: string, ttlSeconds: number, download: DownloadHeaders): Promise<string | null>;
}

export interface DownloadHeaders {
  contentType: string;
  filename: string;
}

/** What every stored object is labelled as; the API decides the served type per request. */
export const STORED_CONTENT_TYPE = 'application/octet-stream';

/** An ASCII-only filename with no quotes, line breaks or path separators. */
export const asciiFilename = (name: string) => name.replace(/[^\w.\- ]+/g, '_').slice(0, 150) || 'document';

/** RFC 8187 percent-encoding (encodeURIComponent leaves ' ( ) * unescaped). */
const rfc8187 = (value: string) => encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `attachment; filename="<ascii>"; filename*=UTF-8''<pct-encoded original>` */
export const attachmentDisposition = (filename: string) => `attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${rfc8187(filename.slice(0, 255))}`;

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
