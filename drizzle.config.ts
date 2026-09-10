import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
  // Migrations are generated and committed, never pushed straight to a
  // database: the deployed schema must be reproducible from the repository.
  strict: true,
  verbose: true,
});
