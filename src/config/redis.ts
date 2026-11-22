import Redis, { RedisOptions } from 'ioredis';
import { env } from './env';

const isRediss = env.REDIS_URL.startsWith('rediss://');

export const defaultRedisOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  tls: isRediss ? { rejectUnauthorized: false } : undefined,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
};

export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, defaultRedisOptions);
}

export const redis = createRedisConnection();

redis.on('connect', () => {
  console.log('[Redis] Connected successfully');
});

redis.on('error', (err) => {
  console.error('[Redis] Connection error:', err.message);
});

export async function invalidateCachePattern(pattern: string): Promise<void> {
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    console.error(`[Redis] Failed to invalidate cache pattern "${pattern}":`, err);
  }
}

export async function invalidateEventsCache(eventId?: string): Promise<void> {
  if (env.APP_MODE !== 'optimized') {
    return;
  }
  const promises: Promise<unknown>[] = [invalidateCachePattern('events:list:*')];
  if (eventId) {
    promises.push(redis.del(`events:detail:${eventId}`));
  }
  await Promise.all(promises);
}

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
