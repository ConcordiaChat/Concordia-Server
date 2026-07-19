# Concordia Federation — API Reference

> Last updated: July 19, 2026

> The Federation is the sole authentication and settings authority for all Concordia clients.
> Individual servers never receive personal user data — only the user's `id`.

Base URL: `https://federation.concordiachat.com` (local: `http://localhost:3000`)

All request and response bodies are JSON.

### Authentication

The Federation issues **EdDSA (Ed25519) signed JWTs**. Public verification keys
are published at `GET /.well-known/jwks.json` — services verify tokens locally;
there are no shared signing secrets anywhere in the platform.

Two token types exist, distinguished by their `aud` (audience) claim:

| Token | `aud` | Lifetime | Sent to |
|---|---|---|---|
| **Identity token** | `concordia:federation`, `concordia:social` | `JWT_EXPIRES_IN` (default `7d`) | Federation + Social only |
| **Server token** | the chat server's origin, e.g. `https://chat.example.com` | `SERVER_TOKEN_TTL` (default 600 s) | that one chat server only |

All protected Federation endpoints require an **identity token** in the `Authorization` header:
```
Authorization: Bearer <identity token>
```
Identity tokens are issued by `/api/auth/register` and `/api/auth/login`.

> ⚠️ **Never send the identity token to a chat server.** Exchange it for a
> short-lived server-scoped token via [`POST /api/auth/server-token`](#post-apiauthserver-token)
> and send only that. Chat servers reject any token whose `aud` is not their own
> origin, and the Federation and Social reject server-scoped tokens — so a token
> harvested by a malicious server operator is useless anywhere else and expires
> within minutes.

### Signing keys

### `GET /.well-known/jwks.json`

Public JWKS document (RFC 7517). Chat servers and Social verify Federation-issued
tokens against these keys locally (`alg: EdDSA`). Responses are cacheable
(`Cache-Control: public, max-age=300`); key rotation adds a new `kid` while
tokens signed by the old key finish expiring.

**Response `200`**
```json
{ "keys": [ { "kty": "OKP", "crv": "Ed25519", "x": "…", "kid": "…", "alg": "EdDSA", "use": "sig" } ] }
```

### WebSocket Connection

The Federation exposes a Socket.io endpoint at the same URL as the HTTP server.
Clients authenticate by passing their JWT in the `auth` handshake option:

```js
import { io } from 'socket.io-client';

const socket = io('https://federation.concordiachat.com', {
  auth: { token: '<jwt>' }
});
```

On successful connection the client is placed in two rooms:
- `user:<userId>` — events targeted at **your sessions only**
- `presence` — events broadcast to **all connected clients**

See the [WebSocket Events](#websocket-events) section for the full event reference.

---

## Health Check

### `GET /health`

**Response `200`**
```json
{ "status": "ok" }
```

---

## Auth — `/api/auth`

### `POST /api/auth/register`

Creates a new Federation account. Returns a JWT.

**Request body**

| Field | Type | Rules |
|-------|------|-------|
| `username` | string | 3–50 chars. Letters, numbers, `_`, `-` only. |
| `email` | string | Valid email address. |
| `password` | string | Min 8 chars, one uppercase letter, one number. |

```json
{ "username": "petersmith", "email": "peter@example.com", "password": "Secret123" }
```

**`201 Created`**
```json
{
  "message": "Account created successfully.",
  "token": "<jwt>",
  "user": { "id": "a3f8c21d-7e44-4b1c-9f02-3d5e6a8b1c0f", "username": "petersmith", "email": "peter@example.com", "created_at": "..." }
}
```

**`400`** Validation failed · **`409`** Username or email already taken · **`500`** Server error

---

### `POST /api/auth/login`

Authenticates an existing user. Returns a JWT.

**Request body**

| Field | Type |
|-------|------|
| `email` | string |
| `password` | string |

**`200 OK`**
```json
{
  "message": "Login successful.",
  "token": "<jwt>",
  "user": { "id": "a3f8c21d-7e44-4b1c-9f02-3d5e6a8b1c0f", "username": "petersmith", "email": "peter@example.com" }
}
```

**`400`** Validation failed · **`401`** Invalid credentials · **`500`** Server error

> The same `401` message is returned for both unknown email and wrong password to prevent user enumeration.

### `POST /api/auth/server-token`

🔒 Requires identity token.

Exchanges the caller's identity token for a **short-lived token scoped to one
chat server** (OAuth-style token exchange). The token's `aud` claim is the
normalized origin of the requested server; the server verifies it locally
against the Federation JWKS and rejects tokens minted for anyone else.

The token also embeds `preferred_username` and `avatar_url` claims so servers
can render the member without calling the Federation.

**Request body**

| Field | Type | Rules |
|-------|------|-------|
| `server` | string | The server's address (`https://chat.example.com`, bare hosts assume `https`) |

**`200 OK`**
```json
{
  "token": "<server-scoped jwt>",
  "audience": "https://chat.example.com",
  "expires_in": 600
}
```

**`400`** Invalid server address · **`401`** Missing/invalid identity token · **`500`** Server error

> Clients should cache the token per server and refresh shortly before
> `expires_in` elapses (the reference client refreshes 60 s early).

### `POST /api/auth/refresh`

Rotating refresh. Body: `{ "refresh_token": "<token>" }` → `200` with a fresh
`{ token, refresh_token, expires_in }` pair. The presented token is revoked on
use; **presenting an already-rotated token revokes every refresh token on the
account** (stolen-token defense) → `401 "Session revoked."`.

### `POST /api/auth/logout`

🔒 Requires identity token. Optional body: `{ "refresh_token": "<token>" }`.
Blacklists the identity token's `jti` (immediately invalid on every service)
and revokes the refresh token.

### Email verification

- `POST /api/auth/verify-email/request` 🔒 — sends a one-time 24 h link
  (page: `/account/verify-email.html`). Rate limit: 5/h per IP.
- `POST /api/auth/verify-email/confirm` — body `{ token }` → marks the email
  verified. Links are single-use.

### Password reset

- `POST /api/auth/password-reset/request` — body `{ email }`. **Always `200`**
  (no user enumeration); if the account exists, a one-time 1 h link is emailed
  (page: `/account/reset-password.html`). Rate limit: 5/h per IP.
- `POST /api/auth/password-reset/confirm` — body `{ token, password }`
  (standard password rules). A successful reset revokes every refresh token on
  the account.

### TOTP 2FA — `/api/auth/mfa`

- `POST /setup` 🔒 → `{ secret, otpauth_uri }` (RFC 6238, SHA-1/6-digit/30 s —
  works with any authenticator app). Inactive until confirmed.
- `POST /enable` 🔒 — body `{ code }` (live TOTP) → enables 2FA, returns
  `{ backup_codes: [8 single-use codes] }` **exactly once**.
- `POST /disable` 🔒 — body `{ code }` (TOTP or backup code).
- `POST /verify` — body `{ mfa_token, code }`. Completes a login that returned
  `{ mfa_required: true, mfa_token }`. The `mfa_token` lives 5 minutes and is
  single-use; backup codes are consumed on use.

> With 2FA enabled, `POST /api/auth/login` returns
> `{ "mfa_required": true, "mfa_token": "<jwt>" }` and **no session tokens**.

### Rate limits & lockout

Credential endpoints (login, register, refresh, confirms, mfa/verify):
**10 requests / 15 min / IP**. Email-sending endpoints: **5 / h / IP**.
Server-token exchange: **60 / min / IP**. Global API: 300 / 15 min / IP.
Additionally, **5 failed logins within 15 minutes lock the account for
15 minutes** (`429`, even for the correct password).

---

## User — `/api/user` 🔒

### `GET /api/user/me`

Returns the authenticated user's profile joined with their current settings.

**`200 OK`**
```json
{
  "user": {
    "id": "a3f8c21d-7e44-4b1c-9f02-3d5e6a8b1c0f",
    "username": "petersmith",
    "email": "peter@example.com",
    "created_at": "...",
    "display_name": "Peter",
    "avatar_url": "https://example.com/avatar.png",
    "banner_url": "https://example.com/banner.png",
    "bio": "Just a person who loves building stuff.",
    "profile_link": "https://linktr.ee/petersmith",
    "theme": "dark",
    "status": "online",
    "custom_status": "Working from home 🏠",
    "custom_status_expires_at": "2026-03-08T18:10:00.000Z",
    "last_seen": "..."
  }
}
```

**`401`** Missing/invalid token · **`404`** User not found · **`500`** Server error

---

## Status — `/api/user` 🔒

Users have five possible statuses:

| Value | Meaning |
|-------|---------|
| `online` | Actively connected to the Federation. |
| `idle` | Logged in but no recent client activity (set by the client after inactivity). |
| `dnd` | Do Not Disturb — manually set. |
| `invisible` | Logged in but appears `offline` to all other users. |
| `offline` | Not logged in, or manually set. |

### `PUT /api/user/status`

Explicitly sets the authenticated user’s status.

**Request body**

| Field | Type | Rules |
|-------|------|-------|
| `status` | string | **Required.** `online` \| `idle` \| `dnd` \| `invisible` \| `offline` |
| `custom_status` | string | Optional. Max 100 chars. Send `""` to clear. |
| `custom_status_duration` | string | Optional. How long the custom status lasts. Ignored if `custom_status` is empty. |

**`custom_status_duration` values**

| Value | Duration |
|-------|----------|
| `15m` | 15 minutes |
| `1h` | 1 hour |
| `8h` | 8 hours |
| `24h` | 24 hours |
| `48h` | 48 hours |
| `3d` | 3 days |
| `never` | Never expires (default if omitted) |

```json
{ "status": "dnd", "custom_status": "In a meeting", "custom_status_duration": "1h" }
```

**`200 OK`**
```json
{ "status": "dnd", "custom_status": "In a meeting", "custom_status_expires_at": "2026-03-07T21:15:00.000Z" }
```

> Expiry is enforced server-side. Once `custom_status_expires_at` is in the past, `custom_status` and `custom_status_expires_at` are returned as `null` — no client action required.

**`400`** Invalid status value · **`401`** Missing/invalid token · **`500`** Server error

---

### `POST /api/user/heartbeat`

Updates `last_seen` to now. If the user’s current status is `offline`, it is automatically switched to `online`.

Clients should call this on a regular interval (e.g. every 30–60 seconds) while the user is active, and call `PUT /api/user/status` with `idle` after a period of inactivity.

**`200 OK`**
```json
{ "ok": true }
```

**`401`** Missing/invalid token · **`500`** Server error

---

### `GET /api/user/status/:id`

Returns the visible status of any user by their UUID.

> `invisible` users are returned as `offline` — the caller cannot tell the difference.

**`200 OK`**
```json
{ "status": "online", "custom_status": "Working from home 🏠", "custom_status_expires_at": "2026-03-08T18:10:00.000Z", "last_seen": "..." }
```

**`401`** Missing/invalid token · **`404`** User not found · **`500`** Server error

---

## Settings — `/api/settings` 🔒

Globally synced across every client the user is logged into.

### `GET /api/settings`

Returns the authenticated user's settings.

**`200 OK`**
```json
{
  "settings": {
    "display_name": "Peter",
    "avatar_url": "https://example.com/avatar.png",
    "banner_url": "https://example.com/banner.png",
    "bio": "Just a person who loves building stuff.",
    "profile_link": "https://linktr.ee/petersmith",
    "theme": "dark",
    "updated_at": "..."
  }
}
```

---

### `PUT /api/settings`

Updates one or more settings fields. Only sent fields are changed (others are left as-is).

**Request body** — all fields optional

| Field | Type | Rules |
|-------|------|-------|
| `display_name` | string | Max 100 chars. |
| `avatar_url` | string | Must be a valid URL. Profile picture. |
| `banner_url` | string | Must be a valid URL. Profile banner. |
| `bio` | string | Max 500 chars. |
| `profile_link` | string | Must be a valid URL. Link shown on the profile (e.g. Linktree, personal site). |
| `theme` | string | `"dark"` or `"light"`. |

> `custom_status` is updated via `PUT /api/user/status`, not this endpoint.

```json
{ "display_name": "Peter", "theme": "light" }
```

**`200 OK`** Returns updated settings object.

**`400`** Validation failed · **`401`** Missing/invalid token · **`500`** Server error

---

## Servers — `/api/servers` 🔒

The user's personal server list, stored in the Federation.
Clients use this to populate the left-hand sidebar. No personal user data is ever sent to servers.

### `GET /api/servers`

Returns the authenticated user's full server list, ordered by `position`.

**`200 OK`**
```json
{
  "servers": [
    { "id": "a3f8c21d-7e44-4b1c-9f02-3d5e6a8b1c0f", "server_address": "192.168.1.10:8080", "server_name": "My Home Server", "position": 0, "added_at": "..." },
    { "id": "b7e2d14f-3c55-4a2b-8e01-1f4d7b9c2e1a", "server_address": "play.concordia.gg:8080", "server_name": null, "position": 1, "added_at": "..." }
  ]
}
```

---

### `POST /api/servers`

Adds a server to the user's list.

**Request body**

| Field | Type | Rules |
|-------|------|-------|
| `server_address` | string | Required. IP or domain:port. Max 255 chars. |
| `server_name` | string | Optional. The server's display name, fetched from the server by the client and pushed here. Max 100 chars. |

```json
{ "server_address": "192.168.1.10:8080", "server_name": "My Home Server" }
```

**`201 Created`**
```json
{
  "server": { "id": "a3f8c21d-7e44-4b1c-9f02-3d5e6a8b1c0f", "server_address": "192.168.1.10:8080", "server_name": "My Home Server", "position": 0, "added_at": "..." }
}
```

**`400`** Validation failed · **`401`** Missing/invalid token · **`409`** Server already in list · **`500`** Server error

---

### `PATCH /api/servers/:id`

Updates the `nickname` or `position` of an entry. Only sent fields are changed.

**Request body** — all fields optional

| Field | Type | Rules |
|-------|------|-------|
| `server_name` | string | The server's display name pushed from the client. Max 100 chars. |
| `position` | integer | Non-negative integer. |

**`200 OK`** Returns updated server object.

**`400`** Validation failed · **`401`** Missing/invalid token · **`404`** Not found · **`500`** Server error

---

### `DELETE /api/servers/:id`

Removes a server from the user's list.

**`204 No Content`** — deleted successfully.

**`401`** Missing/invalid token · **`404`** Not found · **`500`** Server error

---

## Admin

Admin API endpoints, the web dashboard, and admin-related WebSocket events are documented separately.

See [Admin.md](./Admin.md).

---

## WebSocket Events

Socket URL: `wss://federation.concordiachat.com`  
Library: [Socket.io v4](https://socket.io/docs/v4/)

### Connection

```js
const socket = io('https://federation.concordiachat.com', {
  auth: {
    token:    localStorage.getItem('fed_token'),
    platform: 'desktop', // 'desktop' | 'web' | 'mobile_web' — defaults to 'web' if omitted
  },
});

socket.on('connect_error', (err) => {
  // err.message: 'Authentication required.' or 'Invalid or expired token.'
});
```

The `platform` field tells the Federation which type of client is connecting. It is used to track live session counts by platform (visible in the admin Metrics tab). Valid values:

| Value | Description |
|---|---|
| `desktop` | Concordia desktop application |
| `web` | Browser web client |
| `mobile_web` | Mobile browser client |

Unrecognised or missing values default to `web`.

---

### Client → Server events

#### `ping`
Sent by the client on its heartbeat interval (recommended: every 25–30 s).  
The server replies with `heartbeat_ack`. Also call `POST /api/user/heartbeat` on the same interval to update `last_seen` in the database.

If the server stops receiving pings it closes the socket after `pingTimeout` (60 s). Once the user's last socket closes, the Federation waits an 8-second grace period before writing `offline` to the database and emitting `status_change` — this absorbs page reloads and brief network drops without flapping presence.

```js
setInterval(() => socket.emit('ping'), 25000);
```

---

### Server → Client events

#### `heartbeat_ack`
Room: **requesting socket only**  
Sent in response to a `ping`. Returns the server’s current UTC time so clients can detect clock skew.

```json
{ "server_time": "2026-03-07T18:10:00.000Z" }
```

---

#### `status_change`
Room: **presence** (all connected clients)  
Fired whenever any user calls `PUT /api/user/status` or their status changes.  
`invisible` users are always emitted as `offline` — the real status is never sent to other clients.  
`custom_status` and `custom_status_expires_at` are `null` when the custom status has expired or been cleared.

```json
{ "userId": "a3f8c21d-...", "status": "online", "custom_status": "Working from home 🏠", "custom_status_expires_at": "2026-03-08T18:10:00.000Z" }
```

---

#### `settings_sync`
Room: **user:\<userId\>** (your sessions only, excluding the socket that triggered the change)  
Fired when `PUT /api/settings` succeeds. All your other open clients should apply these values immediately.

```json
{ "display_name": "Peter", "avatar_url": "https://...", "banner_url": "https://...", "bio": "...", "profile_link": "https://...", "theme": "dark", "updated_at": "..." }
```

---

#### `server_list_sync`
Room: **user:\<userId\>** (your sessions only, excluding the triggering socket)  
Fired after any `POST`, `PATCH`, or `DELETE` to `/api/servers`. Contains the full updated list so clients don’t need to diff.

```json
{
  "servers": [
    { "id": "...", "server_address": "...", "server_name": "...", "position": 0, "added_at": "..." }
  ]
}
```

---

#### `session_revoked`, `account_updated`, `admin_notice`
These events are emitted as side-effects of admin actions. See [Admin.md](./Admin.md#admin-related-websocket-events) for full details.

---

## Database Schema

```
users
├── id             UUID         PRIMARY KEY DEFAULT gen_random_uuid()
├── username       VARCHAR(50)  UNIQUE NOT NULL
├── email          VARCHAR(255) UNIQUE NOT NULL
├── password_hash  VARCHAR(255) NOT NULL          ← bcrypt hash, never plaintext
├── created_at     TIMESTAMPTZ  DEFAULT NOW()
└── updated_at     TIMESTAMPTZ  DEFAULT NOW()

user_settings                                     ← one row per user, globally synced
├── user_id        UUID PRIMARY KEY → users.id
├── display_name   VARCHAR(100)
├── avatar_url     VARCHAR(500)                     ← profile picture
├── banner_url     VARCHAR(500)                     ← profile banner
├── bio            VARCHAR(500)
├── profile_link   VARCHAR(500)
├── theme          VARCHAR(20)  DEFAULT 'dark'
├── status         VARCHAR(20)  DEFAULT 'offline'  ← online | idle | dnd | invisible | offline
├── custom_status  VARCHAR(100)                     ← text shown alongside the base status
├── custom_status_expires_at  TIMESTAMPTZ          ← null = never expires
├── last_seen      TIMESTAMPTZ                      ← updated by heartbeat / PUT /status
└── updated_at     TIMESTAMPTZ  DEFAULT NOW()

user_servers                                      ← server list, no user PII sent to servers
├── id             UUID         PRIMARY KEY DEFAULT gen_random_uuid()
├── user_id        UUID → users.id
├── server_address VARCHAR(255) NOT NULL
├── server_name    VARCHAR(100)        ← pushed by client from the server
├── position       INTEGER DEFAULT 0
└── added_at       TIMESTAMPTZ  DEFAULT NOW()
```

