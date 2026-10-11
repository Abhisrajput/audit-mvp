import path from 'node:path';
import { z } from 'zod';
import { AzureBlobStore } from './azure-blob-store';
import type { BlobStore } from './blob-store';
import { LocalBlobStore } from './local-blob-store';
import { S3BlobStore } from './s3-blob-store';

interface Common {
  /** Largest upload accepted, in bytes. */
  maxBytes: number;
  /** Hand out presigned download URLs (only when the storage endpoint is reachable from browsers). */
  presignDownloads: boolean;
}

export type StorageConfig =
  | (Common & { driver: 'local'; dir: string })
  | (Common & { driver: 's3'; bucket: string; region: string; endpoint?: string; forcePathStyle: boolean; credentials?: { accessKeyId: string; secretAccessKey: string }; conditionalWrites: boolean })
  | (Common & { driver: 'azure'; connectionString: string; container: string });

/** Uploads are hashed in memory; larger evidence waits for streaming uploads (evidence sub-project). */
const MAX_PRODUCTION_UPLOAD_BYTES = 100 * 1024 * 1024;

const flag = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    BLOB_DRIVER: z.enum(['local', 's3', 'azure']).default('local'),
    BLOB_LOCAL_DIR: z.string().min(1).default(path.resolve(__dirname, '../../data/blobs')),
    BLOB_MAX_BYTES: z.coerce.number().int().min(1).default(25 * 1024 * 1024),
    BLOB_PRESIGN_DOWNLOADS: flag,
    S3_BUCKET: z.string().min(1).optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_FORCE_PATH_STYLE: flag,
    // false only for services that ignore If-None-Match on PUT (SeaweedFS 3.80); AWS S3 honours it.
    S3_CONDITIONAL_WRITES: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    AZURE_STORAGE_CONNECTION_STRING: z.string().min(1).optional(),
    AZURE_STORAGE_CONTAINER: z.string().min(1).default('evidence'),
  })
  .superRefine((e, ctx) => {
    if (e.BLOB_DRIVER === 'local' && e.NODE_ENV === 'production') {
      ctx.addIssue({ code: 'custom', path: ['BLOB_DRIVER'], message: 'BLOB_DRIVER=local is for development only; use s3 or azure in production' });
    }
    if (e.BLOB_DRIVER === 's3' && !e.S3_BUCKET) ctx.addIssue({ code: 'custom', path: ['S3_BUCKET'], message: 'S3_BUCKET is required when BLOB_DRIVER=s3' });
    if (e.BLOB_DRIVER === 'azure' && !e.AZURE_STORAGE_CONNECTION_STRING) {
      ctx.addIssue({ code: 'custom', path: ['AZURE_STORAGE_CONNECTION_STRING'], message: 'AZURE_STORAGE_CONNECTION_STRING is required when BLOB_DRIVER=azure' });
    }
    if (Boolean(e.S3_ACCESS_KEY_ID) !== Boolean(e.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['S3_ACCESS_KEY_ID'], message: 'Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither (to use the AWS credential chain)' });
    }
    if (e.NODE_ENV === 'production') {
      if (e.BLOB_DRIVER === 's3' && e.S3_ENDPOINT && !e.S3_ENDPOINT.toLowerCase().startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['S3_ENDPOINT'], message: 'S3_ENDPOINT must use https:// in production' });
      }
      if (e.BLOB_DRIVER === 'azure' && /UseDevelopmentStorage|devstoreaccount/i.test(e.AZURE_STORAGE_CONNECTION_STRING ?? '')) {
        ctx.addIssue({ code: 'custom', path: ['AZURE_STORAGE_CONNECTION_STRING'], message: 'The Azurite emulator account is for development only' });
      }
      if (e.BLOB_MAX_BYTES > MAX_PRODUCTION_UPLOAD_BYTES) {
        ctx.addIssue({ code: 'custom', path: ['BLOB_MAX_BYTES'], message: 'BLOB_MAX_BYTES may be at most 100 MiB (uploads are held in memory)' });
      }
    }
  });

export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = Env.safeParse(present);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const e = parsed.data;
  const common = { maxBytes: e.BLOB_MAX_BYTES, presignDownloads: e.BLOB_PRESIGN_DOWNLOADS };
  if (e.BLOB_DRIVER === 's3') {
    const credentials = e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY } : undefined;
    return { ...common, driver: 's3', bucket: e.S3_BUCKET!, region: e.S3_REGION, endpoint: e.S3_ENDPOINT, forcePathStyle: e.S3_FORCE_PATH_STYLE, credentials, conditionalWrites: e.S3_CONDITIONAL_WRITES };
  }
  if (e.BLOB_DRIVER === 'azure') return { ...common, driver: 'azure', connectionString: e.AZURE_STORAGE_CONNECTION_STRING!, container: e.AZURE_STORAGE_CONTAINER };
  return { ...common, driver: 'local', dir: e.BLOB_LOCAL_DIR };
}

export function createBlobStore(cfg: StorageConfig): BlobStore {
  if (cfg.driver === 's3') return new S3BlobStore(cfg);
  if (cfg.driver === 'azure') return new AzureBlobStore(cfg);
  return new LocalBlobStore(cfg.dir);
}
