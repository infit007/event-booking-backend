import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env';
import { closePool, query } from './config/db';
import { closeRedis } from './config/redis';
import { closeNotificationQueue } from './queues/notification.queue';
import { initNotificationWorker, closeNotificationWorker } from './queues/notification.worker';
import { authRoutes } from './routes/auth.routes';
import { eventRoutes } from './routes/event.routes';
import { bookingRoutes } from './routes/booking.routes';
import { notificationRoutes } from './routes/notification.routes';

export async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : 'info',
    },
  });

  // Cross-Origin Resource Sharing
  await server.register(cors, {
    origin: true,
    credentials: true,
  });

  // Health Check Endpoint
  server.get('/health', async (_request, reply) => {
    try {
      const dbCheck = await query('SELECT 1 as healthy');
      const isDbHealthy = dbCheck.rows[0]?.healthy === 1;

      return reply.status(200).send({
        status: isDbHealthy ? 'ok' : 'degraded',
        mode: env.APP_MODE,
        database: isDbHealthy ? 'connected' : 'error',
        timestamp: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      server.log.error(`[HealthCheck] Database check failed: ${errorMsg}`);
      return reply.status(503).send({
        status: 'error',
        mode: env.APP_MODE,
        database: 'unreachable',
        error: errorMsg,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Register API Routes
  await server.register(authRoutes, { prefix: '/api/auth' });
  await server.register(eventRoutes, { prefix: '/api/events' });
  await server.register(bookingRoutes, { prefix: '/api/bookings' });
  await server.register(notificationRoutes, { prefix: '/api/notifications' });

  return server;
}

async function start() {
  const server = await buildServer();

  // Initialize BullMQ background worker
  initNotificationWorker();

  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[Server] Received ${signal}. Commencing graceful shutdown...`);

    try {
      await server.close();
      console.log('[Server] HTTP server closed.');

      await closeNotificationWorker();
      await closeNotificationQueue();
      console.log('[BullMQ] Queue and Worker stopped.');

      await closeRedis();
      console.log('[Redis] Connection closed.');

      await closePool();
      console.log('[PostgreSQL] Database pool closed.');

      console.log('[Server] Graceful shutdown completed cleanly.');
      process.exit(0);
    } catch (err) {
      console.error('[Server] Error during graceful shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  try {
    const address = await server.listen({
      port: env.PORT,
      host: env.HOST,
    });
    console.log(`================================================================`);
    console.log(`🚀 Event Booking API running at ${address}`);
    console.log(`⚙️  Mode: ${env.APP_MODE.toUpperCase()}`);
    console.log(`📧 Email Provider: ${env.EMAIL_PROVIDER.toUpperCase()}`);
    console.log(`📡 Health Check: ${address}/health`);
    console.log(`================================================================`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}
