# Foundation 1D — Storage, Document Registry and Permission-Filtered Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store files content-addressed in S3-compatible storage, Azure Blob or a local folder; register them as documents with a classification and an optional engagement; index their text into chunks; and search those chunks so that nobody ever gets back content they are not allowed to read.

**Architecture:**
- **One storage interface, three implementations.** A `BlobStore` interface is implemented for local disk, S3 (AWS, MinIO, GCS interop) and Azure Blob, and chosen by `BLOB_DRIVER`. Objects are keyed by their own SHA-256, so storing the same file twice stores it once.
- **Document registry.** The `documents` registry (never deleted), `document_text` and `chunks` live in Postgres.
  - `chunks` carries a generated `tsvector` for full-text search.
  - It also has a nullable `embedding vector` column (pgvector) for the knowledge-store sub-project.
  - Each chunk copies its document's `classification` and `engagement_id`, so permission filtering happens inside the SQL query.
- **Retrieval.** A `Retriever` interface with a Postgres full-text implementation filters by:
  - the requesting user's role (which classifications they may read)
  - engagement scope (global documents plus the requested engagement's own)
  - retention

  It returns hits with a document/page citation.
- **HTTP API.** Upload a blob, register it (optionally with its text), list, fetch and download documents, and search. Every registration is sealed into the audit trail.

**Tech Stack:** Node 22, TypeScript, Express 5, Kysely + Postgres 16 + pgvector, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, `@azure/storage-blob`, PGlite with `@electric-sql/pglite-pgvector` (eval only); vitest + Testcontainers (Postgres, `@testcontainers/minio`, Azurite).

**Spec:** `docs/superpowers/specs/2026-10-11-production-foundation-design.md`:
- §5.1 BlobStore
- §5.2 document registry
- §6.5 Retriever
- §11 REQ-23

Builds on 1A–1C; this plan's branch is `design/foundation-1d-storage`, stacked on `design/foundation-1c-signing`.

## Global Constraints

- Builds on 1A–1C. Kysely for queries; plain SQL migrations in `backend/migrations/`; never migrate on start-up. Add `005_documents.sql`; never edit `001`–`004`.
- Objects are content-addressed at the key `sha256/<first 2 hex>/<sha256>`. `put` is idempotent: the same bytes produce the same key, and nothing is written twice.
- A SHA-256 is accepted from the outside only if it matches `^[a-f0-9]{64}$`. Anything else is rejected before any storage call, which also prevents path traversal in the local store.
- `BLOB_DRIVER` is `local` | `s3` | `azure`. `local` is for development and tests only, and the server refuses it with `NODE_ENV=production`.
- Document `kind` is one of `evidence`, `sop`, `policy`, `prior_report`, `regulation`, `okf_concept`, `other`. Classification is one of `internal`, `confidential`, `restricted`. Documents are never deleted (database trigger); retention is flagged with `retention_expired`.
- Who may read which classification:

  | Role | May read |
  |---|---|
  | `viewer` | `internal` |
  | `auditor` | `internal`, `confidential` |
  | `audit_manager`, `cae` | `internal`, `confidential`, `restricted` |
  | `admin` | nothing (1B: no audit content) |

  Filtering happens in SQL, before anything is returned.
- Engagement scope:
  - A search or listing for an engagement returns global documents (`engagement_id IS NULL`) plus that engagement's documents, never another engagement's.
  - A search without an engagement returns global documents only.
- A document the user may not read is answered with `404`, exactly as if it did not exist.
- Every document registration is trailed (`document:register`) in the same transaction as the registry rows.
- Chunks are paragraph-aligned and about **1,200 characters**. Each carries the page it starts on when page offsets are known.
- Tests keep `[REQ-xx]` tags; `npm run eval` stays 25/25. `validation/requirements.json` changes only by adding REQ-23.
- No secrets are committed:
  - Test containers get random credentials generated in the test.
  - Compose reads `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` from the git-ignored `.env`.
  - *Note (during 1D):* MinIO was superseded by SeaweedFS (S3-compatible) in Compose and tests, because MinIO community images are no longer pullable; Compose reads `S3_ROOT_ACCESS_KEY`/`S3_ROOT_SECRET_KEY` instead.
- Every commit message ends with a `Co-Authored-By:` trailer naming the model that wrote it.

**Deliberate refinements of the spec (1D):**
- **`BlobStore.put` takes a `Buffer`, not a stream.** Uploads are size-capped (`BLOB_MAX_BYTES`, default 25 MiB) and hashed in memory. Streaming uploads for large evidence come with the evidence sub-project.
- **`presignedGet` returns `string | null`.** The local store returns `null` and downloads stream through the API. Presigned downloads are used only when `BLOB_PRESIGN_DOWNLOADS=true`, because inside Compose the MinIO address is not reachable from the browser.
- **The pack retriever stays where it is.** The spec's `PackBm25Retriever` keeps living inside the engine's existing grounding index until plan 1E moves packs into the knowledge graph. 1D adds the `Retriever` interface and the Postgres full-text implementation.
- **Engagement membership.** Every reader may currently open every engagement, so the engagement filter enforces scoping, not membership. Per-engagement membership arrives with the planning sub-project, and the filter is the place it will plug in.
- **Text comes from the caller.** Registering a document may include its text (up to 900,000 characters). Extracting text from PDF, DOCX and XLSX is the evidence sub-project's job.
- **Search isn't trailed.** Library searches made through the API are not trailed, because they would flood the chain. Module runs keep recording their own retrieval sets (1A).

## Review Focus

1. **A crafted SHA such as `../../etc/passwd` or `..%2F` sent to download or registration.** It's rejected before any file-system or storage call. Pinned in Tasks 1 and 4.
2. **The same file uploaded twice by two people.** One stored object and two registry rows, each with its own classification and owner. Pinned in Tasks 1 and 4.
3. **A restricted document whose words match a viewer's search.** No hit and no snippet. The text never leaves the database. Pinned in Task 3.
4. **Engagement A's evidence searched from engagement B.** Never returned. Pinned in Task 3.
5. **Someone guessing a document id they may not read.** `404` on metadata and on download, the same as a missing id. Pinned in Task 4.

## File structure

| File | Responsibility |
|---|---|
| `backend/src/storage/blob-store.ts` | `BlobStore` interface, `blobKey`, `SHA256_PATTERN`, `assertSha256`, `sha256Of`, `BlobNotFound` |
| `backend/src/storage/local-blob-store.ts` | Local folder implementation (dev and tests) |
| `backend/src/storage/s3-blob-store.ts` | S3 / MinIO implementation |
| `backend/src/storage/azure-blob-store.ts` | Azure Blob implementation |
| `backend/src/storage/config.ts` | `loadStorageConfig()`, `createBlobStore()` |
| `backend/migrations/005_documents.sql` | `vector` extension; `documents`, `document_text`, `chunks` |
| `backend/src/db/schema.ts` | Kysely types for the three tables |
| `backend/src/db/pglite.ts` | Loads the pgvector extension into PGlite |
| `backend/src/knowledge/chunk.ts` | `chunkText()` |
| `backend/src/knowledge/access.ts` | Classifications, `CLASSIFICATIONS_BY_ROLE`, `mayRead()` |
| `backend/src/knowledge/document-repo.ts` | Insert, get and list documents; store text and chunks |
| `backend/src/knowledge/retriever.ts` | `Retriever`, `Hit`, `PgFtsRetriever` |
| `backend/src/knowledge/routes.ts` | Blob upload, document registry, download and search API |
| `backend/src/knowledge/trail.ts` | `recordDocumentEvent()` |
| `backend/src/app.ts`, `server.ts`, `errors.ts` | Wiring |
| Tests | `backend/tests/blob-stores.test.ts`, `documents.test.ts`, `retrieval.test.ts`, `documents-http.test.ts` |
| `docker-compose.yml`, `.env.example`, `backend/.env.example`, `README.md` | MinIO in Compose; docs |

---
### Task 1: Content-addressed blob storage — local, S3 and Azure

**Files:**
- Create: `backend/src/storage/blob-store.ts`, `backend/src/storage/local-blob-store.ts`, `backend/src/storage/s3-blob-store.ts`, `backend/src/storage/azure-blob-store.ts`, `backend/src/storage/config.ts`
- Modify: `backend/package.json`
- Test: `backend/tests/blob-stores.test.ts`

**Interfaces:**
- Consumes: nothing from earlier plans
- Produces (Tasks 4–5 rely on these):
  - `interface BlobStore { readonly driver: 'local' | 's3' | 'azure'; put(bytes: Buffer, meta: { mime: string }): Promise<{ sha256: string; size: number }>; get(sha256: string): Promise<Readable>; head(sha256: string): Promise<{ size: number } | null>; presignedGet(sha256: string, ttlSeconds: number): Promise<string | null> }`
  - `blobKey(sha256): string`
  - `SHA256_PATTERN`
  - `assertSha256(value): string` (throws `AppError(400)`)
  - `sha256Of(buf): string`
  - `class BlobNotFound extends Error`
  - `new LocalBlobStore(dir)`
  - `new S3BlobStore({ bucket, region, endpoint?, forcePathStyle, credentials? })`
  - `new AzureBlobStore({ connectionString, container })`
  - `type StorageConfig`
  - `loadStorageConfig(env?): StorageConfig`
  - `createBlobStore(cfg): BlobStore`

- [ ] **Step 1: Add the dependencies**

```bash
cd backend
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @azure/storage-blob
npm install -D @testcontainers/minio
```

- [ ] **Step 2: Write the failing tests** `backend/tests/blob-stores.test.ts`. The same contract runs against all three implementations; S3 and Azure run against real local emulators.

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { BlobServiceClient } from '@azure/storage-blob';
import { MinioContainer, type StartedMinioContainer } from '@testcontainers/minio';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AzureBlobStore } from '../src/storage/azure-blob-store';
import { blobKey, BlobNotFound, sha256Of, type BlobStore } from '../src/storage/blob-store';
import { loadStorageConfig } from '../src/storage/config';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { S3BlobStore } from '../src/storage/s3-blob-store';

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

/** The behaviour every BlobStore must have. */
function blobStoreContract(name: string, make: () => BlobStore, presigns: boolean) {
  describe(`${name} blob store`, () => {
    const bytes = Buffer.from('CCP temperature log, March 2026\n');

    it('stores bytes under their own SHA-256 and reads them back', async () => {
      const store = make();
      const put = await store.put(bytes, { mime: 'text/plain' });
      expect(put).toEqual({ sha256: sha256Of(bytes), size: bytes.length });
      expect(await readAll(await store.get(put.sha256))).toEqual(bytes);
      expect(await store.head(put.sha256)).toEqual({ size: bytes.length });
    });

    it('stores the same bytes once, however often they are put', async () => {
      const store = make();
      const a = await store.put(bytes, { mime: 'text/plain' });
      const b = await store.put(Buffer.from(bytes), { mime: 'application/octet-stream' });
      expect(b).toEqual(a);
    });

    it('reports unknown and malformed keys without touching storage', async () => {
      const store = make();
      const unknown = 'f'.repeat(64);
      expect(await store.head(unknown)).toBeNull();
      await expect(store.get(unknown)).rejects.toBeInstanceOf(BlobNotFound);
      for (const bad of ['../../etc/passwd', 'ABC', `${'a'.repeat(63)}/`, '']) {
        await expect(store.get(bad)).rejects.toMatchObject({ status: 400 });
        await expect(store.head(bad)).rejects.toMatchObject({ status: 400 });
      }
    });

    it(presigns ? 'gives a time-limited download URL' : 'streams downloads through the API instead of presigning', async () => {
      const store = make();
      const { sha256 } = await store.put(bytes, { mime: 'text/plain' });
      const url = await store.presignedGet(sha256, 60);
      if (!presigns) return expect(url).toBeNull();
      const res = await fetch(url!);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
    });
  });
}

describe('blob keys', () => {
  it('nests objects under the first two hex characters', () => {
    const sha = sha256Of(Buffer.from('x'));
    expect(blobKey(sha)).toBe(`sha256/${sha.slice(0, 2)}/${sha}`);
  });
});

const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-'));
blobStoreContract('local', () => new LocalBlobStore(localDir), false);

describe('local store layout', () => {
  it('writes objects at the content-addressed path', async () => {
    const store = new LocalBlobStore(localDir);
    const { sha256 } = await store.put(Buffer.from('layout'), { mime: 'text/plain' });
    expect(fs.existsSync(path.join(localDir, blobKey(sha256)))).toBe(true);
  });
});

let minio: StartedMinioContainer;
let s3Store: S3BlobStore;
beforeAll(async () => {
  const user = `u${crypto.randomBytes(6).toString('hex')}`;
  const password = crypto.randomBytes(18).toString('base64url');
  minio = await new MinioContainer('minio/minio:RELEASE.2024-11-07T00-52-20Z').withUsername(user).withPassword(password).start();
  const endpoint = `http://${minio.getHost()}:${minio.getPort()}`;
  const credentials = { accessKeyId: user, secretAccessKey: password };
  await new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials }).send(new CreateBucketCommand({ Bucket: 'evidence' }));
  s3Store = new S3BlobStore({ bucket: 'evidence', region: 'us-east-1', endpoint, forcePathStyle: true, credentials });
});
afterAll(() => minio?.stop());
blobStoreContract('s3 (MinIO)', () => s3Store, true);

let azurite: StartedTestContainer;
let azureStore: AzureBlobStore;
beforeAll(async () => {
  // A throwaway account with a random key, so no emulator key is committed.
  const account = 'audittest';
  const key = crypto.randomBytes(32).toString('base64');
  azurite = await new GenericContainer('mcr.microsoft.com/azure-storage/azurite:3.33.0')
    .withEnvironment({ AZURITE_ACCOUNTS: `${account}:${key}` })
    .withCommand(['azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck', '--loose'])
    .withExposedPorts(10000)
    .start();
  const connectionString = `DefaultEndpointsProtocol=http;AccountName=${account};AccountKey=${key};BlobEndpoint=http://${azurite.getHost()}:${azurite.getMappedPort(10000)}/${account};`;
  await BlobServiceClient.fromConnectionString(connectionString).getContainerClient('evidence').createIfNotExists();
  azureStore = new AzureBlobStore({ connectionString, container: 'evidence' });
});
afterAll(() => azurite?.stop());
blobStoreContract('azure (Azurite)', () => azureStore, true);

describe('storage configuration', () => {
  it('defaults to the local store and refuses it in production', () => {
    expect(loadStorageConfig({})).toMatchObject({ driver: 'local', maxBytes: 25 * 1024 * 1024, presignDownloads: false });
    expect(() => loadStorageConfig({ NODE_ENV: 'production' })).toThrow(/BLOB_DRIVER=local is for development only/);
    expect(loadStorageConfig({ BLOB_DRIVER: 's3', S3_BUCKET: 'b', S3_ENDPOINT: '', S3_FORCE_PATH_STYLE: 'true' })).toMatchObject({
      driver: 's3', bucket: 'b', region: 'us-east-1', forcePathStyle: true,
    });
    expect(() => loadStorageConfig({ BLOB_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
    expect(() => loadStorageConfig({ BLOB_DRIVER: 'azure' })).toThrow(/AZURE_STORAGE_CONNECTION_STRING/);
  });
});
```

If a container image tag in this test doesn't exist on Docker Hub or MCR, use the nearest existing release tag and say so in the report. Don't use `latest`. If `@testcontainers/minio`'s builder methods differ from `withUsername` and `withPassword`, use the module's equivalents and keep the random credentials.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/blob-stores.test.ts`
Expected: FAIL with `Cannot find module '../src/storage/azure-blob-store'`.

- [ ] **Step 4: Write the interface and helpers** `backend/src/storage/blob-store.ts`

```ts
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
```

- [ ] **Step 5: Write the local store** `backend/src/storage/local-blob-store.ts`

```ts
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
```

- [ ] **Step 6: Write the S3 store** `backend/src/storage/s3-blob-store.ts`

```ts
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
```

- [ ] **Step 7: Write the Azure store** `backend/src/storage/azure-blob-store.ts`

```ts
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
```

- [ ] **Step 8: Write the configuration** `backend/src/storage/config.ts`

```ts
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
  | (Common & { driver: 's3'; bucket: string; region: string; endpoint?: string; forcePathStyle: boolean; credentials?: { accessKeyId: string; secretAccessKey: string } })
  | (Common & { driver: 'azure'; connectionString: string; container: string });

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
    return { ...common, driver: 's3', bucket: e.S3_BUCKET!, region: e.S3_REGION, endpoint: e.S3_ENDPOINT, forcePathStyle: e.S3_FORCE_PATH_STYLE, credentials };
  }
  if (e.BLOB_DRIVER === 'azure') return { ...common, driver: 'azure', connectionString: e.AZURE_STORAGE_CONNECTION_STRING!, container: e.AZURE_STORAGE_CONTAINER };
  return { ...common, driver: 'local', dir: e.BLOB_LOCAL_DIR };
}

export function createBlobStore(cfg: StorageConfig): BlobStore {
  if (cfg.driver === 's3') return new S3BlobStore(cfg);
  if (cfg.driver === 'azure') return new AzureBlobStore(cfg);
  return new LocalBlobStore(cfg.dir);
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/blob-stores.test.ts`
Expected: PASS, 15 tests (4 contract tests × 3 stores, plus the key, layout and configuration tests). The first run pulls the MinIO and Azurite images.

- [ ] **Step 10: Run everything**

Run: `cd backend && npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 11: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src/storage backend/tests/blob-stores.test.ts
git commit -m "Add content-addressed blob storage for local disk, S3 and Azure Blob

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---
### Task 2: Document registry, text and chunks in Postgres

**Files:**
- Create: `backend/migrations/005_documents.sql`, `backend/src/knowledge/chunk.ts`, `backend/src/knowledge/access.ts`, `backend/src/knowledge/document-repo.ts`
- Modify: `backend/src/db/schema.ts`, `backend/src/db/pglite.ts`, `backend/package.json`
- Test: `backend/tests/documents.test.ts`

**Interfaces:**
- Consumes:
  - `Executor` (`src/db/trail-repo.ts`)
  - `Role` (`src/engine/types.ts`)
  - `ensureDevUsers` (`src/auth/dev-users.ts`)
  - `newService`, `engagementWithFailedControl` (`tests/helpers.ts`)
- Produces (Tasks 3–4 rely on these):
  - `type DocumentKind = 'evidence' | 'sop' | 'policy' | 'prior_report' | 'regulation' | 'okf_concept' | 'other'`, and `DOCUMENT_KINDS`
  - `type Classification = 'internal' | 'confidential' | 'restricted'`, and `CLASSIFICATIONS`
  - `CLASSIFICATIONS_BY_ROLE: Record<Role, readonly Classification[]>`
  - `mayRead(role: Role, c: Classification): boolean`
  - `interface TextChunk { ordinal: number; page: number | null; text: string }`
  - `CHUNK_TARGET_CHARS = 1200`
  - `chunkText(text: string, pageStarts?: number[]): TextChunk[]`
  - `interface DocumentRecord { id; sha256; filename; mime; size: number; kind: DocumentKind; classification: Classification; engagementId: string | null; uploadedBy; uploadedAt: string; retainUntil: string | null; retentionExpired: boolean; metadata: Record<string, unknown> }`
  - `interface NewDocument { sha256; filename; mime; size; kind; classification; engagementId: string | null; uploadedBy; retainUntil?: string | null; metadata?: Record<string, unknown> }`
  - `insertDocument(db, d): Promise<DocumentRecord>`
  - `getDocument(db, id): Promise<DocumentRecord | null>`
  - `listDocuments(db, f: { engagementId: string | null; classifications: readonly Classification[] }): Promise<DocumentRecord[]>`
  - `setDocumentText(db, doc: DocumentRecord, t: { extractor: string; extractorVersion: string; text: string; pageStarts?: number[] }): Promise<number>` (returns the chunk count)

- [ ] **Step 1: Add the PGlite vector extension** so the eval's in-process database can run migration 005:

```bash
cd backend && npm install @electric-sql/pglite-pgvector
```

- [ ] **Step 2: Write the failing tests** `backend/tests/documents.test.ts`

```ts
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import { createMemoryDb } from '../src/db/pglite';
import { CLASSIFICATIONS_BY_ROLE, mayRead } from '../src/knowledge/access';
import { CHUNK_TARGET_CHARS, chunkText } from '../src/knowledge/chunk';
import { getDocument, insertDocument, listDocuments, setDocumentText, type NewDocument } from '../src/knowledge/document-repo';
import { engagementWithFailedControl, newService } from './helpers';

const para = (n: number, words = 40) => Array.from({ length: words }, (_, i) => `word${n}x${i}`).join(' ');

describe('chunking', () => {
  it('returns nothing for empty text and one chunk for short text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('  \n\n ')).toEqual([]);
    expect(chunkText('Short SOP text.')).toEqual([{ ordinal: 0, page: null, text: 'Short SOP text.' }]);
  });

  it('keeps paragraphs together and splits near 1,200 characters', () => {
    const text = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS * 2);
    expect(chunks.map((c) => c.text).join('\n\n').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  it('splits one very long paragraph at word boundaries', () => {
    const chunks = chunkText(para(1, 1200));
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
      expect(c.text).toMatch(/^word1x\d+( word1x\d+)*$/);
    }
  });

  it('labels each chunk with the page it starts on', () => {
    const p1 = para(1);
    const p2 = para(2);
    const text = `${p1}\n\n${p2}`;
    const chunks = chunkText(text, [0, text.indexOf(p2)]);
    expect(chunks.every((c) => c.page !== null)).toBe(true);
    expect(chunkText(`${para(3, 400)}\n\n${para(4, 400)}`, [0, 3000]).map((c) => c.page)).toContain(2);
  });
});

describe('who may read what', () => {
  it('matches the classification table', () => {
    expect(CLASSIFICATIONS_BY_ROLE).toEqual({
      viewer: ['internal'],
      auditor: ['internal', 'confidential'],
      audit_manager: ['internal', 'confidential', 'restricted'],
      cae: ['internal', 'confidential', 'restricted'],
      admin: [],
    });
    expect(mayRead('auditor', 'restricted')).toBe(false);
    expect(mayRead('cae', 'restricted')).toBe(true);
  });
});

describe('document registry', () => {
  const doc = (over: Partial<NewDocument> = {}): NewDocument => ({
    sha256: 'a'.repeat(64), filename: 'SOP-ALG-004.pdf', mime: 'application/pdf', size: 1234, kind: 'sop',
    classification: 'confidential', engagementId: null, uploadedBy: 'auditor', ...over,
  });

  it('registers documents, never deletes them, and stores text as searchable chunks', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const e = await engagementWithFailedControl(svc);
    const db = svc.db.kysely;

    const global = await insertDocument(db, doc());
    expect(global).toMatchObject({ id: expect.stringMatching(/^DOC-[0-9a-f]{12}$/), engagementId: null, retentionExpired: false, metadata: {} });
    const evidence = await insertDocument(db, doc({ kind: 'evidence', classification: 'restricted', engagementId: e.id, filename: 'CCP-LOG-MAR.xlsx' }));
    expect(await getDocument(db, evidence.id)).toEqual(evidence);

    const text = `${para(1)}\n\n${para(2)}\n\nAllergen changeover swab not recorded.`;
    expect(await setDocumentText(db, evidence, { extractor: 'test', extractorVersion: '1', text })).toBeGreaterThan(0);
    const chunks = await db.selectFrom('chunks').selectAll().where('document_id', '=', evidence.id).orderBy('ordinal').execute();
    expect(chunks[0]).toMatchObject({ id: `${evidence.id}:0`, classification: 'restricted', engagement_id: e.id, embedding: null });
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from chunks where tsv @@ websearch_to_tsquery('english', 'allergen swab')`.execute(db);
    expect(rows[0].n).toBe(1);

    await expect(setDocumentText(db, evidence, { extractor: 'test', extractorVersion: '1', text })).rejects.toMatchObject({ status: 409 });
    await expect(db.deleteFrom('documents').where('id', '=', global.id).execute()).rejects.toThrow(/append-only: DELETE/);
  });

  it('lists documents within the requested scope and readable classifications', async () => {
    const svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    const e = await engagementWithFailedControl(svc);
    const db = svc.db.kysely;
    const a = await insertDocument(db, doc({ classification: 'internal' }));
    await insertDocument(db, doc({ classification: 'restricted' }));
    const c = await insertDocument(db, doc({ engagementId: e.id, classification: 'internal' }));
    expect((await listDocuments(db, { engagementId: null, classifications: ['internal'] })).map((d) => d.id)).toEqual([a.id]);
    expect((await listDocuments(db, { engagementId: e.id, classifications: ['internal'] })).map((d) => d.id)).toEqual([c.id]);
    expect(await listDocuments(db, { engagementId: null, classifications: [] })).toEqual([]);
  });

  it('runs the same migrations on the in-process database used by eval', async () => {
    const mem = await createMemoryDb();
    try {
      const { rows } = await sql<{ ok: boolean }>`select exists(select 1 from pg_extension where extname = 'vector') as ok`.execute(mem.kysely);
      expect(rows[0].ok).toBe(true);
    } finally {
      await mem.close();
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/documents.test.ts`
Expected: FAIL with `Cannot find module '../src/knowledge/access'`.

- [ ] **Step 4: Write the migration** `backend/migrations/005_documents.sql`

```sql
-- The document registry: every file the platform holds (evidence, SOPs, policies,
-- prior reports, regulations) with who may read it, plus its text in searchable chunks.
-- Documents are never deleted; retention is a flag.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id                text PRIMARY KEY,
  sha256            text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  filename          text NOT NULL,
  mime              text NOT NULL,
  size              bigint NOT NULL CHECK (size >= 0),
  kind              text NOT NULL CHECK (kind IN ('evidence', 'sop', 'policy', 'prior_report', 'regulation', 'okf_concept', 'other')),
  classification    text NOT NULL CHECK (classification IN ('internal', 'confidential', 'restricted')),
  engagement_id     text REFERENCES engagements (id),
  uploaded_by       text NOT NULL REFERENCES users (id),
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  retain_until      date,
  retention_expired boolean NOT NULL DEFAULT false,
  metadata          jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX documents_scope_idx ON documents (engagement_id, uploaded_at);
CREATE INDEX documents_sha_idx ON documents (sha256);
CREATE TRIGGER documents_never_deleted BEFORE DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION reject_change();

CREATE TABLE document_text (
  document_id       text PRIMARY KEY REFERENCES documents (id),
  extractor         text NOT NULL,
  extractor_version text NOT NULL,
  text              text NOT NULL,
  pages             jsonb NOT NULL DEFAULT '[]',
  extracted_at      timestamptz NOT NULL DEFAULT now()
);

-- A chunk belongs to a document now, or to a knowledge-graph node later (plan 1E).
-- classification and engagement_id are copied from the parent so search filters in SQL.
CREATE TABLE chunks (
  id             text PRIMARY KEY,
  document_id    text REFERENCES documents (id),
  kg_node_id     text,
  ordinal        integer NOT NULL CHECK (ordinal >= 0),
  page           integer,
  text           text NOT NULL,
  tsv            tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  embedding      vector,
  classification text NOT NULL CHECK (classification IN ('internal', 'confidential', 'restricted')),
  engagement_id  text REFERENCES engagements (id),
  CHECK ((document_id IS NULL) <> (kg_node_id IS NULL)),
  UNIQUE (document_id, ordinal)
);
CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX chunks_scope_idx ON chunks (classification, engagement_id);
```

- [ ] **Step 5: Load pgvector into PGlite.** In `backend/src/db/pglite.ts`, replace:

```ts
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite();
```

with:

```ts
  const { PGlite } = await import('@electric-sql/pglite');
  // Migration 005 creates the pgvector extension, so the in-process database needs it too.
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const pglite = new PGlite({ extensions: { vector } });
```

If the package's export isn't named `vector`, check its README and use the documented export; keep the extension key `vector`.

- [ ] **Step 6: Add the tables to the Kysely schema.** In `backend/src/db/schema.ts`, add before `export interface DB`:

```ts
export interface DocumentsTable {
  id: string;
  sha256: string;
  filename: string;
  mime: string;
  size: number;
  kind: 'evidence' | 'sop' | 'policy' | 'prior_report' | 'regulation' | 'okf_concept' | 'other';
  classification: 'internal' | 'confidential' | 'restricted';
  engagement_id: string | null;
  uploaded_by: string;
  uploaded_at: Generated<Date>;
  retain_until: ColumnType<Date | null, string | null | undefined, string | null>;
  retention_expired: ColumnType<boolean, boolean | undefined, boolean>;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
}

export interface DocumentTextTable {
  document_id: string;
  extractor: string;
  extractor_version: string;
  text: string;
  pages: ColumnType<number[], string | undefined, string>;
  extracted_at: Generated<Date>;
}

export interface ChunksTable {
  id: string;
  document_id: string | null;
  kg_node_id: string | null;
  ordinal: number;
  page: number | null;
  text: string;
  tsv: ColumnType<string, never, never>;
  embedding: ColumnType<string | null, string | null | undefined, string | null>;
  classification: 'internal' | 'confidential' | 'restricted';
  engagement_id: string | null;
}
```

and add these members to `interface DB`:

```ts
  documents: DocumentsTable;
  document_text: DocumentTextTable;
  chunks: ChunksTable;
```

- [ ] **Step 7: Write the classification rules** `backend/src/knowledge/access.ts`

```ts
import type { Role } from '../engine/types';

export const CLASSIFICATIONS = ['internal', 'confidential', 'restricted'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const DOCUMENT_KINDS = ['evidence', 'sop', 'policy', 'prior_report', 'regulation', 'okf_concept', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** What each role may read. Admins manage access and see no audit content; viewers see internal material only. */
export const CLASSIFICATIONS_BY_ROLE: Record<Role, readonly Classification[]> = {
  viewer: ['internal'],
  auditor: ['internal', 'confidential'],
  audit_manager: ['internal', 'confidential', 'restricted'],
  cae: ['internal', 'confidential', 'restricted'],
  admin: [],
};

export const mayRead = (role: Role, classification: Classification) => CLASSIFICATIONS_BY_ROLE[role].includes(classification);
```

- [ ] **Step 8: Write the chunker** `backend/src/knowledge/chunk.ts`

```ts
export interface TextChunk {
  ordinal: number;
  /** 1-based page the chunk starts on, or null when page offsets are unknown. */
  page: number | null;
  text: string;
}

/** Chunks aim for about this many characters; a chunk only exceeds it when one paragraph does. */
export const CHUNK_TARGET_CHARS = 1200;

interface Piece {
  start: number;
  text: string;
}

/** Paragraphs (split on blank lines) with their offsets; over-long paragraphs are cut at word boundaries. */
function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  const re = /\S[\s\S]*?(?=\n\s*\n|$)/g;
  for (const m of text.matchAll(re)) {
    const para = m[0].trim();
    if (!para) continue;
    if (para.length <= CHUNK_TARGET_CHARS) {
      out.push({ start: m.index!, text: para });
      continue;
    }
    let offset = 0;
    while (offset < para.length) {
      let end = Math.min(offset + CHUNK_TARGET_CHARS, para.length);
      if (end < para.length) {
        const space = para.lastIndexOf(' ', end);
        if (space > offset) end = space;
      }
      out.push({ start: m.index! + offset, text: para.slice(offset, end).trim() });
      offset = end;
      while (para[offset] === ' ') offset++;
    }
  }
  return out;
}

/**
 * Splits document text into paragraph-aligned chunks of about CHUNK_TARGET_CHARS.
 * pageStarts holds the character offset where each page begins (page 1 first).
 */
export function chunkText(text: string, pageStarts: number[] = []): TextChunk[] {
  const pageOf = (offset: number) => (pageStarts.length ? Math.max(1, pageStarts.filter((s) => s <= offset).length) : null);
  const chunks: TextChunk[] = [];
  let current: Piece[] = [];
  const flush = () => {
    if (!current.length) return;
    chunks.push({ ordinal: chunks.length, page: pageOf(current[0].start), text: current.map((p) => p.text).join('\n\n') });
    current = [];
  };
  for (const piece of pieces(text)) {
    const size = current.reduce((n, p) => n + p.text.length + 2, 0);
    if (current.length && size + piece.text.length > CHUNK_TARGET_CHARS) flush();
    current.push(piece);
  }
  flush();
  return chunks;
}
```

- [ ] **Step 9: Write the registry repository** `backend/src/knowledge/document-repo.ts`

```ts
import crypto from 'node:crypto';
import type { Selectable } from 'kysely';
import type { DocumentsTable } from '../db/schema';
import type { Executor } from '../db/trail-repo';
import { AppError } from '../errors';
import type { Classification, DocumentKind } from './access';
import { chunkText } from './chunk';

export type { Classification, DocumentKind } from './access';

export interface DocumentRecord {
  id: string;
  sha256: string;
  filename: string;
  mime: string;
  size: number;
  kind: DocumentKind;
  classification: Classification;
  engagementId: string | null;
  uploadedBy: string;
  uploadedAt: string;
  retainUntil: string | null;
  retentionExpired: boolean;
  metadata: Record<string, unknown>;
}

export interface NewDocument {
  sha256: string;
  filename: string;
  mime: string;
  size: number;
  kind: DocumentKind;
  classification: Classification;
  engagementId: string | null;
  uploadedBy: string;
  retainUntil?: string | null;
  metadata?: Record<string, unknown>;
}

function toRecord(r: Selectable<DocumentsTable>): DocumentRecord {
  return {
    id: r.id, sha256: r.sha256, filename: r.filename, mime: r.mime, size: Number(r.size), kind: r.kind, classification: r.classification,
    engagementId: r.engagement_id, uploadedBy: r.uploaded_by, uploadedAt: new Date(r.uploaded_at).toISOString(),
    retainUntil: r.retain_until ? new Date(r.retain_until).toISOString().slice(0, 10) : null, retentionExpired: r.retention_expired, metadata: r.metadata,
  };
}

export async function insertDocument(db: Executor, d: NewDocument): Promise<DocumentRecord> {
  const row = await db
    .insertInto('documents')
    .values({
      id: `DOC-${crypto.randomBytes(6).toString('hex')}`, sha256: d.sha256, filename: d.filename, mime: d.mime, size: d.size, kind: d.kind,
      classification: d.classification, engagement_id: d.engagementId, uploaded_by: d.uploadedBy, retain_until: d.retainUntil ?? null,
      metadata: JSON.stringify(d.metadata ?? {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toRecord(row);
}

export async function getDocument(db: Executor, id: string): Promise<DocumentRecord | null> {
  const row = await db.selectFrom('documents').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toRecord(row) : null;
}

/** Documents in one scope (global when engagementId is null) that the reader's classifications allow. */
export async function listDocuments(db: Executor, f: { engagementId: string | null; classifications: readonly Classification[] }): Promise<DocumentRecord[]> {
  if (!f.classifications.length) return [];
  let q = db.selectFrom('documents').selectAll().where('classification', 'in', [...f.classifications]);
  q = f.engagementId === null ? q.where('engagement_id', 'is', null) : q.where('engagement_id', '=', f.engagementId);
  return (await q.orderBy('uploaded_at').orderBy('id').execute()).map(toRecord);
}

/** Stores a document's text once and indexes it as chunks carrying the document's classification and engagement. */
export async function setDocumentText(
  db: Executor,
  doc: DocumentRecord,
  t: { extractor: string; extractorVersion: string; text: string; pageStarts?: number[] },
): Promise<number> {
  const existing = await db.selectFrom('document_text').select('document_id').where('document_id', '=', doc.id).executeTakeFirst();
  if (existing) throw new AppError(409, `Document ${doc.id} already has text`);
  await db
    .insertInto('document_text')
    .values({ document_id: doc.id, extractor: t.extractor, extractor_version: t.extractorVersion, text: t.text, pages: JSON.stringify(t.pageStarts ?? []) })
    .execute();
  const chunks = chunkText(t.text, t.pageStarts);
  if (chunks.length) {
    await db
      .insertInto('chunks')
      .values(chunks.map((c) => ({
        id: `${doc.id}:${c.ordinal}`, document_id: doc.id, kg_node_id: null, ordinal: c.ordinal, page: c.page, text: c.text,
        classification: doc.classification, engagement_id: doc.engagementId,
      })))
      .execute();
  }
  return chunks.length;
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/documents.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 11: Run everything.** Eval runs migration 005 on PGlite.

Run: `cd backend && npm test && npm run eval && npm run typecheck`
Expected: all green; eval 25/25.

- [ ] **Step 12: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/migrations/005_documents.sql backend/src/db backend/src/knowledge backend/tests/documents.test.ts
git commit -m "Add the document registry with searchable, classification-tagged chunks

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---

### Task 3: Retrieval that never returns what the reader may not see

**Files:**
- Create: `backend/src/knowledge/retriever.ts`
- Test: `backend/tests/retrieval.test.ts`
- Modify: `backend/validation/requirements.json` (REQ-23)

**Interfaces:**
- Consumes: `CLASSIFICATIONS_BY_ROLE`, `DocumentKind`, `insertDocument`, `setDocumentText` (Task 2); `User` (`src/engine/types.ts`)
- Produces (Task 4 relies on these):
  - `interface RetrievalScope { user: User; engagementId?: string; kinds?: readonly DocumentKind[]; limit?: number }`
  - `interface DocumentCitation { documentId: string; filename: string; page: number | null; chunkOrdinal: number }`
  - `interface Hit { id: string; kind: 'chunk' | 'kg_node'; title: string; snippet: string; score: number; citation: DocumentCitation; citable: boolean }`
  - `interface Retriever { search(query: string, scope: RetrievalScope): Promise<Hit[]> }`
  - `new PgFtsRetriever(db: Kysely<DB>)`
  - `MAX_HITS = 50`

- [ ] **Step 1: Write the failing tests** `backend/tests/retrieval.test.ts`

```ts
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureDevUsers } from '../src/auth/dev-users';
import type { Classification, DocumentKind } from '../src/knowledge/access';
import { insertDocument, setDocumentText } from '../src/knowledge/document-repo';
import { PgFtsRetriever } from '../src/knowledge/retriever';
import type { AuditService } from '../src/service';
import { admin, approver, auditor, engagementWithFailedControl, newService, reviewer, viewer } from './helpers';

describe('permission-filtered retrieval', () => {
  let svc: AuditService;
  let engA: string;
  let engB: string;
  const ids: Record<string, string> = {};

  async function add(key: string, classification: Classification, engagementId: string | null, text: string, kind: DocumentKind = 'sop') {
    const d = await insertDocument(svc.db.kysely, {
      sha256: key.padEnd(64, '0').replace(/[^a-f0-9]/g, 'a').slice(0, 64), filename: `${key}.pdf`, mime: 'application/pdf', size: 10,
      kind, classification, engagementId, uploadedBy: 'auditor',
    });
    await setDocumentText(svc.db.kysely, d, { extractor: 'test', extractorVersion: '1', text, pageStarts: [0] });
    ids[key] = d.id;
  }

  beforeAll(async () => {
    svc = await newService();
    await ensureDevUsers(svc.db.kysely);
    engA = (await engagementWithFailedControl(svc)).id;
    engB = (await engagementWithFailedControl(svc)).id;
    await add('internal', 'internal', null, 'Allergen changeover cleaning must be verified with a swab before restart.');
    await add('confidential', 'confidential', null, 'Allergen matrix for the hazelnut line, supplier confidential.');
    await add('restricted', 'restricted', null, 'Allergen incident investigation, restricted to quality leadership.');
    await add('engA', 'internal', engA, 'Allergen swab log for engagement A, March.', 'evidence');
    await add('engB', 'internal', engB, 'Allergen swab log for engagement B, April.', 'evidence');
    await add('expired', 'internal', null, 'Allergen procedure superseded in 2019.');
    await sql`UPDATE documents SET retention_expired = true WHERE id = ${ids.expired}`.execute(svc.db.kysely);
  });

  const docsFound = async (user: typeof auditor, opts: { engagementId?: string; kinds?: DocumentKind[] } = {}) =>
    (await new PgFtsRetriever(svc.db.kysely).search('allergen', { user, ...opts })).map((h) => h.citation.documentId).sort();

  it('gives each role only the classifications it may read [REQ-23]', async () => {
    expect(await docsFound(viewer)).toEqual([ids.internal].sort());
    expect(await docsFound(auditor)).toEqual([ids.internal, ids.confidential].sort());
    expect(await docsFound(reviewer)).toEqual([ids.internal, ids.confidential, ids.restricted].sort());
    expect(await docsFound(approver)).toEqual([ids.internal, ids.confidential, ids.restricted].sort());
    expect(await docsFound(admin)).toEqual([]);
  });

  it("never lets one engagement's evidence surface in another engagement's search [REQ-23]", async () => {
    expect(await docsFound(auditor, { engagementId: engA })).toEqual([ids.internal, ids.confidential, ids.engA].sort());
    expect(await docsFound(auditor, { engagementId: engB })).toEqual([ids.internal, ids.confidential, ids.engB].sort());
    expect(await docsFound(auditor)).not.toContain(ids.engA);
  });

  it('keeps restricted words out of snippets for readers who may not see them [REQ-23]', async () => {
    const hits = await new PgFtsRetriever(svc.db.kysely).search('incident investigation quality leadership', { user: auditor });
    expect(hits).toEqual([]);
  });

  it('skips documents past retention and can filter by kind', async () => {
    expect(await docsFound(reviewer)).not.toContain(ids.expired);
    expect(await docsFound(auditor, { engagementId: engA, kinds: ['evidence'] })).toEqual([ids.engA]);
  });

  it('returns ranked hits with a snippet and a document-and-page citation', async () => {
    const [hit] = await new PgFtsRetriever(svc.db.kysely).search('swab before restart', { user: viewer });
    expect(hit).toMatchObject({
      id: `${ids.internal}:0`, kind: 'chunk', title: 'internal.pdf', citable: true,
      citation: { documentId: ids.internal, filename: 'internal.pdf', page: 1, chunkOrdinal: 0 },
    });
    expect(hit.snippet).toMatch(/swab/i);
    expect(hit.score).toBeGreaterThan(0);
  });

  it('returns nothing for an empty query and caps the number of hits', async () => {
    expect(await new PgFtsRetriever(svc.db.kysely).search('   ', { user: reviewer })).toEqual([]);
    expect((await new PgFtsRetriever(svc.db.kysely).search('allergen', { user: reviewer, limit: 2 })).length).toBe(2);
    expect((await new PgFtsRetriever(svc.db.kysely).search('allergen', { user: reviewer, limit: 10_000 })).length).toBeLessThanOrEqual(50);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/retrieval.test.ts`
Expected: FAIL with `Cannot find module '../src/knowledge/retriever'`.

- [ ] **Step 3: Write the retriever** `backend/src/knowledge/retriever.ts`

```ts
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema';
import type { User } from '../engine/types';
import { CLASSIFICATIONS_BY_ROLE, type DocumentKind } from './access';

export interface RetrievalScope {
  user: User;
  /** Search this engagement's documents as well as global ones; omit for global documents only. */
  engagementId?: string;
  kinds?: readonly DocumentKind[];
  limit?: number;
}

export interface DocumentCitation {
  documentId: string;
  filename: string;
  page: number | null;
  chunkOrdinal: number;
}

export interface Hit {
  id: string;
  /** 'kg_node' hits arrive with the knowledge graph (plan 1E). */
  kind: 'chunk' | 'kg_node';
  title: string;
  snippet: string;
  score: number;
  citation: DocumentCitation;
  /** Whether a finding may cite this hit; plan 1E applies trust rules to knowledge-graph nodes. */
  citable: boolean;
}

export interface Retriever {
  search(query: string, scope: RetrievalScope): Promise<Hit[]>;
}

export const MAX_HITS = 50;

/**
 * Postgres full-text search over chunks. Permission filtering happens inside the
 * query, so text a user may not read never leaves the database — not even in a snippet.
 */
export class PgFtsRetriever implements Retriever {
  constructor(private readonly db: Kysely<DB>) {}

  async search(query: string, scope: RetrievalScope): Promise<Hit[]> {
    const allowed = CLASSIFICATIONS_BY_ROLE[scope.user.role];
    if (!query.trim() || !allowed.length) return [];
    const limit = Math.min(Math.max(scope.limit ?? 10, 1), MAX_HITS);
    const engagementFilter = scope.engagementId
      ? sql`(c.engagement_id IS NULL OR c.engagement_id = ${scope.engagementId})`
      : sql`c.engagement_id IS NULL`;
    const kindFilter = scope.kinds?.length ? sql`AND d.kind IN (${sql.join([...scope.kinds])})` : sql``;

    const { rows } = await sql<{ id: string; document_id: string; ordinal: number; page: number | null; filename: string; score: number; snippet: string }>`
      SELECT c.id, c.document_id, c.ordinal, c.page, d.filename,
             ts_rank(c.tsv, q) AS score,
             ts_headline('english', c.text, q, 'MaxWords=35, MinWords=12, ShortWord=3') AS snippet
      FROM chunks c
      JOIN documents d ON d.id = c.document_id,
           websearch_to_tsquery('english', ${query}) q
      WHERE c.tsv @@ q
        AND c.classification IN (${sql.join([...allowed])})
        AND ${engagementFilter}
        AND d.retention_expired = false
        ${kindFilter}
      ORDER BY score DESC, c.id
      LIMIT ${limit}`.execute(this.db);

    return rows.map((r) => ({
      id: r.id, kind: 'chunk', title: r.filename, snippet: r.snippet, score: Number(r.score), citable: true,
      citation: { documentId: r.document_id, filename: r.filename, page: r.page, chunkOrdinal: r.ordinal },
    }));
  }
}
```

- [ ] **Step 4: Register REQ-23.** In `backend/validation/requirements.json`, add after REQ-21, with a comma after REQ-21:

```json
  { "id": "REQ-23", "risk": "High", "text": "Knowledge retrieval never returns content the requesting user may not access: classification by role, engagement scope and retention are enforced inside the database query.", "evalKinds": [] }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/retrieval.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run everything**

Run: `cd backend && npm test && npm run eval && npm run traceability | head -3 && npm run typecheck`
Expected: all green; eval 25/25; traceability `22/22`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/knowledge/retriever.ts backend/tests/retrieval.test.ts backend/validation/requirements.json
git commit -m "Search document chunks with role, engagement and retention filtering inside the query

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---
### Task 4: Document and search API, trailed

**Files:**
- Create: `backend/src/knowledge/routes.ts`, `backend/src/knowledge/trail.ts`
- Modify: `backend/src/app.ts`, `backend/src/server.ts`, `backend/src/errors.ts`
- Test: `backend/tests/documents-http.test.ts`

**Interfaces:**
- Consumes:
  - `BlobStore`, `assertSha256`, `BlobNotFound`, `LocalBlobStore`, `loadStorageConfig`, `createBlobStore` (Task 1)
  - `insertDocument`, `getDocument`, `listDocuments`, `setDocumentText`, `mayRead`, `CLASSIFICATIONS_BY_ROLE`, `DOCUMENT_KINDS`, `CLASSIFICATIONS` (Task 2)
  - `PgFtsRetriever` (Task 3)
  - from earlier plans: `requireRole`, `actorOf`, `READ_ROLES`, `PREPARER_ROLES`, `wrap`, `appendTrail`, `ENGINE_VERSION`, `AuditService.engagement`
  - test helpers `devAuthConfig`, `signIn`, `newService`, `ensureDevUsers`, `engagementWithFailedControl`
- Produces:
  - `createApp(svc, auth, storage?: { blobs: BlobStore | null; maxUploadBytes: number; presignDownloads: boolean })`
  - `ErrorCode` gains `'STORAGE_UNAVAILABLE'`
  - Routes:
    - `PUT /api/blobs` (raw body) → `201 { sha256, size }`
    - `POST /api/documents { sha256, filename, mime, kind, classification, engagementId?, retainUntil?, metadata?, text?: { content, pageStarts? } }` → `201 DocumentRecord & { chunks }`
    - `GET /api/documents?engagementId=` → `DocumentRecord[]`
    - `GET /api/documents/:id`
    - `GET /api/documents/:id/content`
    - `GET /api/knowledge/search?q=&engagementId=&kinds=` → `Hit[]`
  - Trail module id `document:register`

- [ ] **Step 1: Write the failing tests** `backend/tests/documents-http.test.ts`

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { sha256Of } from '../src/storage/blob-store';
import { LocalBlobStore } from '../src/storage/local-blob-store';
import { engagementWithFailedControl, newService } from './helpers';
import { devAuthConfig, signIn } from './http';

async function setup(opts: { blobs?: boolean; maxUploadBytes?: number } = {}) {
  const svc = await newService();
  await ensureDevUsers(svc.db.kysely);
  const engagement = await engagementWithFailedControl(svc);
  const blobs = opts.blobs === false ? null : new LocalBlobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'docs-')));
  const app = createApp(svc, { config: devAuthConfig(), oidc: null }, { blobs, maxUploadBytes: opts.maxUploadBytes ?? 1024 * 1024, presignDownloads: false });
  return { svc, app, engagement };
}

const SOP = Buffer.from('%PDF-1.4 fake pdf bytes for SOP-ALG-004');

async function upload(user: Awaited<ReturnType<typeof signIn>>, bytes: Buffer) {
  return user.agent.put('/api/blobs').set('x-csrf-token', user.csrf).set('Content-Type', 'application/pdf').send(bytes);
}

describe('document API', () => {
  it('uploads a file once, registers it with its text, and finds it in search', async () => {
    const { app, svc, engagement } = await setup();
    const auditor = await signIn(app, 'auditor');
    const up = await upload(auditor, SOP).expect(201);
    expect(up.body).toEqual({ sha256: sha256Of(SOP), size: SOP.length });
    expect((await upload(auditor, SOP).expect(201)).body).toEqual(up.body);

    const reg = await auditor.post('/api/documents', {
      sha256: up.body.sha256, filename: 'SOP-ALG-004.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal',
      engagementId: engagement.id, text: { content: 'Changeover cleaning on the hazelnut line must be verified by allergen swab.', pageStarts: [0] },
    }).expect(201);
    expect(reg.body).toMatchObject({ id: expect.stringMatching(/^DOC-/), size: SOP.length, uploadedBy: 'auditor', engagementId: engagement.id, chunks: 1 });

    const hits = await auditor.get(`/api/knowledge/search?q=${encodeURIComponent('allergen swab')}&engagementId=${engagement.id}`).expect(200);
    expect(hits.body[0]).toMatchObject({ citation: { documentId: reg.body.id, filename: 'SOP-ALG-004.pdf', page: 1 } });
    expect((await auditor.get('/api/knowledge/search?q=allergen').expect(200)).body).toEqual([]); // engagement documents need the engagement

    const trail = (await readTrail(svc.db.kysely, engagement.id)).at(-1)!;
    expect(trail).toMatchObject({ moduleId: 'document:register', actor: 'auditor', engagementId: engagement.id, inputs: { documentId: reg.body.id, sha256: up.body.sha256 }, output: { chunks: 1 } });
  });

  it('serves the exact bytes back, as a download that cannot be sniffed', async () => {
    const { app } = await setup();
    const auditor = await signIn(app, 'auditor');
    const up = await upload(auditor, SOP).expect(201);
    const reg = await auditor.post('/api/documents', { sha256: up.body.sha256, filename: 'SOP "ALG"\r\n.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal' }).expect(201);
    const res = await auditor.get(`/api/documents/${reg.body.id}/content`).buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on('data', (c: Buffer) => parts.push(c));
      r.on('end', () => cb(null, Buffer.concat(parts)));
    }).expect(200);
    expect(res.body).toEqual(SOP);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-disposition']).not.toMatch(/[\r\n"]ALG/);
  });

  it("answers 404 for a document the reader may not see, exactly as for one that doesn't exist", async () => {
    const { app } = await setup();
    const manager = await signIn(app, 'reviewer');
    const up = await upload(manager, SOP).expect(201);
    const reg = await manager.post('/api/documents', { sha256: up.body.sha256, filename: 'incident.pdf', mime: 'application/pdf', kind: 'other', classification: 'restricted', text: { content: 'Restricted incident review.' } }).expect(201);
    const viewer = await signIn(app, 'viewer');
    for (const p of [`/api/documents/${reg.body.id}`, `/api/documents/${reg.body.id}/content`, '/api/documents/DOC-000000000000', '/api/documents/DOC-000000000000/content']) {
      const res = await viewer.get(p);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Document not found');
    }
    expect((await viewer.get('/api/documents').expect(200)).body).toEqual([]);
    expect((await viewer.get('/api/knowledge/search?q=incident').expect(200)).body).toEqual([]);
  });

  it('refuses registrations that are wrong, unknown or beyond what the uploader may read', async () => {
    const { app } = await setup();
    const auditor = await signIn(app, 'auditor');
    const up = await upload(auditor, SOP).expect(201);
    const base = { sha256: up.body.sha256, filename: 'x.pdf', mime: 'application/pdf', kind: 'sop', classification: 'internal' };
    expect((await auditor.post('/api/documents', { ...base, sha256: 'f'.repeat(64) })).status).toBe(400);
    expect((await auditor.post('/api/documents', { ...base, sha256: '../../etc/passwd' })).status).toBe(400);
    expect((await auditor.post('/api/documents', { ...base, kind: 'invoice' })).status).toBe(400);
    expect((await auditor.post('/api/documents', { ...base, engagementId: 'ENG-NOPE' })).status).toBe(404);
    expect((await auditor.post('/api/documents', { ...base, classification: 'restricted' })).status).toBe(403);
    const viewer = await signIn(app, 'viewer');
    expect((await upload(viewer, SOP)).status).toBe(403);
    expect((await viewer.post('/api/documents', base)).status).toBe(403);
    expect((await auditor.get('/api/documents/x/../../etc/passwd')).status).toBe(404);
  });

  it('refuses oversized uploads and reports missing storage plainly', async () => {
    const small = await setup({ maxUploadBytes: 16 });
    const a = await signIn(small.app, 'auditor');
    expect((await upload(a, SOP)).status).toBe(413);
    const none = await setup({ blobs: false });
    const b = await signIn(none.app, 'auditor');
    const res = await upload(b, SOP);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
  });

  it('keeps admins away from documents', async () => {
    const { app } = await setup();
    const adminUser = await signIn(app, 'admin');
    expect((await adminUser.get('/api/documents')).status).toBe(403);
    expect((await adminUser.get('/api/knowledge/search?q=x')).status).toBe(403);
  });
});

it('still answers health checks without storage configured', async () => {
  const { app } = await setup({ blobs: false });
  await request(app).get('/api/health').expect(200);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/documents-http.test.ts`
Expected: FAIL. `PUT /api/blobs` returns 404, and `createApp` ignores its third argument.

- [ ] **Step 3: Add the error code.** In `backend/src/errors.ts`, add `| 'STORAGE_UNAVAILABLE'` to `ErrorCode`.

- [ ] **Step 4: Write the trail helper** `backend/src/knowledge/trail.ts`

```ts
import crypto from 'node:crypto';
import type { Transaction } from 'kysely';
import type { DB } from '../db/schema';
import { appendTrail } from '../db/trail-repo';
import type { User } from '../engine/types';
import { ENGINE_VERSION } from '../service';
import type { DocumentRecord } from './document-repo';

/** Seals a document registration into the audit trail, in the caller's transaction. */
export async function recordDocumentEvent(trx: Transaction<DB>, actor: User, doc: DocumentRecord, chunks: number) {
  const now = new Date().toISOString();
  return appendTrail(trx, {
    id: `DOC-EVT-${crypto.randomBytes(4).toString('hex')}`,
    engagementId: doc.engagementId,
    moduleId: 'document:register',
    moduleVersion: ENGINE_VERSION,
    engineVersion: ENGINE_VERSION,
    packVersions: {},
    provider: { id: 'human', model: actor.id },
    promptHash: null,
    actor: actor.id,
    startedAt: now,
    finishedAt: now,
    inputs: { documentId: doc.id, sha256: doc.sha256, filename: doc.filename, kind: doc.kind, classification: doc.classification },
    retrievalSet: [],
    executionLog: [{ at: now, step: 'document:register', detail: `${actor.name} (${actor.role})` }],
    qaActions: [],
    output: { chunks },
  });
}
```

- [ ] **Step 5: Write the routes** `backend/src/knowledge/routes.ts`

```ts
import express, { Router, type Response } from 'express';
import { z } from 'zod';
import { actorOf, requireRole } from '../auth/http';
import { PREPARER_ROLES, READ_ROLES } from '../auth/roles';
import { AppError } from '../errors';
import { wrap } from '../http-util';
import type { AuditService } from '../service';
import { assertSha256, BlobNotFound, type BlobStore } from '../storage/blob-store';
import { CLASSIFICATIONS, CLASSIFICATIONS_BY_ROLE, DOCUMENT_KINDS, mayRead } from './access';
import { getDocument, insertDocument, listDocuments, setDocumentText, type DocumentRecord } from './document-repo';
import { PgFtsRetriever } from './retriever';
import { recordDocumentEvent } from './trail';

export interface StorageDeps {
  blobs: BlobStore | null;
  maxUploadBytes: number;
  presignDownloads: boolean;
}

const MAX_TEXT_CHARS = 900_000;

const Register = z.object({
  sha256: z.string(),
  filename: z.string().min(1).max(255),
  mime: z.string().min(1).max(200),
  kind: z.enum(DOCUMENT_KINDS),
  classification: z.enum(CLASSIFICATIONS),
  engagementId: z.string().min(1).nullable().optional(),
  retainUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  text: z.object({ content: z.string().max(MAX_TEXT_CHARS), pageStarts: z.array(z.number().int().min(0)).optional() }).optional(),
});

/** A safe Content-Disposition filename: no quotes, line breaks or path separators. */
const safeFilename = (name: string) => name.replace(/[^\w.\- ]+/g, '_').slice(0, 150) || 'document';

/** Document upload, registry, download and search. All under /api, so session, CSRF and role gates apply. */
export function documentRoutes(svc: AuditService, storage: StorageDeps): Router {
  const r = Router();
  const db = svc.db.kysely;
  const readers = requireRole(READ_ROLES);
  const preparers = requireRole(PREPARER_ROLES);
  const blobs = () => {
    if (!storage.blobs) throw new AppError(503, 'File storage is not configured', 'STORAGE_UNAVAILABLE');
    return storage.blobs;
  };

  /** The document if this reader may see it; otherwise "not found", whether or not it exists. */
  const readable = async (id: string, role: Parameters<typeof mayRead>[0]): Promise<DocumentRecord> => {
    const doc = await getDocument(db, id);
    if (!doc || !mayRead(role, doc.classification)) throw new AppError(404, 'Document not found');
    return doc;
  };

  r.put('/api/blobs', preparers, express.raw({ type: () => true, limit: storage.maxUploadBytes }), wrap(async (req, res) => {
    const store = blobs();
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw new AppError(400, 'Send the file as the request body');
    res.status(201).json(await store.put(body, { mime: req.header('content-type') ?? 'application/octet-stream' }));
  }));

  r.post('/api/documents', preparers, wrap(async (req, res) => {
    const store = blobs();
    const body = Register.parse(req.body);
    const sha256 = assertSha256(body.sha256);
    const actor = actorOf(req);
    if (!mayRead(actor.role, body.classification)) throw new AppError(403, `You may not file ${body.classification} documents`, 'FORBIDDEN');
    const engagementId = body.engagementId ?? null;
    if (engagementId) await svc.engagement(engagementId); // 404 if it doesn't exist
    const stored = await store.head(sha256);
    if (!stored) throw new AppError(400, 'Upload the file first: no stored object has that SHA-256');

    const result = await db.transaction().execute(async (trx) => {
      const doc = await insertDocument(trx, {
        sha256, filename: body.filename, mime: body.mime, size: stored.size, kind: body.kind, classification: body.classification,
        engagementId, uploadedBy: actor.id, retainUntil: body.retainUntil ?? null, metadata: body.metadata,
      });
      const chunks = body.text ? await setDocumentText(trx, doc, { extractor: 'client', extractorVersion: '1', text: body.text.content, pageStarts: body.text.pageStarts }) : 0;
      await recordDocumentEvent(trx, actor, doc, chunks);
      return { ...doc, chunks };
    });
    res.status(201).json(result);
  }));

  r.get('/api/documents', readers, wrap(async (req, res) => {
    const actor = actorOf(req);
    const engagementId = typeof req.query.engagementId === 'string' && req.query.engagementId ? req.query.engagementId : null;
    res.json(await listDocuments(db, { engagementId, classifications: CLASSIFICATIONS_BY_ROLE[actor.role] }));
  }));

  r.get('/api/documents/:id', readers, wrap(async (req, res) => {
    res.json(await readable(String(req.params.id), actorOf(req).role));
  }));

  r.get('/api/documents/:id/content', readers, wrap(async (req, res: Response) => {
    const doc = await readable(String(req.params.id), actorOf(req).role);
    const store = blobs();
    if (storage.presignDownloads) {
      const url = await store.presignedGet(doc.sha256, 60);
      if (url) return res.redirect(url);
    }
    let stream;
    try {
      stream = await store.get(doc.sha256);
    } catch (err) {
      if (err instanceof BlobNotFound) throw new AppError(404, 'Document not found');
      throw err;
    }
    res.set({
      'Content-Type': doc.mime,
      'Content-Disposition': `attachment; filename="${safeFilename(doc.filename)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    stream.on('error', (err) => res.destroy(err));
    stream.pipe(res);
  }));

  r.get('/api/knowledge/search', readers, wrap(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const engagementId = typeof req.query.engagementId === 'string' && req.query.engagementId ? req.query.engagementId : undefined;
    const kinds = typeof req.query.kinds === 'string' ? z.array(z.enum(DOCUMENT_KINDS)).parse(req.query.kinds.split(',')) : undefined;
    res.json(await new PgFtsRetriever(db).search(q, { user: actorOf(req), engagementId, kinds }));
  }));

  return r;
}
```

- [ ] **Step 6: Wire it into the app.** In `backend/src/app.ts`:
- add `import { documentRoutes, type StorageDeps } from './knowledge/routes';`
- change the signature to `export function createApp(svc: AuditService, auth: AuthDeps, storage: StorageDeps = { blobs: null, maxUploadBytes: 25 * 1024 * 1024, presignDownloads: false }) {`
- after `app.use(signing.router);`, add `app.use(documentRoutes(svc, storage));`
- in the error middleware, before the final 500 branch, add:

```ts
    if ((err as { type?: string }).type === 'entity.too.large') {
      return res.status(413).json({ error: 'The file is larger than the upload limit', code: 'VALIDATION' });
    }
```

In `backend/src/server.ts`, add these imports:

```ts
import { createBlobStore, loadStorageConfig } from './storage/config';
```

After `const auth = loadAuthConfig();`, add:

```ts
  const storage = loadStorageConfig();
  const blobs = createBlobStore(storage);
```

and change the `createApp(…)` call to:

```ts
createApp(svc, { config: auth, oidc }, { blobs, maxUploadBytes: storage.maxBytes, presignDownloads: storage.presignDownloads })
```

Add `files: ${blobs.driver}` to the start-up log line.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && npx vitest run tests/documents-http.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 8: Run everything**

Run: `cd backend && npm test && npm run eval && npm run traceability | head -3 && npm run typecheck`
Expected: all green; eval 25/25; traceability `22/22`.

- [ ] **Step 9: Commit**

```bash
git add backend/src backend/tests/documents-http.test.ts
git commit -m "Add the document upload, registry, download and search API

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---

### Task 5: MinIO in Compose, configuration and docs

**Files:**
- Modify: `docker-compose.yml`, `.env.example`, `backend/.env.example`, `README.md`, `backend/.gitignore`

**Interfaces:**
- Consumes: `BLOB_*`, `S3_*` and `AZURE_STORAGE_*` settings (Task 1); the document API (Task 4)
- Produces: `docker compose up` stores files in MinIO; documented settings for S3 and Azure

- [ ] **Step 1: Add MinIO to Compose.** In `docker-compose.yml`, add these services before `volumes:`:

```yaml
  # S3-compatible object storage for evidence and documents (local stand-in for S3 / Azure Blob).
  minio:
    image: minio/minio:RELEASE.2024-11-07T00-52-20Z
    command: ['server', '/data']
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:?Set MINIO_ROOT_USER in .env - copy .env.example to .env first}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?Set MINIO_ROOT_PASSWORD in .env (at least 8 characters)}
    volumes:
      - blobdata:/data
    ports:
      - '127.0.0.1:9000:9000'
    healthcheck:
      test: ['CMD', 'mc', 'ready', 'local']
      interval: 2s
      retries: 30

  # One-shot: create the bucket the API stores files in.
  minio-init:
    image: minio/mc:RELEASE.2024-11-17T19-35-25Z
    entrypoint: ['/bin/sh', '-c']
    command:
      - mc alias set local http://minio:9000 "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD" && mc mb --ignore-existing local/audit-evidence
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:?Set MINIO_ROOT_USER in .env}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?Set MINIO_ROOT_PASSWORD in .env}
    depends_on:
      minio:
        condition: service_healthy
```

Add these to the `backend` service's `environment:`:

```yaml
      BLOB_DRIVER: s3
      S3_BUCKET: audit-evidence
      S3_ENDPOINT: http://minio:9000
      S3_FORCE_PATH_STYLE: 'true'
      S3_ACCESS_KEY_ID: ${MINIO_ROOT_USER:?Set MINIO_ROOT_USER in .env}
      S3_SECRET_ACCESS_KEY: ${MINIO_ROOT_PASSWORD:?Set MINIO_ROOT_PASSWORD in .env}
      BLOB_MAX_BYTES: ${BLOB_MAX_BYTES:-26214400}
```

Add `minio-init` to the backend's `depends_on`, with `condition: service_completed_successfully`. Add `blobdata:` under `volumes:`.

If either MinIO image tag doesn't exist, use the nearest existing release tag. Don't use `latest`.

- [ ] **Step 2: Add the settings to the env templates.** In the root `.env.example`, append:

```bash
# Local object storage (MinIO). The password must be at least 8 characters.
MINIO_ROOT_USER=audit
MINIO_ROOT_PASSWORD=change-me-please
```

In `backend/.env.example`, append:

```bash
# ---- File storage ----
# local (development only) | s3 | azure
BLOB_DRIVER=local
# BLOB_LOCAL_DIR=./data/blobs
# BLOB_MAX_BYTES=26214400
# Hand out presigned download links instead of streaming through the API (only if browsers can reach the storage endpoint)
# BLOB_PRESIGN_DOWNLOADS=false
# S3 / MinIO:   BLOB_DRIVER=s3, S3_BUCKET, S3_REGION, S3_ENDPOINT (MinIO only), S3_FORCE_PATH_STYLE=true (MinIO), S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (omit on AWS to use the instance role)
# Azure Blob:   BLOB_DRIVER=azure, AZURE_STORAGE_CONNECTION_STRING, AZURE_STORAGE_CONTAINER=evidence
```

Add `data/blobs` to `backend/.gitignore`.

- [ ] **Step 3: Document it.** In `README.md`, add after the **Electronic signatures** section:

```markdown
### Documents and evidence files

Files are stored **content-addressed**: each object's key is its own SHA-256, so a file can't change unnoticed and duplicates are stored once.

**Where files are stored** (`BLOB_DRIVER`):
- `local`: a folder; development only.
- `s3`: AWS S3, or MinIO, which Compose runs for you.
- `azure`: Azure Blob Storage.

For write-once retention, turn on S3 Object Lock, or time-based retention (immutability) on the Azure container.

**Who can read what.** Each document is registered with a kind (evidence, SOP, policy, …), a classification, and optionally an engagement:

| Role | May read |
|---|---|
| Viewer | internal |
| Auditor | internal, confidential |
| Audit manager, CAE | internal, confidential, restricted |
| Administrator | nothing (no audit content) |

**Search** (`GET /api/knowledge/search?q=…&engagementId=…`) returns global documents plus that engagement's own, and never another engagement's.
- Filtering by classification and engagement happens inside the database query, so text you may not read never leaves the database.
- A document you may not read answers "not found".

**API, for now** (the upload screen arrives with the evidence work):
1. `PUT /api/blobs` with the file as the body returns its `sha256`.
2. `POST /api/documents` registers it, optionally with its text.

Registrations are recorded in the audit trail. Documents are never deleted; retention is flagged.
```

- [ ] **Step 4: Smoke-test the stack**

```bash
cp .env.example .env
docker compose up --build -d
docker compose ps minio-init --format '{{.State}} {{.ExitCode}}'
curl -s -c /tmp/audit-jar -H 'content-type: application/json' -d '{"userId":"auditor"}' localhost:8080/auth/dev-login
CSRF=$(curl -s -b /tmp/audit-jar localhost:8080/api/me | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrfToken"])')
SHA=$(printf 'Allergen swab required after hazelnut changeover.' | curl -s -b /tmp/audit-jar -H "x-csrf-token: $CSRF" -H 'content-type: text/plain' -X PUT --data-binary @- localhost:8080/api/blobs | python3 -c 'import sys,json;print(json.load(sys.stdin)["sha256"])')
curl -s -b /tmp/audit-jar -H "x-csrf-token: $CSRF" -H 'content-type: application/json' localhost:8080/api/documents \
  -d "{\"sha256\":\"$SHA\",\"filename\":\"swab.txt\",\"mime\":\"text/plain\",\"kind\":\"sop\",\"classification\":\"internal\",\"text\":{\"content\":\"Allergen swab required after hazelnut changeover.\"}}"
curl -s -b /tmp/audit-jar "localhost:8080/api/knowledge/search?q=allergen"
rm -f /tmp/audit-jar
docker compose down -v
rm .env
```

Expected:
- `minio-init` shows `exited 0`
- registration returns a `DOC-…` record with `"chunks":1`
- search returns one hit citing `swab.txt`

Record the outputs in the task report.

- [ ] **Step 5: Run all checks**

Run: `cd backend && npm test && npm run eval && npm run traceability | head -3 && npm run typecheck && cd .. && cp .env.example .env && docker compose config -q && rm .env`
Expected:
- backend all green
- eval 25/25
- traceability 22/22
- compose config valid

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example backend/.env.example backend/.gitignore README.md
git commit -m "Run MinIO in Compose for file storage and document the storage settings

Co-Authored-By: <the model that wrote this commit> <noreply@anthropic.com>"
```

---

## Done when

- **Storage**
  - Files are stored content-addressed in local, S3/MinIO or Azure Blob storage. The same contract tests pass on all three, against real emulators.
  - Malformed hashes never reach storage.
- **Registry**
  - Documents are registered with kind, classification and engagement, never deleted, and trailed.
  - Their text is chunked about every 1,200 characters with page numbers, indexed for full-text search, and has an empty `embedding` column ready for the knowledge store.
- **Search and access**
  - Search returns only what the reader's role may read, from global documents plus the requested engagement's own, never another's. Expired documents are excluded.
  - Snippets of unreadable text never leave the database (REQ-23).
  - Downloads stream the exact bytes with safe headers. Unreadable documents answer 404.
- **Checks:** Compose runs MinIO with credentials from `.env`; backend checks and eval green; traceability 22/22.

**Next plan:** 1E — Knowledge: OKF bundles for the content packs, `packs:migrate` / `packs:compile`, `kg_nodes` / `kg_edges`, and trust rules in the citation gate.
