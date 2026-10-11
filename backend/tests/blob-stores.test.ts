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
