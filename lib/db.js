// Postgres access. Production: Neon over HTTP. Tests: an injected adapter (PGlite).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let runner = null;      // (text, params) => Promise<rows[]>
let migrated = null;

export function setDb(fn) { runner = fn; migrated = null; }

async function getRunner() {
  if (runner) return runner;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(url);
  runner = (text, params) => sql.query(text, params);
  return runner;
}

// Split a migration file into single statements (Neon HTTP runs one statement per call).
export function splitSql(text) {
  const noComments = text.split('\n').map(l => l.replace(/\s--\s.*$|^\s*--.*$/, '')).join('\n');   // our migrations have no "--" inside strings
  return noComments.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
}

// Applies every migration file not yet recorded in schema_migrations, in file-name order.
// Each file is idempotent and records its own id last, so a half-applied file is simply re-run.
export async function migrate() {
  if (migrated) return migrated;
  migrated = (async () => {
    const run = await getRunner();
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
    let done = new Set();
    try { done = new Set((await run(`SELECT id FROM schema_migrations`, [])).map(r => r.id)); } catch { /* first run: table does not exist yet */ }
    const applied = [];
    for (const f of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
      const id = f.replace(/\.sql$/, '');
      if (done.has(id)) continue;
      for (const stmt of splitSql(readFileSync(join(dir, f), 'utf8'))) await run(stmt, []);
      applied.push(id);
    }
    return applied;
  })();
  try { await migrated; } catch (e) { migrated = null; throw e; }
  return migrated;
}

export async function q(text, params = []) {
  await migrate();
  const run = await getRunner();
  return run(text, params);
}

export async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}
