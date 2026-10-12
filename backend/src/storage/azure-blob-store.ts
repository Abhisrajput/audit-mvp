import { BlobSASPermissions, BlobServiceClient, StorageSharedKeyCredential, type ContainerClient } from '@azure/storage-blob';
import type { Readable } from 'node:stream';
import { assertSha256, attachmentDisposition, blobKey, BlobNotFound, sha256Of, STORED_CONTENT_TYPE, type BlobStore, type DownloadHeaders } from './blob-store';

type AzureError = { statusCode?: number; code?: string; details?: { errorCode?: string } };

const errorCode = (err: unknown) => {
  const e = err as AzureError;
  return e.code ?? e.details?.errorCode;
};

/** A missing blob, and only that: ContainerNotFound, AuthorizationFailure and the like are failures. */
const isMissingBlob = (err: unknown) => errorCode(err) === 'BlobNotFound';

/** The bytes are already stored: a conditional upload (If-None-Match: *) found an existing blob. */
const isAlreadyStored = (err: unknown) => {
  const e = err as AzureError;
  return errorCode(err) === 'BlobAlreadyExists' || e.statusCode === 409 || e.statusCode === 412;
};

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

  async put(bytes: Buffer, _meta: { mime: string }): Promise<{ sha256: string; size: number }> {
    const sha256 = sha256Of(bytes);
    try {
      await this.blob(sha256).uploadData(bytes, { blobHTTPHeaders: { blobContentType: STORED_CONTENT_TYPE }, conditions: { ifNoneMatch: '*' } });
    } catch (err) {
      if (!isAlreadyStored(err)) throw err;
    }
    return { sha256, size: bytes.length };
  }

  async get(sha256: string): Promise<Readable> {
    const blob = this.blob(sha256);
    try {
      const res = await blob.download();
      // The SDK's body is a Node Readable; returning it directly means destroying it closes the HTTP response.
      if (!res.readableStreamBody) throw new Error(`Azure returned no body for ${sha256}`);
      return res.readableStreamBody as Readable;
    } catch (err) {
      if (isMissingBlob(err)) throw new BlobNotFound(sha256);
      throw err;
    }
  }

  async head(sha256: string): Promise<{ size: number } | null> {
    const blob = this.blob(sha256);
    try {
      return { size: Number((await blob.getProperties()).contentLength ?? 0) };
    } catch (err) {
      if (isMissingBlob(err)) return null;
      throw err;
    }
  }

  async presignedGet(sha256: string, ttlSeconds: number, download: DownloadHeaders): Promise<string | null> {
    const blob = this.blob(sha256);
    // SAS needs an account key; with managed identity, download through the API instead.
    if (!(blob.credential instanceof StorageSharedKeyCredential)) return null;
    return blob.generateSasUrl({
      permissions: BlobSASPermissions.parse('r'), expiresOn: new Date(Date.now() + ttlSeconds * 1000),
      contentType: download.contentType, contentDisposition: attachmentDisposition(download.filename),
    });
  }
}
