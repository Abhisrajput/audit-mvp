import { z } from 'zod';
import type { Role } from '../engine/types';
import { isRole } from './roles';
import type { SessionPolicy } from './session-repo';

// Identity settings for the API server. The database-only commands (migrate,
// seed, import-json, verify) keep using loadConfig() and need none of this.

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Public URL of /auth/callback as registered with the identity provider. */
  redirectUri: string;
  /** ID-token claim listing the user's groups. */
  groupsClaim: string;
  /** Identity-provider group → role. */
  roleMap: Record<string, Role>;
  /** Plain-http identity provider allowed (development and tests only). */
  allowInsecure: boolean;
}

export interface AuthConfig {
  devAuth: boolean;
  secureCookies: boolean;
  /** Where the browser app lives; used after sign-in. */
  publicUrl: string;
  session: SessionPolicy;
  oidc: OidcConfig | null;
}

const flag = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

const AuthEnv = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DEV_AUTH: flag,
    PUBLIC_URL: z.string().url().default('http://localhost:5174'),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).default(30),
    SESSION_MAX_HOURS: z.coerce.number().int().min(1).default(12),
    OIDC_ISSUER: z.string().url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_REDIRECT_URI: z.string().url().optional(),
    OIDC_GROUPS_CLAIM: z.string().min(1).default('groups'),
    OIDC_ROLE_MAP: z.string().default('{}'),
  })
  .superRefine((env, ctx) => {
    const production = env.NODE_ENV === 'production';
    if (production && env.DEV_AUTH) {
      ctx.addIssue({ code: 'custom', path: ['DEV_AUTH'], message: 'DEV_AUTH must not be true in production' });
    }
    const oidcSet = !!(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_REDIRECT_URI);
    if (!env.DEV_AUTH && !oidcSet) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_REDIRECT_URI are required unless DEV_AUTH=true' });
    }
    if (production && env.OIDC_ISSUER && !env.OIDC_ISSUER.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'OIDC_ISSUER must use https in production' });
    }
    if (parseRoleMap(env.OIDC_ROLE_MAP) === null) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ROLE_MAP'], message: 'OIDC_ROLE_MAP must be a JSON object of group → auditor | audit_manager | cae | admin | viewer' });
    }
  });

function parseRoleMap(raw: string): Record<string, Role> | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.values(value).every(isRole) ? (value as Record<string, Role>) : null;
  } catch {
    return null;
  }
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  // Compose passes unset optional settings as empty strings; treat them as absent.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = AuthEnv.safeParse(present);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  return {
    devAuth: e.DEV_AUTH,
    secureCookies: production,
    publicUrl: e.PUBLIC_URL.replace(/\/$/, ''),
    session: { idleMinutes: e.SESSION_IDLE_MINUTES, maxHours: e.SESSION_MAX_HOURS },
    oidc:
      e.OIDC_ISSUER && e.OIDC_CLIENT_ID && e.OIDC_REDIRECT_URI
        ? {
            issuer: e.OIDC_ISSUER,
            clientId: e.OIDC_CLIENT_ID,
            clientSecret: e.OIDC_CLIENT_SECRET,
            redirectUri: e.OIDC_REDIRECT_URI,
            groupsClaim: e.OIDC_GROUPS_CLAIM,
            roleMap: parseRoleMap(e.OIDC_ROLE_MAP) ?? {},
            allowInsecure: !production,
          }
        : null,
  };
}
