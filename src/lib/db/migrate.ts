/**
 * Migration runner.
 *
 * Run explicitly (`npm run db:migrate`) rather than on application boot: a
 * serverless function can start dozens of concurrent instances, and having each
 * of them race to migrate is a reliable way to corrupt a schema. Deployment
 * order is migrate, then deploy.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run migrations.');

  // max: 1 is required -- migrations must run sequentially on one connection.
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  const sql = postgres(url, { max: 1, prepare: false, ssl: isLocal ? false : 'require' });
  try {
    await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
    console.log('Migrations applied.');
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
