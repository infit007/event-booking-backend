import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { env } from './env';

const isProduction = env.NODE_ENV === 'production';
const isCloudDb =
  env.DATABASE_URL.includes('neon.tech') ||
  env.DATABASE_URL.includes('supabase.co') ||
  env.DATABASE_URL.includes('render.com') ||
  env.DATABASE_URL.includes('sslmode=require');
const isExplicitDisable = env.DATABASE_URL.includes('sslmode=disable');

const sslConfig = !isExplicitDisable && (isCloudDb || isProduction)
  ? { rejectUnauthorized: false }
  : false;

const poolConfig: PoolConfig = {
  connectionString: env.DATABASE_URL,
  ssl: sslConfig,
  ...(env.APP_MODE === 'baseline'
    ? {
        max: 5,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 10000,
      }
    : {
        max: 25,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
      }),
};

export const pool = new Pool(poolConfig);

pool.on('error', (err: Error) => {
  console.error('[PostgreSQL] Unexpected client error on idle client:', err.message);
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const res = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (process.env.DEBUG_SQL) {
    console.log(`[SQL Query] (${duration}ms):`, text, params);
  }
  return res;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
