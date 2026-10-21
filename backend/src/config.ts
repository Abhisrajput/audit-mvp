import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadAgentConfig, type AgentConfig } from './agents/config';
import { loadAuthConfig, type AuthConfig } from './auth/config';
import type { CitationPolicy } from './engine/trust';
import { loadStorageConfig, type StorageConfig } from './storage/config';

// Configuration comes from the environment only, validated once at start-up (spec §7.3, REQ-25).
// Each area has its own loader; loadServerConfig runs them all and reports every problem at once.

export type DatabaseSsl = false | { rejectUnauthorized: boolean; ca?: string };
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface Config {
  port: number;
  databaseUrl: string;
  packsDir?: string;
  production: boolean;
  databaseSsl: DatabaseSsl;
  logLevel: LogLevel;
  /** How many proxies in front of the API to trust for the client address and X-Request-Id (0 = none). */
  trustProxy: number;
  /** Bearer token for /metrics; null = open (development only). */
  metricsToken: string | null;
}

/** Settings that may instead be read from a mounted file named by <NAME>_FILE (Kubernetes / Container Apps secrets). */
export const SECRET_NAMES = [
  'DATABASE_URL', 'OIDC_CLIENT_SECRET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'AZURE_STORAGE_CONNECTION_STRING',
  'ANTHROPIC_API_KEY', 'METRICS_TOKEN', 'API_DB_PASSWORD',
] as const;

const invalid = (lines: string[]) => new Error(`Invalid configuration:\n${lines.join('\n')}`);

/** Runs one loader, adding its problems to `problems` instead of throwing, so every problem is listed at once. */
function tryLoad<T>(problems: string[], load: () => T): T | null {
  try {
    return load();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    problems.push(...message.replace(/^Invalid configuration:\n/, '').split('\n').filter(Boolean));
    return null;
  }
}

const METRICS_TOKEN_REQUIRED = '  - METRICS_TOKEN: required in production (Prometheus sends it as a bearer token)';

/** Replaces each <NAME>_FILE with the file's content (trailing whitespace trimmed) as <NAME>. */
export function resolveSecretFiles(env: NodeJS.ProcessEnv): void {
  const problems: string[] = [];
  for (const name of SECRET_NAMES) {
    const file = env[`${name}_FILE`];
    if (!file) continue;
    if (env[name]) {
      problems.push(`  - ${name}: set ${name} and ${name}_FILE, not both`);
      continue;
    }
    try {
      env[name] = fs.readFileSync(file, 'utf8').trimEnd();
    } catch {
      problems.push(`  - ${name}_FILE: cannot read ${file}`);
    }
  }
  if (problems.length) throw invalid(problems);
}

/** Loads backend/.env for local development. Never used in production. */
export function loadDotEnv(file = path.resolve(__dirname, '../.env')) {
  if (process.env.NODE_ENV === 'production') return;
  try {
    process.loadEnvFile(file);
  } catch (err) {
    // No .env file: rely on the real environment. Anything else (permissions, parse errors) is a real problem.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Every entry point calls this first: the local .env (development), then secret files. */
export function prepareEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env === process.env) loadDotEnv();
  resolveSecretFiles(env);
}

/** A port is a plain decimal number: `1e3`, hex and padded forms are refused rather than guessed at. */
const PORT_MESSAGE = 'must be a port number (1-65535)';
export const isPort = (raw: string) => /^\d{1,5}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 65535;
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('3002').refine(isPort, PORT_MESSAGE).transform(Number),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL'),
  DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).optional(),
  DATABASE_SSL_CA_FILE: z.string().min(1).optional(),
  PACKS_DIR: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  METRICS_TOKEN: z.string().min(24, 'must be at least 24 characters').optional(),
});

/** Connection-URL parameters node-postgres turns into TLS settings that replace ours (it merges the parsed URL over the options). */
export const TLS_URL_PARAMS = ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation', 'uselibpqcompat'] as const;

/** The URL's query split into raw pairs, each with its decoded, lower-cased name, plus the parts around the query. */
function splitQuery(url: string) {
  const q = url.indexOf('?');
  if (q < 0) return { base: url, pairs: [], hash: '' };
  const h = url.indexOf('#', q);
  const query = url.slice(q + 1, h < 0 ? undefined : h);
  const pairs = query.split('&').filter(Boolean).map((raw) => ({ raw, name: (new URLSearchParams(raw).keys().next().value ?? '').toLowerCase() }));
  return { base: url.slice(0, q), pairs, hash: h < 0 ? '' : url.slice(h) };
}

const isTlsParam = (name: string) => (TLS_URL_PARAMS as readonly string[]).includes(name);

/** The TLS parameters present in a connection URL (lower-cased, de-duplicated). */
export function tlsParamsIn(url: string): string[] {
  return [...new Set(splitQuery(url).pairs.map((p) => p.name).filter(isTlsParam))];
}

/** The URL without any TLS parameter; returned unchanged when it has none. */
export function stripTlsParams(url: string): string {
  const { base, pairs, hash } = splitQuery(url);
  if (!pairs.some((p) => isTlsParam(p.name))) return url;
  const kept = pairs.filter((p) => !isTlsParam(p.name)).map((p) => p.raw);
  return `${base}${kept.length ? `?${kept.join('&')}` : ''}${hash}`;
}

/** Cross-field rules run over the raw environment, so a bad field elsewhere never hides them (zod skips refinements then). */
function crossFieldProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const tls = tlsParamsIn(env.DATABASE_URL ?? '');
  if (tls.length) {
    problems.push(`  - DATABASE_URL: remove ${tls.join(', ')} from the URL and set DATABASE_SSL (and DATABASE_SSL_CA_FILE) instead (the URL would override them)`);
  }
  if (env.NODE_ENV === 'production' && env.DATABASE_SSL === 'disable') {
    problems.push('  - DATABASE_SSL: must not be disable in production; the database connection must use TLS');
  }
  return problems;
}

/** Problem lines ("  - KEY: message") for the core settings, plus the parsed config when there are none. */
function parseCore(env: NodeJS.ProcessEnv): { config: Config | null; problems: string[] } {
  // Compose passes unset optional settings as empty strings; treat them as absent.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(present);
  const problems = [
    ...(parsed.success ? [] : parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`)),
    ...crossFieldProblems(present),
  ];
  if (!parsed.success || problems.length) return { config: null, problems };
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const mode = e.DATABASE_SSL ?? (production ? 'verify-full' : 'disable');
  let ca: string | undefined;
  if (e.DATABASE_SSL_CA_FILE) {
    try {
      ca = fs.readFileSync(e.DATABASE_SSL_CA_FILE, 'utf8');
    } catch {
      return { config: null, problems: [`  - DATABASE_SSL_CA_FILE: cannot read ${e.DATABASE_SSL_CA_FILE}`] };
    }
  }
  const databaseSsl: DatabaseSsl = mode === 'disable' ? false : { rejectUnauthorized: mode === 'verify-full', ...(ca ? { ca } : {}) };
  return {
    problems: [],
    config: {
      port: e.PORT, databaseUrl: e.DATABASE_URL, packsDir: e.PACKS_DIR, production, databaseSsl,
      logLevel: e.LOG_LEVEL, trustProxy: e.TRUST_PROXY, metricsToken: e.METRICS_TOKEN ?? null,
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { config, problems } = parseCore(env);
  if (!config) throw invalid(problems);
  return config;
}

/**
 * ALLOW_UNVERIFIED_CITATIONS (spec §6.4): until a domain expert has verified the content packs,
 * demos may cite unverified knowledge with a warning. Never in production.
 */
export function loadCitationPolicy(env: NodeJS.ProcessEnv = process.env): CitationPolicy {
  const raw = env.ALLOW_UNVERIFIED_CITATIONS ?? 'false';
  if (raw !== 'true' && raw !== 'false') {
    throw new Error('Invalid configuration:\n  - ALLOW_UNVERIFIED_CITATIONS: must be "true" or "false"');
  }
  if (raw === 'true' && env.NODE_ENV === 'production') {
    throw new Error('Invalid configuration:\n  - ALLOW_UNVERIFIED_CITATIONS: must not be true in production; released work may cite only verified knowledge');
  }
  return { allowUnverified: raw === 'true' };
}

export interface ServerConfig {
  core: Config;
  auth: AuthConfig;
  storage: StorageConfig;
  citationPolicy: CitationPolicy;
}

/** Runs every loader and throws once, listing every problem, so a deployment is fixed in one pass (REQ-25). */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const problems: string[] = [];
  const core = tryLoad(problems, () => loadConfig(env));
  // Only the API server and the agent worker need the metrics token; CLIs (migrate, verify, ...) use loadConfig and don't.
  if (env.NODE_ENV === 'production' && !env.METRICS_TOKEN) problems.push(METRICS_TOKEN_REQUIRED);
  const auth = tryLoad(problems, () => loadAuthConfig(env));
  const storage = tryLoad(problems, () => loadStorageConfig(env));
  const citationPolicy = tryLoad(problems, () => loadCitationPolicy(env));
  if (problems.length) throw invalid(problems);
  return { core: core!, auth: auth!, storage: storage!, citationPolicy: citationPolicy! };
}

export interface WorkerConfig {
  core: Config;
  citationPolicy: CitationPolicy;
  agents: AgentConfig;
  /** WORKER_PORT: where the worker serves /healthz, /readyz and /metrics (agent spec §6.4). */
  port: number;
}

/**
 * The agent worker's settings, every problem listed at once (REQ-25). It needs no sign-in or file-storage settings, but
 * like the API it needs the metrics token in production, because it serves /metrics too.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const problems: string[] = [];
  const core = tryLoad(problems, () => loadConfig(env));
  if (env.NODE_ENV === 'production' && !env.METRICS_TOKEN) problems.push(METRICS_TOKEN_REQUIRED);
  const citationPolicy = tryLoad(problems, () => loadCitationPolicy(env));
  const agents = tryLoad(problems, () => loadAgentConfig(env));
  const rawPort = env.WORKER_PORT || '3003';
  if (!isPort(rawPort)) problems.push(`  - WORKER_PORT: ${PORT_MESSAGE}`);
  if (problems.length) throw invalid(problems);
  return { core: core!, citationPolicy: citationPolicy!, agents: agents!, port: Number(rawPort) };
}
