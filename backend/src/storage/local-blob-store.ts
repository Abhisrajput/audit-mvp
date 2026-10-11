import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { assertSha256, blobKey, BlobNotFound, sha256Of, type BlobStore } from './blob-store';

/** A folder on disk. Development and tests only — production uses S3 or Azure Blob. */
export class LocalBlobStore implements BlobStore {
  readonly driver = 'local' as const;

  constructor(private readonly dir: string) {}

  private file(sha256: string) {
    return path.join(this.dir, blobKey(assertSha256(sha256)));
  }

  async put(bytes: Buffer): Promise<{ sha256: string; size: number }> {
    const sha256 = sha256Of(bytes);
    const target = this.file(sha256);
    if (!fs.existsSync(target)) {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      // Write to a temporary name, then rename, so a reader never sees a half-written object.
      const tmp = `${target}.tmp-${crypto.randomBytes(6).toString('hex')}`;
      await fs.promises.writeFile(tmp, bytes, { flag: 'wx' });
      await fs.promises.rename(tmp, target);
    }
    return { sha256, size: bytes.length };
  }

  async get(sha256: string): Promise<Readable> {
    const file = this.file(sha256);
    if (!fs.existsSync(file)) throw new BlobNotFound(sha256);
    return fs.createReadStream(file);
  }

  async head(sha256: string): Promise<{ size: number } | null> {
    const file = this.file(sha256);
    try {
      return { size: (await fs.promises.stat(file)).size };
    } catch {
      return null;
    }
  }

  async presignedGet(): Promise<string | null> {
    return null;
  }
}
