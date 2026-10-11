import crypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// A minimal, standards-shaped OpenID provider for tests: discovery, JWKS,
// authorization-code flow with PKCE (S256), signed RS256 ID tokens.

export interface MockUser {
  sub: string;
  name: string;
  email?: string;
  groups?: string[];
}

interface PendingCode {
  nonce: string;
  challenge: string;
  clientId: string;
  user: MockUser;
}

export async function startMockOidc() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode>();
  let nextUser: MockUser = { sub: 'user-1', name: 'Test User', groups: [] };

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  app.get('/.well-known/openid-configuration', (_req, res) =>
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    }),
  );
  app.get('/jwks', (_req, res) => res.json({ keys: [jwk] }));

  app.get('/authorize', (req, res) => {
    const q = req.query as Record<string, string>;
    const code = crypto.randomBytes(16).toString('hex');
    codes.set(code, { nonce: q.nonce, challenge: q.code_challenge, clientId: q.client_id, user: nextUser });
    const back = new URL(q.redirect_uri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.state);
    res.redirect(back.href);
  });

  app.post('/token', async (req, res) => {
    const pending = codes.get(req.body.code);
    codes.delete(req.body.code);
    if (!pending) return res.status(400).json({ error: 'invalid_grant' });
    const challenge = crypto.createHash('sha256').update(String(req.body.code_verifier)).digest('base64url');
    if (challenge !== pending.challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    const now = Math.floor(Date.now() / 1000);
    const u = pending.user;
    const idToken = await new SignJWT({ nonce: pending.nonce, name: u.name, email: u.email, groups: u.groups ?? [], auth_time: now })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience(pending.clientId)
      .setSubject(u.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    res.json({ access_token: crypto.randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
  });

  return {
    issuer,
    setUser(user: MockUser) {
      nextUser = user;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
