import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { CreateBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
function blobStoreContract(name: string, make: () => BlobStore, presigns: boolean, makeBroken?: () => BlobStore) {
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

    it(presigns ? 'gives a time-limited download URL that forces a safe attachment' : 'streams downloads through the API instead of presigning', async () => {
      const store = make();
      const { sha256 } = await store.put(bytes, { mime: 'text/html' });
      const url = await store.presignedGet(sha256, 60, { contentType: 'application/octet-stream', filename: 'CCP log "März"\r\n.txt' });
      await expect(store.presignedGet('../x', 60, { contentType: 'text/plain', filename: 'x' })).rejects.toMatchObject({ status: 400 });
      if (!presigns) return expect(url).toBeNull();
      const res = await fetch(url!);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="CCP log _M_rz_.txt"; filename*=UTF-8''CCP%20log%20%22M%C3%A4rz%22%0D%0A.txt`);
    });

    it('never answers "missing" for a missing bucket or container: that is a storage failure', async () => {
      const broken = makeBroken?.();
      if (!broken) return;
      const sha = sha256Of(bytes);
      await expect(broken.head(sha)).rejects.not.toBeInstanceOf(BlobNotFound);
      await expect(broken.head(sha)).rejects.toBeTruthy();
      await expect(broken.get(sha)).rejects.not.toBeInstanceOf(BlobNotFound);
      await expect(broken.put(bytes, { mime: 'text/plain' })).rejects.toBeTruthy();
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
  it('writes objects at the content-addressed path, readable by the owner only', async () => {
    const store = new LocalBlobStore(localDir);
    const { sha256 } = await store.put(Buffer.from('layout'), { mime: 'text/plain' });
    const file = path.join(localDir, blobKey(sha256));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('fails loudly when the store itself is unusable, rather than reporting the file missing', async () => {
    const notADir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-')), 'file');
    fs.writeFileSync(notADir, 'x');
    const store = new LocalBlobStore(notADir);
    const sha = sha256Of(Buffer.from('x'));
    await expect(store.head(sha)).rejects.toMatchObject({ code: 'ENOTDIR' });
    await expect(store.get(sha)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('removes its temporary file when a write fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-'));
    const store = new LocalBlobStore(dir);
    const spy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    try {
      const bytes = Buffer.from('tmp cleanup');
      await expect(store.put(bytes, { mime: 'text/plain' })).rejects.toThrow(/disk full/);
      const folder = path.dirname(path.join(dir, blobKey(sha256Of(bytes))));
      expect(fs.readdirSync(folder)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

let seaweed: StartedTestContainer;
let s3Store: S3BlobStore;
beforeAll(async () => {
  // SeaweedFS S3 gateway with an identity whose keys are generated at runtime.
  const accessKeyId = `u${crypto.randomBytes(6).toString('hex')}`;
  const secretAccessKey = crypto.randomBytes(18).toString('base64url');
  const identities = { identities: [{ name: 'test', credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] }] };
  seaweed = await new GenericContainer('chrislusf/seaweedfs:3.80')
    .withCommand(['server', '-s3', '-s3.config=/etc/seaweedfs/s3.json', '-dir=/data'])
    .withCopyContentToContainer([{ content: JSON.stringify(identities), target: '/etc/seaweedfs/s3.json' }])
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const endpoint = `http://${seaweed.getHost()}:${seaweed.getMappedPort(8333)}`;
  const credentials = { accessKeyId, secretAccessKey };
  const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials });
  // The gateway listens before the filer is ready, so retry bucket creation briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: 'evidence' }));
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  // SeaweedFS 3.80 ignores If-None-Match on PUT, so it runs with the check-first fallback (see S3Options.conditionalWrites).
  s3Store = new S3BlobStore({ bucket: 'evidence', region: 'us-east-1', endpoint, forcePathStyle: true, credentials, conditionalWrites: false });
  s3Broken = new S3BlobStore({ bucket: 'no-such-bucket', region: 'us-east-1', endpoint, forcePathStyle: true, credentials, conditionalWrites: false });
  s3Conditional = new S3BlobStore({ bucket: 'evidence', region: 'us-east-1', endpoint, forcePathStyle: true, credentials });
  s3Raw = { client, bucket: 'evidence' };
}, 120_000);
afterAll(() => seaweed?.stop());
let s3Broken: S3BlobStore;
let s3Conditional: S3BlobStore;
let s3Raw: { client: S3Client; bucket: string };
blobStoreContract('s3 (SeaweedFS)', () => s3Store, true, () => s3Broken);

describe('s3 objects', () => {
  it('stores every object as application/octet-stream and never rewrites an existing one', async () => {
    const bytes = Buffer.from(`<html>${crypto.randomUUID()}</html>`);
    const { sha256 } = await s3Store.put(bytes, { mime: 'text/html' });
    const first = await s3Raw.client.send(new HeadObjectCommand({ Bucket: s3Raw.bucket, Key: blobKey(sha256) }));
    expect(first.ContentType).toBe('application/octet-stream');
    await new Promise((r) => setTimeout(r, 1100));
    await s3Store.put(bytes, { mime: 'image/svg+xml' });
    const second = await s3Raw.client.send(new HeadObjectCommand({ Bucket: s3Raw.bucket, Key: blobKey(sha256) }));
    expect(second.LastModified).toEqual(first.LastModified);
    expect(second.ContentType).toBe('application/octet-stream');
  });

  it('sends the write as conditional (If-None-Match: *) and treats "already there" as stored', async () => {
    const bytes = Buffer.from(`conditional ${crypto.randomUUID()}`);
    expect(await s3Conditional.put(bytes, { mime: 'text/plain' })).toEqual({ sha256: sha256Of(bytes), size: bytes.length });
    expect(await s3Conditional.put(bytes, { mime: 'text/plain' })).toEqual({ sha256: sha256Of(bytes), size: bytes.length });

    const sent: Record<string, unknown>[] = [];
    const answer = (err: object | null) => {
      const store = new S3BlobStore({ bucket: 'b', region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'k', secretAccessKey: 's' } });
      (store as unknown as { client: { send: (c: { input: Record<string, unknown> }) => Promise<unknown> } }).client.send = async (c) => {
        sent.push(c.input);
        if (err) throw err;
        return {};
      };
      return store;
    };
    await answer(null).put(bytes, { mime: 'text/html' });
    expect(sent[0]).toMatchObject({ IfNoneMatch: '*', ContentType: 'application/octet-stream' });
    for (const stored of [{ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }, { name: 'ConditionalRequestConflict', $metadata: { httpStatusCode: 409 } }]) {
      await expect(answer(stored).put(bytes, { mime: 'text/plain' })).resolves.toEqual({ sha256: sha256Of(bytes), size: bytes.length });
    }
    for (const failure of [{ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }]) {
      await expect(answer(failure).put(bytes, { mime: 'text/plain' })).rejects.toMatchObject(failure);
    }
  });
});

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
  azureBroken = new AzureBlobStore({ connectionString, container: 'no-such-container' });
  azureContainer = BlobServiceClient.fromConnectionString(connectionString).getContainerClient('evidence');
}, 120_000);
afterAll(() => azurite?.stop());
let azureBroken: AzureBlobStore;
let azureContainer: ContainerClient;
blobStoreContract('azure (Azurite)', () => azureStore, true, () => azureBroken);

describe('azure objects', () => {
  it('stores every object as application/octet-stream and never rewrites an existing one', async () => {
    const bytes = Buffer.from(`<html>${crypto.randomUUID()}</html>`);
    const { sha256 } = await azureStore.put(bytes, { mime: 'text/html' });
    const first = await azureContainer.getBlockBlobClient(blobKey(sha256)).getProperties();
    expect(first.contentType).toBe('application/octet-stream');
    await new Promise((r) => setTimeout(r, 1100));
    await azureStore.put(bytes, { mime: 'image/svg+xml' });
    const second = await azureContainer.getBlockBlobClient(blobKey(sha256)).getProperties();
    expect(second.etag).toBe(first.etag);
  });

  it('closes the download when the reader goes away', async () => {
    const { sha256 } = await azureStore.put(crypto.randomBytes(256 * 1024), { mime: 'application/octet-stream' });
    const stream = await azureStore.get(sha256);
    const closed = new Promise((r) => stream.once('close', r));
    stream.destroy();
    await closed;
    expect(stream.destroyed).toBe(true);
  });
});

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

  const prodS3 = { NODE_ENV: 'production', BLOB_DRIVER: 's3', S3_BUCKET: 'b' };
  it('refuses unsafe storage settings in production', () => {
    expect(loadStorageConfig({ ...prodS3, S3_ENDPOINT: 'https://s3.example.com' })).toMatchObject({ driver: 's3', endpoint: 'https://s3.example.com' });
    expect(() => loadStorageConfig({ ...prodS3, S3_ENDPOINT: 'http://objectstore:8333' })).toThrow(/S3_ENDPOINT must use https/);
    expect(loadStorageConfig({ ...prodS3, S3_ENDPOINT: 'http://objectstore:8333', NODE_ENV: 'development' })).toMatchObject({ endpoint: 'http://objectstore:8333' });
    expect(() => loadStorageConfig({ NODE_ENV: 'production', BLOB_DRIVER: 'azure', AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true' })).toThrow(/emulator/);
    expect(() => loadStorageConfig({ NODE_ENV: 'production', BLOB_DRIVER: 'azure', AZURE_STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=x;' })).toThrow(/emulator/);
    expect(loadStorageConfig({ NODE_ENV: 'production', BLOB_DRIVER: 'azure', AZURE_STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=prod;AccountKey=x;EndpointSuffix=core.windows.net' })).toMatchObject({ driver: 'azure' });
    expect(() => loadStorageConfig({ ...prodS3, BLOB_MAX_BYTES: String(100 * 1024 * 1024 + 1) })).toThrow(/BLOB_MAX_BYTES/);
    expect(loadStorageConfig({ ...prodS3, BLOB_MAX_BYTES: String(100 * 1024 * 1024) })).toMatchObject({ maxBytes: 100 * 1024 * 1024 });
  });

  it('refuses half a set of S3 keys anywhere', () => {
    expect(() => loadStorageConfig({ BLOB_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k' })).toThrow(/S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/);
    expect(() => loadStorageConfig({ BLOB_DRIVER: 's3', S3_BUCKET: 'b', S3_SECRET_ACCESS_KEY: 's' })).toThrow(/S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/);
    expect(loadStorageConfig({ BLOB_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' })).toMatchObject({ credentials: { accessKeyId: 'k', secretAccessKey: 's' } });
    expect(loadStorageConfig({ BLOB_DRIVER: 's3', S3_BUCKET: 'b' })).toMatchObject({ credentials: undefined, conditionalWrites: true });
    expect(loadStorageConfig({ BLOB_DRIVER: 's3', S3_BUCKET: 'b', S3_CONDITIONAL_WRITES: 'false' })).toMatchObject({ conditionalWrites: false });
  });
});
