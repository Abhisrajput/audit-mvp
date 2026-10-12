import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { assertSha256, blobKey, BlobNotFound, sha256Of, type BlobStore } from './blob-store';

const isEnoent = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT';

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
    if (!(await this.head(sha256))) {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      // Write to a temporary name, then rename, so a reader never sees a half-written object.
      const tmp = `${target}.tmp-${crypto.randomBytes(6).toString('hex')}`;
      try {
        await fs.promises.writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
        await fs.promises.rename(tmp, target);
      } catch (err) {
        await fs.promises.rm(tmp, { force: true });
        throw err;
      }
    }
    return { sha256, size: bytes.length };
  }

  async get(sha256: string): Promise<Readable> {
    const file = this.file(sha256);
    // Open first, so a missing file is BlobNotFound and anything else (permissions, a broken folder) throws as is.
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(file, 'r');
    } catch (err) {
      if (isEnoent(err)) throw new BlobNotFound(sha256);
      throw err;
    }
    return handle.createReadStream();
  }

  async head(sha256: string): Promise<{ size: number } | null> {
    const file = this.file(sha256);
    try {
      return { size: (await fs.promises.stat(file)).size };
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async presignedGet(sha256: string): Promise<string | null> {
    assertSha256(sha256);
    return null;
  }
}
