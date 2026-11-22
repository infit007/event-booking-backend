import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../config/db';
import { authenticate } from '../middleware/auth';

interface NotificationLogRow {
  id: string;
  type: string;
  recipient_email: string;
  subject: string;
  status: 'SENT' | 'FAILED';
  provider_id: string | null;
  error_message: string | null;
  created_at: string;
}

export async function notificationRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/notifications/logs (Authenticated)
  fastify.get(
    '/logs',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await query<NotificationLogRow>(
        `SELECT id, type, recipient_email, subject, status, provider_id, error_message, created_at
         FROM notification_logs
         ORDER BY created_at DESC
         LIMIT 50`
      );

      return reply.send({
        total: result.rowCount,
        logs: result.rows,
      });
    }
  );
}
