#!/usr/bin/env node
// Apply database migrations explicitly (they also run automatically on the first API request).
// Usage: DATABASE_URL=... node scripts/migrate.js      (or: npm run migrate)
import { migrate, q } from '../lib/db.js';
import { fileURLToPath } from 'node:url';

export async function run() {
  const applied = await migrate();
  const rows = await q(`SELECT id, applied_at FROM schema_migrations ORDER BY id`);
  return { applied, all: rows.map(r => r.id) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. In Vercel it is added by the Neon integration; locally, export it first.');
    process.exit(2);
  }
  run().then(r => {
    console.log(r.applied.length ? 'Applied: ' + r.applied.join(', ') : 'Nothing to apply.');
    console.log('Database is at: ' + r.all.join(', '));
  }).catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
}
