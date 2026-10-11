import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { assertSha256, blobKey, BlobNotFound, sha256Of, type BlobStore } from './blob-store';

export interface S3Options {
  bucket: string;
  region: string;
  /** For MinIO or other S3-compatible services; omit for AWS. */
  endpoint?: string;
  forcePathStyle: boolean;
  /** Omit to use the standard AWS credential chain (environment, profile, instance role). */
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

const isNotFound = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
};

/** AWS S3 or any S3-compatible store. Enable Object Lock on the bucket for write-once retention. */
export class S3BlobStore implements BlobStore {
  readonly driver = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly opts: S3Options) {
    this.client = new S3Client({ region: opts.region, endpoint: opts.endpoint, forcePathStyle: opts.forcePathStyle, credentials: opts.credentials });
  }

  async put(bytes: Buffer, meta: { mime: string }): Promise<{ sha256: string; size: number }> {
    const sha256 = sha256Of(bytes);
    // Skip existing objects: with Object Lock, rewriting would add a version for nothing.
    if (!(await this.head(sha256))) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.opts.bucket, Key: blobKey(sha256), Body: bytes, ContentType: meta.mime,
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
        }),
      );
    }
    return { sha256, size: bytes.length };
  }

  async get(sha256: string): Promise<Readable> {
    assertSha256(sha256);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: blobKey(sha256) }));
      return res.Body as Readable;
    } catch (err) {
      if (isNotFound(err)) throw new BlobNotFound(sha256);
      throw err;
    }
  }

  async head(sha256: string): Promise<{ size: number } | null> {
    assertSha256(sha256);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: blobKey(sha256) }));
      return { size: Number(res.ContentLength ?? 0) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async presignedGet(sha256: string, ttlSeconds: number): Promise<string | null> {
    assertSha256(sha256);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.opts.bucket, Key: blobKey(sha256) }), { expiresIn: ttlSeconds });
  }
}
