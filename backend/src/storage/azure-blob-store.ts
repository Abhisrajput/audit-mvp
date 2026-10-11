import { BlobSASPermissions, BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { Readable } from 'node:stream';
import { assertSha256, blobKey, BlobNotFound, sha256Of, type BlobStore } from './blob-store';

const isNotFound = (err: unknown) => (err as { statusCode?: number }).statusCode === 404;

/** Azure Blob Storage. Configure time-based retention (immutability) on the container for write-once retention. */
export class AzureBlobStore implements BlobStore {
  readonly driver = 'azure' as const;
  private readonly container: ContainerClient;

  constructor(opts: { connectionString: string; container: string }) {
    this.container = BlobServiceClient.fromConnectionString(opts.connectionString).getContainerClient(opts.container);
  }

  private blob(sha256: string) {
    return this.container.getBlockBlobClient(blobKey(assertSha256(sha256)));
  }

  async put(bytes: Buffer, meta: { mime: string }): Promise<{ sha256: string; size: number }> {
    const sha256 = sha256Of(bytes);
    const blob = this.blob(sha256);
    if (!(await blob.exists())) await blob.uploadData(bytes, { blobHTTPHeaders: { blobContentType: meta.mime } });
    return { sha256, size: bytes.length };
  }

  async get(sha256: string): Promise<Readable> {
    try {
      const res = await this.blob(sha256).download();
      return Readable.from(res.readableStreamBody as AsyncIterable<Buffer>);
    } catch (err) {
      if (isNotFound(err)) throw new BlobNotFound(sha256);
      throw err;
    }
  }

  async head(sha256: string): Promise<{ size: number } | null> {
    try {
      return { size: Number((await this.blob(sha256).getProperties()).contentLength ?? 0) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async presignedGet(sha256: string, ttlSeconds: number): Promise<string | null> {
    try {
      return await this.blob(sha256).generateSasUrl({ permissions: BlobSASPermissions.parse('r'), expiresOn: new Date(Date.now() + ttlSeconds * 1000) });
    } catch {
      // SAS needs an account key; with managed identity, download through the API instead.
      return null;
    }
  }
}
