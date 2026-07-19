import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface AuthRequest extends Request {
  user?: { id: string; username: string; avatar_url: string | null };
}

// ── Federation token verification ─────────────────────────────────────────────
// The server holds NO secrets. It verifies server-scoped tokens locally
// against the Federation's published JWKS (EdDSA public keys) and accepts
// only tokens whose `aud` claim is this server's own public origin.
//
// This means:
//  - a token minted for another server is useless here (wrong audience)
//  - a user's Federation identity token is useless here (federation audience)
//  - no round-trip to the Federation on the request path — jose caches the
//    JWKS and refetches on unknown-kid (i.e. key rotation) automatically.

const FEDERATION_URL =
  process.env.FEDERATION_URL || 'https://federation.concordiachat.com';

/** Canonical origin form shared with the Federation's audience normalizer. */
function normalizeOrigin(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  return new URL(withScheme).origin.toLowerCase();
}

const FEDERATION_ORIGIN = normalizeOrigin(FEDERATION_URL);

// This server's own public origin — the `aud` value it accepts. Required in
// production; falls back to localhost:PORT for local development.
const SERVER_PUBLIC_ORIGIN = normalizeOrigin(
  process.env.SERVER_PUBLIC_ORIGIN ||
    `http://localhost:${process.env.PORT || 3001}`,
);

if (!process.env.SERVER_PUBLIC_ORIGIN) {
  console.warn(
    `[auth] SERVER_PUBLIC_ORIGIN not set — accepting tokens for ${SERVER_PUBLIC_ORIGIN}. ` +
      'Set it to this server\'s public URL in production.',
  );
}

const JWKS = createRemoteJWKSet(
  new URL(`${FEDERATION_ORIGIN}/.well-known/jwks.json`),
  { cooldownDuration: 30_000, cacheMaxAge: 600_000 },
);

export async function verifyFederationToken(
  token: string,
): Promise<{ id: string; username: string; avatar_url: string | null } | null> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      algorithms: ['EdDSA'],
      audience: SERVER_PUBLIC_ORIGIN,
      issuer: FEDERATION_ORIGIN,
    });

    if (!payload.sub) return null;

    return {
      id: payload.sub,
      username: (payload.preferred_username as string | null) ?? payload.sub,
      avatar_url: (payload.avatar_url as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

// ── HTTP middleware ────────────────────────────────────────────────────────────

export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const user = await verifyFederationToken(token);

  if (!user) {
    res.status(401).json({ error: 'Invalid or expired federation token' });
    return;
  }

  req.user = user;
  next();
}
