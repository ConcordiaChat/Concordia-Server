> [!CAUTION]
> **Concordia has reached its end of life (October 2026).**
>
> Concordia was a proof of concept for one identity across many self-hosted chat servers. It showed the idea works, and other projects have since done it far better. The hosted app, Federation, Social and chat servers at concordiachat.com have been shut down, and this repository is no longer maintained. The code stays public for reference.

# Concordia Server

Real-time chat server built with **Node.js**, **Socket.IO**, **Express**, and **PostgreSQL**.  
Architecture is intentionally simple so the client team can build on top of it quickly.

## Quick start (Docker — recommended)

Two deployment modes are available. Both persist data via named Docker volumes.

### Option A — Single container *(easiest)*

PostgreSQL and the Node server run together in one image. No `.env` required for a basic setup.

```bash
# Start (builds on first run)
docker compose -f docker-compose.single.yml up --build

# The server is now available at http://localhost:3000
```

> Set `ADMIN_USER_ID` in a `.env` file (or inline) to bootstrap an admin account on first start.

### Option B — Two containers *(recommended for production)*

PostgreSQL and the server run as separate services, making it easier to back up the database, scale, or upgrade each component independently.

```bash
# 1. Copy the env template and fill in the required values
cp .env.example .env
#    → set DB_PASSWORD and JWT_SECRET at minimum

# 2. Start everything (Postgres + server)
docker compose up --build

# 3. The server is now available at http://localhost:3000
```

The first time the server starts it will automatically run `migrations/001_schema.sql`,
which creates the schema and seeds a **#general** channel.

## Deploy to Railway

Railway runs the **Node server** as a standard Railpack service. PostgreSQL is a separate
Railway-managed database — no Docker or single-container image required.

### 1. Create the project

1. Push this repo to GitHub (or connect it in Railway directly)
2. In Railway click **"+ New"** → **"GitHub Repo"** → select `Concordia-Server`
3. Railway detects `railway.toml` and uses Railpack automatically

### 2. Add PostgreSQL

1. In your Railway project click **"+ New"** → **"Database"** → **"Add PostgreSQL"**
2. Railway creates a managed Postgres instance and injects `DATABASE_URL` into every
   service in the project automatically — no connection string to copy or configure
3. The server connects on startup and runs migrations automatically

### 3. Add a volume (persistent media)

Railway's default filesystem is ephemeral — files are lost on redeploy. To persist
uploaded server icons and media:

1. Open the **Concordia-Server** service → **Volumes** tab
2. Click **Add Volume**
3. Set **Mount path** to `/data/media`
4. In the **Variables** tab add `MEDIA_PATH=/data/media`

The volume is mounted at that path at runtime and survives deploys and restarts.
`MEDIA_PATH` tells the server where to read and write files.

### 4. Set environment variables

In the service **Variables** tab:

| Variable | Required | Value |
|---|---|---|
| `ADMIN_USER_ID` | **yes** | Your Federation user UUID (bootstraps server owner on first deploy) |
| `CLIENT_ORIGIN` | **yes** | Your frontend URL e.g. `https://app.concordiachat.com` |
| `MEDIA_PATH` | **yes** | `/data/media` |
| `FEDERATION_URL` | no | Only needed for self-hosted Federation — omit to use the public one |

> `DATABASE_URL` and `PORT` are injected by Railway automatically. Do not set them.

## Local development (no Docker)

```bash
# Prerequisites: Node 20+, a running Postgres 14+ instance

npm install
cp .env.example .env   # edit DB_* and JWT_SECRET

npm run dev            # ts-node-dev with live reload
```

## Project layout

```
src/
  index.ts               # HTTP server + Socket.IO bootstrap
  config/
    database.ts          # pg connection pool (DATABASE_URL or DB_* vars)
  middleware/
    auth.ts              # Federation JWT Bearer auth (Express + Socket.IO)
  routes/
    auth.ts              # POST /api/auth/register, /login
    server.ts            # Server info, join/leave, members, settings, load
    categories.ts        # CRUD + reorder /api/categories
    channels.ts          # CRUD + reorder /api/channels
    messages.ts          # History, edit, delete /api/messages
    roles.ts             # Roles, member assignments, permission overrides
    upload.ts            # POST /api/upload/icon (server icon)
    cdn.ts               # CDN health, metrics, optimize
  socket/
    index.ts             # Socket.IO initialisation & Federation JWT middleware
    handlers.ts          # All real-time event handlers
migrations/
  001_schema.sql         # Consolidated idempotent schema + seed (auto-run on startup)
```

## REST API

All authenticated endpoints require an `Authorization: Bearer <token>` header (Federation JWT).

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | — | Create account → `{ token, user }` |
| POST | `/api/auth/login` | — | Login → `{ token, user }` |

### Server

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/server/info` | — | Server metadata (name, description, member count, icon URL) |
| POST | `/api/server/load` | ✓ | Bulk load — joins server, returns `{ server, me, members, channels, categories }` in one call |
| POST | `/api/server/join` | ✓ | Explicit join (idempotent); broadcasts `member:joined` if new |
| DELETE | `/api/server/@me` | ✓ | Leave server (owner cannot leave) |
| GET | `/api/server/@me` | ✓ | Calling user's member record, `is_owner`, and assigned roles |
| GET | `/api/server/members` | ✓ | All members with roles and `is_owner` flags |
| GET | `/api/server/settings` | ✓ Admin | All admin-configurable settings |
| PATCH | `/api/server/settings` | ✓ Admin | Update server settings (`name`, `description`, `admin_user_id`, `media_compression_level`) |

### Categories

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/categories` | ✓ | List all categories ordered by position |
| POST | `/api/categories` | ✓ MANAGE_CATEGORIES | Create category |
| PUT | `/api/categories/reorder` | ✓ MANAGE_CATEGORIES | Atomically reorder categories |
| PATCH | `/api/categories/:id` | ✓ MANAGE_CATEGORIES | Update category name / position |
| DELETE | `/api/categories/:id` | ✓ MANAGE_CATEGORIES | Delete category (channels become uncategorized) |

### Channels

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/channels` | ✓ | List channels the user has VIEW_CHANNELS permission for |
| POST | `/api/channels` | ✓ MANAGE_CHANNELS | Create channel |
| PUT | `/api/channels/reorder` | ✓ MANAGE_CHANNELS | Atomically reorder channels (supports category moves) |
| PATCH | `/api/channels/:id` | ✓ MANAGE_CHANNELS | Update channel name / description / category / position |
| DELETE | `/api/channels/:id` | ✓ MANAGE_CHANNELS | Delete channel |

### Messages

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/messages/:channelId` | ✓ VIEW_CHANNELS | Fetch history (query: `limit`, `before`) — requires READ_MESSAGE_HISTORY |
| PATCH | `/api/messages/:id` | ✓ | Edit message (author only) |
| DELETE | `/api/messages/:id` | ✓ | Delete message (author or MANAGE_MESSAGES with role hierarchy check) |

### Roles & Permissions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/roles` | ✓ | List all roles |
| POST | `/api/roles` | ✓ MANAGE_ROLES | Create role (ADMINISTRATOR cannot be granted) |
| PATCH | `/api/roles/:id` | ✓ MANAGE_ROLES | Update role name / color / position / permissions |
| DELETE | `/api/roles/:id` | ✓ MANAGE_ROLES | Delete role (`@everyone` cannot be deleted) |
| GET | `/api/roles/members/:userId` | ✓ | Roles assigned to a user |
| PUT | `/api/roles/members/:userId` | ✓ MANAGE_ROLES | Set roles for a user |
| GET | `/api/roles/permissions` | ✓ | All permission names and their bit values |
| GET | `/api/roles/@me/permissions` | ✓ | Resolve calling user's effective permissions (optional `?channelId=`) |
| GET | `/api/roles/overrides/channel/:channelId` | ✓ | Channel permission overrides for all roles |
| PUT | `/api/roles/overrides/channel/:channelId/:roleId` | ✓ MANAGE_CHANNELS | Set channel override (`allow_bits`, `deny_bits`) |
| DELETE | `/api/roles/overrides/channel/:channelId/:roleId` | ✓ MANAGE_CHANNELS | Delete channel override |
| GET | `/api/roles/overrides/category/:categoryId` | ✓ | Category permission overrides for all roles |
| PUT | `/api/roles/overrides/category/:categoryId/:roleId` | ✓ MANAGE_CATEGORIES | Set category override |
| DELETE | `/api/roles/overrides/category/:categoryId/:roleId` | ✓ MANAGE_CATEGORIES | Delete category override |

### Upload & CDN

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/upload/icon` | ✓ MANAGE_SERVER | Upload server icon (multipart/form-data, max 8 MB, PNG/JPG/GIF/WebP) |
| DELETE | `/api/upload/icon` | ✓ MANAGE_SERVER | Remove server icon |
| GET | `/api/cdn/health` | ✓ MANAGE_SERVER | Disk usage stats and per-subfolder file counts |
| GET | `/api/cdn/metrics` | ✓ MANAGE_SERVER | Ingress/egress totals, per-subfolder breakdown, 30-day daily history |
| POST | `/api/cdn/optimize` | ✓ MANAGE_SERVER | Re-compress all CDN images at current `media_compression_level` |

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Server health check |

## Socket.IO events

Connect with `{ auth: { token: "<Federation JWT>" } }`.

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `channel:join` | `channelId: number` | Join a channel room (requires VIEW_CHANNELS) |
| `channel:leave` | `channelId: number` | Leave a channel room |
| `message:send` | `{ channelId, content }` | Send a message (requires SEND_MESSAGES) |
| `message:edit` | `{ messageId, content }` | Edit a message (author only) |
| `message:delete` | `{ messageId }` | Delete a message (author or MANAGE_MESSAGES) |
| `typing:start` | `channelId: number` | Broadcast typing started |
| `typing:stop` | `channelId: number` | Broadcast typing stopped |

### Server → Client (targeted)

These events are sent only to the requesting socket.

| Event | Payload | Description |
|-------|---------|-------------|
| `channel:joined` | `{ channelId, name }` | Confirms you joined the channel room |
| `error` | `{ message: string }` | Server-side validation or permission error |

### Server → Client (room / global broadcasts)

These events are broadcast to all relevant connected clients automatically when the underlying data changes — no polling needed.

| Event | Trigger | Payload |
|-------|---------|---------|
| `user:joined` | Another user joins a channel room | `{ channelId, user: { id, username, avatar_url } }` |
| `user:left` | Another user leaves a channel room | `{ channelId, user: { id, username, avatar_url } }` |
| `message:new` | New message sent | `{ id, channelId, content, createdAt, user }` |
| `message:edited` | Message edited | `{ id, channelId, content, is_edited: true }` |
| `message:deleted` | Message deleted | `{ id, channelId }` |
| `typing:update` | Typing state changed | `{ channelId, user: { id, username }, isTyping }` |
| `channel:created` | Channel created | Full channel object |
| `channel:updated` | Channel updated | Full channel object |
| `channel:deleted` | Channel deleted | `{ id }` |
| `channels:reordered` | Channels reordered | Array of all channels |
| `channel:overrides_updated` | Channel permission override changed | `{ channel_id, role_id, allow_bits, deny_bits, deleted? }` |
| `category:created` | Category created | Full category object |
| `category:updated` | Category updated | Full category object |
| `category:deleted` | Category deleted | `{ id }` |
| `categories:reordered` | Categories reordered | Array of all categories |
| `category:overrides_updated` | Category permission override changed | `{ category_id, role_id, allow_bits, deny_bits, deleted? }` |
| `member:joined` | User joined the server | `{ user_id, username, avatar_url, joined_at, is_owner }` |
| `member:left` | User left the server | `{ user_id, username }` |
| `member:roles_updated` | User's roles changed | `{ user_id, roles }` |
| `role:created` | Role created | Full role object |
| `role:updated` | Role updated | Full role object |
| `role:deleted` | Role deleted | `{ id }` |
| `server:updated` | Server settings updated | `{ name?, description?, icon_url? }` |

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | no | `3000` | HTTP port |
| `HOST` | no | `0.0.0.0` | HTTP bind address |
| `DB_HOST` | no | `localhost` | Postgres host |
| `DB_PORT` | no | `5432` | Postgres port |
| `DB_NAME` | no | `concordia` | Database name |
| `DB_USER` | no | `concordia` | Database user |
| `DB_PASSWORD` | yes *(Docker only)* | — | Database password |
| `DATABASE_URL` | yes *(Railway / managed Postgres)* | — | Full Postgres connection string — injected automatically by Railway |
| `DB_SSL` | no | auto | Set `false` to disable SSL when using `DATABASE_URL` |
| `JWT_SECRET` | yes | — | Secret for signing local auth tokens |
| `CLIENT_ORIGIN` | no | `*` | CORS allowed origin |
| `MEDIA_PATH` | no | `./media` | Path for uploaded media files (set to `/data/media` on Railway) |
| `ADMIN_USER_ID` | no | — | Federation user UUID — bootstraps server owner on first start |
| `FEDERATION_URL` | no | `https://federation.concordiachat.com` | Override for self-hosted Federation instances |

## Related repositories

| Repo | Description |
|---|---|
| [Concordia](https://github.com/Postman67/Concordia) | Marketing frontend |
| [Concordia-Federation](https://github.com/Postman67/Concordia-Federation) | Global identity — usernames, auth, server registry |
| [Concordia-Client](https://github.com/Postman67/Concordia-Client) | User-facing chat application |
| [Concordia-Server](https://github.com/Postman67/Concordia-Server) | Self-hostable server software |
| [Concordia-Social](https://github.com/Postman67/Concordia-Social) | Friends and direct messaging service |
