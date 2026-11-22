import fs from 'fs';
import path from 'path';
import { pool, closePool } from '../config/db';

async function runMigration() {
  console.log('[Migration] Starting database migration...');

  const possiblePaths = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql'),
    path.resolve(process.cwd(), 'src', 'db', 'schema.sql'),
  ];

  let schemaPath = '';
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      schemaPath = p;
      break;
    }
  }

  if (!schemaPath) {
    throw new Error(`[Migration] schema.sql could not be found. Checked paths: ${possiblePaths.join(', ')}`);
  }

  console.log(`[Migration] Loading schema from: ${schemaPath}`);
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('[Migration] Database schema migrated successfully (users, events, bookings, notification_logs).');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Migration] Migration failed:', error);
    process.exitCode = 1;
    throw error;
  } finally {
    client.release();
    await closePool();
  }
}

if (require.main === module) {
  runMigration()
    .then(() => {
      console.log('[Migration] Finished.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migration] Fatal error:', err);
      process.exit(1);
    });
}

export { runMigration };
