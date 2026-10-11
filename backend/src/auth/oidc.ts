import type { Role } from '../engine/types';
import type { OidcConfig } from './config';
import { ROLE_PRECEDENCE } from './roles';

// openid-client v6 is ESM-only; this CommonJS backend loads it with import().
type OpenIdClient = typeof import('openid-client', { with: { 'resolution-mode': 'import' } });

export interface OidcChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  name: string;
  email: string | null;
  groups: string[];
  /** When the user last actually authenticated at the IdP (seconds since epoch). */
  authTime: number | null;
}

export interface OidcClient {
  start(): Promise<{ url: string } & OidcChecks>;
  finish(callbackUrl: URL, checks: OidcChecks): Promise<OidcIdentity>;
  /** The identity provider's sign-in URL that forces a fresh password entry, for signing. */
  reauthUrl(checks: OidcChecks): Promise<string>;
}

const text = (v: unknown) => (typeof v === 'string' && v ? v : null);

export async function createOidcClient(cfg: OidcConfig): Promise<OidcClient> {
  const client: OpenIdClient = await import('openid-client');
  const options = cfg.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined;
  const server = await client.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret, undefined, options);

  return {
    async start() {
      const codeVerifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(server, {
        redirect_uri: cfg.redirectUri,
        scope: cfg.scopes,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      return { url: url.href, state, nonce, codeVerifier };
    },

    async reauthUrl(checks) {
      const url = client.buildAuthorizationUrl(server, {
        redirect_uri: cfg.redirectUri,
        scope: cfg.scopes,
        code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
        code_challenge_method: 'S256',
        state: checks.state,
        nonce: checks.nonce,
        prompt: 'login',
        max_age: '0',
      });
      return url.href;
    },
    async finish(callbackUrl, checks) {
      const tokens = await client.authorizationCodeGrant(server, callbackUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('The identity provider returned no ID token');
      const rawGroups = claims[cfg.groupsClaim];
      return {
        issuer: claims.iss,
        subject: claims.sub,
        name: text(claims.name) ?? text(claims.preferred_username) ?? claims.sub,
        email: text(claims.email),
        groups: Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === 'string') : [],
        authTime: typeof claims.auth_time === 'number' ? claims.auth_time : null,
      };
    },
  };
}

/** The most senior role any of the user's groups maps to, or null (pending access). */
export function roleFromGroups(groups: string[], roleMap: Record<string, Role>): Role | null {
  const mapped = new Set(groups.map((g) => roleMap[g]).filter(Boolean));
  return ROLE_PRECEDENCE.find((r) => mapped.has(r)) ?? null;
}
