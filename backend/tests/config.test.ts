import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadConfig, loadServerConfig, loadWorkerConfig, resolveSecretFiles } from '../src/config';
import { poolConfig } from '../src/db';

const URL = 'postgres://u:p@db.example.com:5432/audit';
const TOKEN = 'm'.repeat(32);

/** A production environment that passes every check; each test breaks one thing. */
function prod(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'production', DATABASE_URL: URL, METRICS_TOKEN: TOKEN, DEV_AUTH: 'false',
    PUBLIC_URL: 'https://audit.example.com', OIDC_ISSUER: 'https://login.example.com/t/v2.0', OIDC_CLIENT_ID: 'app',
    OIDC_REDIRECT_URI: 'https://audit.example.com/auth/callback', BLOB_DRIVER: 's3', S3_BUCKET: 'evidence',
    ALLOW_UNVERIFIED_CITATIONS: 'false', ...over,
  };
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv;
}

function tmpFile(content: string) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'secret');
  fs.writeFileSync(file, content);
  return file;
}

describe('configuration', () => {
  it('accepts a complete production configuration with verified database TLS [REQ-25]', () => {
    const cfg = loadServerConfig(prod());
    expect(cfg.core).toMatchObject({ production: true, databaseSsl: { rejectUnauthorized: true }, trustProxy: 0, logLevel: 'info', metricsToken: TOKEN });
    expect(cfg.auth.devAuth).toBe(false);
    expect(cfg.storage.driver).toBe('s3');
    expect(cfg.citationPolicy).toEqual({ allowUnverified: false });
  });

  it.each([
    ['DATABASE_SSL=disable', { DATABASE_SSL: 'disable' }, /DATABASE_SSL: must not be disable in production/],
    ['no METRICS_TOKEN', { METRICS_TOKEN: undefined }, /METRICS_TOKEN: required in production/],
    ['a short METRICS_TOKEN', { METRICS_TOKEN: 'short' }, /METRICS_TOKEN: .*24/],
    ['sslmode in DATABASE_URL', { DATABASE_URL: `${URL}?sslmode=disable` }, /DATABASE_URL: .*sslmode.*DATABASE_SSL/],
    ['DEV_AUTH=true', { DEV_AUTH: 'true' }, /DEV_AUTH must not be true in production/],
    ['ALLOW_UNVERIFIED_CITATIONS=true', { ALLOW_UNVERIFIED_CITATIONS: 'true' }, /ALLOW_UNVERIFIED_CITATIONS: must not be true in production/],
    ['local file storage', { BLOB_DRIVER: 'local' }, /BLOB_DRIVER=local is for development only/],
    ['plain-http PUBLIC_URL', { PUBLIC_URL: 'http://audit.example.com', OIDC_REDIRECT_URI: 'http://audit.example.com/auth/callback' }, /PUBLIC_URL must use https in production/],
    ['TRUST_PROXY out of range', { TRUST_PROXY: '9' }, /TRUST_PROXY/],
    ['an unknown LOG_LEVEL', { LOG_LEVEL: 'verbose' }, /LOG_LEVEL/],
  ])('refuses %s in production [REQ-25]', (_name, over, message) => {
    expect(() => loadServerConfig(prod(over))).toThrow(message);
  });

  it('lists every problem at once, so an operator fixes them in one go [REQ-25]', () => {
    let message = '';
    try {
      loadServerConfig(prod({ DATABASE_SSL: 'disable', METRICS_TOKEN: undefined, DEV_AUTH: 'true', BLOB_DRIVER: 'local' }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.startsWith('Invalid configuration:')).toBe(true);
    for (const key of ['DATABASE_SSL', 'METRICS_TOKEN', 'DEV_AUTH', 'BLOB_DRIVER']) expect(message).toContain(`- ${key}`);
    expect(message.match(/Invalid configuration:/g)).toHaveLength(1);
  });

  it('reports TLS problems even when other core settings are invalid [REQ-25]', () => {
    let message = '';
    try {
      loadServerConfig(prod({ DATABASE_SSL: 'disable', DATABASE_URL: `${URL}?sslmode=disable`, LOG_LEVEL: 'verbose', TRUST_PROXY: '9' }));
    } catch (err) {
      message = (err as Error).message;
    }
    for (const key of ['DATABASE_SSL', 'DATABASE_URL', 'LOG_LEVEL', 'TRUST_PROXY']) expect(message.match(new RegExp(`- ${key}:`, 'g'))).toHaveLength(1);
  });

  it.each(['ssl=0', 'ssl', 'SSL=false', 'uselibpqcompat=true', 'sslcert=/nonexistent/cert.pem', 'sslkey=/nonexistent/key.pem', 'sslrootcert=/nonexistent/ca.pem', 'sslnegotiation=direct'])(
    'refuses the TLS parameter %s in DATABASE_URL, which would override DATABASE_SSL [REQ-25]',
    (param) => {
      let message = '';
      try {
        loadServerConfig(prod({ DATABASE_URL: `${URL}?application_name=audit&${param}` }));
      } catch (err) {
        message = (err as Error).message;
      }
      const key = param.split('=')[0].toLowerCase();
      expect(message).toMatch(new RegExp(`- DATABASE_URL: .*${key}.*DATABASE_SSL`));
      expect(message.match(/- DATABASE_URL:/g)).toHaveLength(1);
    },
  );

  it('accepts other DATABASE_URL query parameters [REQ-25]', () => {
    expect(loadConfig(prod({ DATABASE_URL: `${URL}?application_name=audit` })).databaseSsl).toEqual({ rejectUnauthorized: true });
  });

  it('keeps our TLS setting in the pool even if the URL carries TLS parameters [REQ-25]', () => {
    const ssl = { rejectUnauthorized: true };
    // pg's own view of the connection: an unstripped sslcert would make it read the (missing) file and throw.
    const effective = (url: string) => (new pg.Client(poolConfig(url, { ssl })) as unknown as { connectionParameters: { ssl: unknown; host: string; database: string; user: string } }).connectionParameters;
    for (const q of ['ssl=0', 'ssl', 'uselibpqcompat=true&sslmode=require', 'sslmode=disable', 'sslcert=/nonexistent/cert.pem', 'sslnegotiation=direct']) {
      const params = effective(`${URL}?application_name=audit&${q}`);
      expect(params.ssl, q).toEqual(ssl);
      expect(params).toMatchObject({ host: 'db.example.com', database: 'audit', user: 'u' });
    }
    expect(effective(`${URL}?sslmode=disable`).ssl).toEqual(ssl);
    expect(poolConfig(URL, {}).ssl).toBe(false);
    expect(poolConfig(`${URL}?application_name=audit`, { ssl }).connectionString).toBe(`${URL}?application_name=audit`);
  });

  it('reads database TLS settings and keeps development defaults simple', () => {
    expect(loadConfig({ DATABASE_URL: URL })).toEqual({
      port: 3002, databaseUrl: URL, packsDir: undefined, production: false, databaseSsl: false, logLevel: 'info', trustProxy: 0, metricsToken: null,
    });
    expect(loadConfig({ DATABASE_URL: URL, DATABASE_SSL: 'require' }).databaseSsl).toEqual({ rejectUnauthorized: false });
    const ca = tmpFile('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    expect(loadConfig({ DATABASE_URL: URL, DATABASE_SSL: 'verify-full', DATABASE_SSL_CA_FILE: ca }).databaseSsl).toEqual({
      rejectUnauthorized: true, ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    });
    expect(() => loadConfig({ DATABASE_URL: URL, DATABASE_SSL_CA_FILE: '/nonexistent/ca.pem' })).toThrow(/DATABASE_SSL_CA_FILE: cannot read/);
  });

  it('reads secrets from <NAME>_FILE and refuses both forms at once [REQ-25]', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL_FILE: tmpFile(`${URL}\n`), OIDC_CLIENT_SECRET_FILE: tmpFile('s3cr3t  \n') };
    resolveSecretFiles(env);
    expect(env.DATABASE_URL).toBe(URL);
    expect(env.OIDC_CLIENT_SECRET).toBe('s3cr3t');
    expect(() => resolveSecretFiles({ METRICS_TOKEN: TOKEN, METRICS_TOKEN_FILE: tmpFile(TOKEN) })).toThrow(/METRICS_TOKEN and METRICS_TOKEN_FILE/);
    expect(() => resolveSecretFiles({ ANTHROPIC_API_KEY_FILE: '/nonexistent/key' })).toThrow(/ANTHROPIC_API_KEY_FILE: cannot read/);
    // Only known secret names are read from files.
    const other: NodeJS.ProcessEnv = { PORT_FILE: tmpFile('1') };
    resolveSecretFiles(other);
    expect(other.PORT).toBeUndefined();
  });
});

describe('worker configuration', () => {
  const base = { DATABASE_URL: 'postgres://u:p@db:5432/audit' };

  it('serves its probes on WORKER_PORT, 3003 by default [REQ-25]', () => {
    expect(loadWorkerConfig(base).port).toBe(3003);
    expect(loadWorkerConfig({ ...base, WORKER_PORT: '' }).port).toBe(3003);
    expect(loadWorkerConfig({ ...base, WORKER_PORT: '9464' }).port).toBe(9464);
    expect(loadWorkerConfig(base).agents.enabled).toBe(true);
  });

  it('takes only a plain decimal port, for the worker and the API alike [REQ-25]', () => {
    for (const bad of ['1e3', '0x3e8', ' 3003', '3003.0', '-1', '70000']) {
      expect(() => loadWorkerConfig({ ...base, WORKER_PORT: bad }), bad).toThrow(/WORKER_PORT: must be a port number/);
      expect(() => loadConfig({ ...base, PORT: bad }), bad).toThrow(/PORT/);
    }
    expect(loadConfig({ ...base, PORT: '8080' }).port).toBe(8080);
  });

  it('lists every problem at once, and needs the metrics token in production [REQ-25]', () => {
    expect(() => loadWorkerConfig({ ...base, NODE_ENV: 'production', WORKER_PORT: 'x', AGENT_MAX_STEPS: '0', ALLOW_UNVERIFIED_CITATIONS: 'true' })).toThrow(
      /METRICS_TOKEN: required in production[\s\S]*ALLOW_UNVERIFIED_CITATIONS[\s\S]*AGENT_MAX_STEPS[\s\S]*WORKER_PORT/,
    );
  });
});
