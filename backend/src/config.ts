import path from 'node:path';
import { z } from 'zod';
import type { CitationPolicy } from './engine/trust';

// Configuration comes from the environment only, validated once at start-up.
// Plan 1F extends this schema (identity, storage, security settings).

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL'),
  PACKS_DIR: z.string().min(1).optional(),
});

export interface Config {
  port: number;
  databaseUrl: string;
  packsDir?: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return { port: parsed.data.PORT, databaseUrl: parsed.data.DATABASE_URL, packsDir: parsed.data.PACKS_DIR };
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
