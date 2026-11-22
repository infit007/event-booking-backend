import { Queue } from 'bullmq';
import { createRedisConnection } from '../config/redis';
import { BookingConfirmationParams } from '../services/email.service';

export interface EventUpdatedFanoutPayload {
  eventId: string;
  eventTitle: string;
  venue: string;
  eventDate: string | Date;
  updateSummary: string;
  simulatedDelayMs?: number;
}

export const notificationQueue = new Queue('notifications', {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 3600,
      count: 1000,
    },
    removeOnFail: {
      age: 86400,
      count: 5000,
    },
  },
});

export async function enqueueBookingConfirmation(payload: BookingConfirmationParams): Promise<void> {
  await notificationQueue.add('booking-confirmation', payload);
}

export async function enqueueEventUpdatedFanout(payload: EventUpdatedFanoutPayload): Promise<void> {
  await notificationQueue.add('event-updated-fanout', payload);
}

export async function closeNotificationQueue(): Promise<void> {
  await notificationQueue.close();
}
