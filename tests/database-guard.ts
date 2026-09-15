/**
 * Guards the integration suite against running on the application's database.
 *
 * `db.integration.test.ts` truncates every table before each test. Pointing
 * TEST_DATABASE_URL at the production connection string -- which is one
 * copy-paste away, and exactly what happened during development of this
 * service -- silently deletes all ingested telemetry. This makes that mistake
 * fail loudly before a single statement runs.
 */

import { existsSync, readFileSync } from 'node:fs';

import { parse } from 'dotenv';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The files Next.js loads the application's configuration from. */
const APPLICATION_ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

/**
 * What makes two connection strings the same database: user, host, port and
 * name. Query parameters such as `?sslmode=require` are ignored so that adding
 * one cannot slip past the comparison.
 */
export function databaseIdentity(url: string): string | null {
  try {
    const parsed = new URL(url);
    const port = parsed.port || '5432';
    return `${decodeURIComponent(parsed.username)}@${parsed.hostname.toLowerCase()}:${port}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export function isLocalDatabase(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Every DATABASE_URL the application could be running against. */
export function applicationDatabaseUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const urls = new Set<string>();
  if (env.DATABASE_URL) urls.add(env.DATABASE_URL);
  for (const file of APPLICATION_ENV_FILES) {
    if (!existsSync(file)) continue;
    const value = parse(readFileSync(file)).DATABASE_URL;
    if (value) urls.add(value);
  }
  return [...urls];
}

/**
 * Local databases are always allowed: that is what CI and a developer's Docker
 * container look like, and CI deliberately migrates and tests the same one.
 * A remote database is refused if it is any database the application is
 * configured to use.
 */
export function refusalReason(testUrl: string, applicationUrls: string[]): string | null {
  if (isLocalDatabase(testUrl)) return null;
  const target = databaseIdentity(testUrl);
  if (target === null) return 'TEST_DATABASE_URL is not a valid connection string.';
  if (applicationUrls.some((url) => databaseIdentity(url) === target)) {
    return (
      'Refusing to run: TEST_DATABASE_URL points at the database this application is configured to use. ' +
      'The integration suite truncates every table. Point it at a disposable database instead.'
    );
  }
  return null;
}
