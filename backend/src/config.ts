import path from 'node:path';
import { z } from 'zod';

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
  } catch {
    // No .env file: rely on the real environment.
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
