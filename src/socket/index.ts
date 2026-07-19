import { Server } from 'socket.io';
import { pool } from '../config/database';
import { verifyFederationToken } from '../middleware/auth';
import { registerChatHandlers } from './handlers';

export function initializeSocket(io: Server): void {
  // Verify every Socket.IO connection locally against the Federation JWKS.
  // The handshake token must be a server-scoped token minted for THIS
  // server's origin (see middleware/auth.ts) — identity tokens are rejected.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    const user = await verifyFederationToken(token);
    if (!user) {
      return next(new Error('Invalid or expired federation token'));
    }

    socket.data.user = user;

    // Refresh the member's cached username and avatar on every fresh connection
    try {
      await pool.query(
        `INSERT INTO members (user_id, username, avatar_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, avatar_url = EXCLUDED.avatar_url`,
        [user.id, user.username, user.avatar_url],
      );
    } catch (err) {
      console.error('[socket] member upsert failed:', err);
    }

    next();
  });

  io.on('connection', (socket) => {
    const { username } = socket.data.user as { id: string; username: string; avatar_url: string | null };
    console.log(`[socket] connected: ${username} (${socket.id})`);

    registerChatHandlers(io, socket);

    socket.on('disconnect', () => {
      console.log(`[socket] disconnected: ${username} (${socket.id})`);
    });
  });
}
