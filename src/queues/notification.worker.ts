import { Worker, Job } from 'bullmq';
import { createRedisConnection } from '../config/redis';
import { query } from '../config/db';
import {
  sendBookingConfirmationEmail,
  sendEventUpdateEmail,
  BookingConfirmationParams,
  EventUpdateParams,
} from '../services/email.service';
import { notificationQueue, EventUpdatedFanoutPayload } from './notification.queue';

let notificationWorker: Worker | null = null;

export function initNotificationWorker(): Worker {
  if (notificationWorker) {
    return notificationWorker;
  }

  notificationWorker = new Worker(
    'notifications',
    async (job: Job) => {
      switch (job.name) {
        case 'booking-confirmation': {
          const data = job.data as BookingConfirmationParams;
          const result = await sendBookingConfirmationEmail(data);
          if (!result.success) {
            throw new Error(result.error || 'Failed to send booking confirmation email');
          }
          return { status: 'sent', providerId: result.providerId };
        }

        case 'event-updated-fanout': {
          const data = job.data as EventUpdatedFanoutPayload;
          const dbResult = await query<{ email: string; name: string }>(
            `SELECT DISTINCT u.email, u.name
             FROM bookings b
             JOIN users u ON b.customer_id = u.id
             WHERE b.event_id = $1 AND b.status = 'CONFIRMED'`,
            [data.eventId]
          );

          const customers = dbResult.rows;
          if (customers.length === 0) {
            return { fannedOut: 0 };
          }

          const bulkJobs = customers.map((c) => ({
            name: 'event-update-email',
            data: {
              customerEmail: c.email,
              customerName: c.name,
              eventTitle: data.eventTitle,
              venue: data.venue,
              eventDate: data.eventDate,
              updateSummary: data.updateSummary,
              simulatedDelayMs: data.simulatedDelayMs,
            } as EventUpdateParams,
          }));

          await notificationQueue.addBulk(bulkJobs);
          return { fannedOut: bulkJobs.length };
        }

        case 'event-update-email': {
          const data = job.data as EventUpdateParams;
          const result = await sendEventUpdateEmail(data);
          if (!result.success) {
            throw new Error(result.error || 'Failed to send event update email');
          }
          return { status: 'sent', providerId: result.providerId };
        }

        default:
          console.warn(`[BullMQ Worker] Unknown job name received: ${job.name}`);
          return { status: 'ignored' };
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 10,
    }
  );

  notificationWorker.on('completed', (job: Job) => {
    if (process.env.DEBUG_WORKER) {
      console.log(`[BullMQ Worker] Job completed: ${job.name} (ID: ${job.id})`);
    }
  });

  notificationWorker.on('failed', (job: Job | undefined, err: Error) => {
    console.error(`[BullMQ Worker] Job failed: ${job?.name} (ID: ${job?.id}):`, err.message);
  });

  notificationWorker.on('error', (err: Error) => {
    console.error('[BullMQ Worker] Worker encountered error:', err.message);
  });

  console.log('[BullMQ Worker] Notification worker initialized with concurrency 10');
  return notificationWorker;
}

export async function closeNotificationWorker(): Promise<void> {
  if (notificationWorker) {
    console.log('[BullMQ Worker] Shutting down worker...');
    await notificationWorker.close();
    notificationWorker = null;
  }
}
