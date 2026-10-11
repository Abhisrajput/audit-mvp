import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { assertSha256, attachmentDisposition, blobKey, BlobNotFound, sha256Of, STORED_CONTENT_TYPE, type BlobStore, type DownloadHeaders } from './blob-store';

export interface S3Options {
  bucket: string;
  region: string;
  /** For SeaweedFS or other S3-compatible services; omit for AWS. */
  endpoint?: string;
  forcePathStyle: boolean;
  /** Omit to use the standard AWS credential chain (environment, profile, instance role). */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /**
   * The service honours `If-None-Match: *` on PUT (AWS S3 does). SeaweedFS 3.80 silently ignores it and
   * overwrites, so for it set false: put then checks for the object first (still sending the condition).
   */
  conditionalWrites?: boolean;
}

type S3Error = { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };

/** A missing object, and only that: NoSuchBucket, AccessDenied and the like are failures, not "not found". */
const isMissingObject = (err: unknown) => {
  const e = err as S3Error;
  return e.name === 'NoSuchKey' || e.Code === 'NoSuchKey';
};

/** The bytes are already stored: a conditional PUT (If-None-Match: *) found an existing object. */
const isAlreadyStored = (err: unknown) => {
  const e = err as S3Error;
  const status = e.$metadata?.httpStatusCode;
  return e.name === 'PreconditionFailed' || e.name === 'ConditionalRequestConflict' || status === 412 || status === 409;
};

/**
 * AWS S3 or any S3-compatible store. Enable Object Lock on the bucket for write-once retention.
 * Needs s3:GetObject, s3:PutObject and s3:ListBucket (the last so a missing object is a 404, not a 403).
 */
export class S3BlobStore implements BlobStore {
  readonly driver = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly opts: S3Options) {
    this.client = new S3Client({ region: opts.region, endpoint: opts.endpoint, forcePathStyle: opts.forcePathStyle, credentials: opts.credentials, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  }

  async put(bytes: Buffer, _meta: { mime: string }): Promise<{ sha256: string; size: number }> {
    const sha256 = sha256Of(bytes);
    if (this.opts.conditionalWrites === false && (await this.head(sha256))) return { sha256, size: bytes.length };
    try {
      // Conditional write: never replaces an existing object (with Object Lock, a rewrite would add a version for nothing).
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.opts.bucket, Key: blobKey(sha256), Body: bytes, ContentType: STORED_CONTENT_TYPE, IfNoneMatch: '*',
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
        }),
      );
    } catch (err) {
      if (!isAlreadyStored(err)) throw err;
    }
    return { sha256, size: bytes.length };
  }

  async get(sha256: string): Promise<Readable> {
    assertSha256(sha256);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: blobKey(sha256) }));
      return res.Body as Readable;
    } catch (err) {
      if (!isMissingObject(err)) throw err;
      // Some S3-compatible services (SeaweedFS 3.80) answer NoSuchKey for a missing bucket too.
      await this.bucketExists();
      throw new BlobNotFound(sha256);
    }
  }

  async head(sha256: string): Promise<{ size: number } | null> {
    assertSha256(sha256);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: blobKey(sha256) }));
      return { size: Number(res.ContentLength ?? 0) };
    } catch (err) {
      const e = err as S3Error;
      if (e.name !== 'NotFound' && e.$metadata?.httpStatusCode !== 404) throw err;
      // A HEAD response has no body, so a missing bucket also looks like 404 NotFound. Tell them apart (only on a miss).
      await this.bucketExists();
      return null;
    }
  }

  /** Throws (NotFound / Forbidden) unless the bucket exists and is reachable. */
  private async bucketExists() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
  }

  async presignedGet(sha256: string, ttlSeconds: number, download: DownloadHeaders): Promise<string | null> {
    assertSha256(sha256);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.opts.bucket, Key: blobKey(sha256),
        ResponseContentType: download.contentType, ResponseContentDisposition: attachmentDisposition(download.filename),
      }),
      { expiresIn: ttlSeconds },
    );
  }
}
