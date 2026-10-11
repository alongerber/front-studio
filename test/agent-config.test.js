// Agent selection per environment: production never falls back to the test agent.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sql, call, elSign } from './helpers.js';
import * as config from '../api/config.js';
import * as elWebhook from '../api/elevenlabs/webhook.js';
import { TEST_AGENT_ID } from '../lib/config.js';

async function withEnv(vars, fn) {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}
async function captureErrors(fn) {
  const logged = [], orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  try { return { result: await fn(), logged }; } finally { console.error = orig; }
}

beforeEach(freshDb);

test('AG1. production without ELEVENLABS_AGENT_ID: no agent, a clear configuration error, never the test agent', () =>
  withEnv({ FRONT_ENV: 'production', ELEVENLABS_AGENT_ID: undefined }, async () => {
    const { result: r, logged } = await captureErrors(() => call(config.GET, 'GET', '/api/config'));
    assert.equal(r.status, 200);
    assert.equal(r.data.agent_id, null);
    assert.equal(r.data.agent_error, 'agent_not_configured');
    assert.equal(JSON.stringify(r.data).includes(TEST_AGENT_ID), false);
    assert.ok(logged.some(l => /CONFIGURATION ERROR: ELEVENLABS_AGENT_ID is not set in production/.test(l)), logged.join('\n'));
  }));

test('AG2. production with an empty value is treated as missing', () =>
  withEnv({ FRONT_ENV: 'production', ELEVENLABS_AGENT_ID: '  ' }, async () => {
    const { result: r } = await captureErrors(() => call(config.GET, 'GET', '/api/config'));
    assert.equal(r.data.agent_id, null);
  }));

test('AG3. production with the variable set uses exactly that agent', () =>
  withEnv({ FRONT_ENV: 'production', ELEVENLABS_AGENT_ID: 'agent_prod_1' }, async () => {
    const r = await call(config.GET, 'GET', '/api/config');
    assert.equal(r.data.agent_id, 'agent_prod_1');
    assert.equal(r.data.agent_error, null);
  }));

test('AG4. preview without the variable keeps the test agent', () =>
  withEnv({ FRONT_ENV: 'preview', ELEVENLABS_AGENT_ID: undefined }, async () => {
    const r = await call(config.GET, 'GET', '/api/config');
    assert.equal(r.data.agent_id, TEST_AGENT_ID);
  }));

test('AG5. production without an agent: the conversation webhook is not accepted from any agent, and the error is logged', () =>
  withEnv({ FRONT_ENV: 'production', ELEVENLABS_AGENT_ID: undefined }, async () => {
    const raw = JSON.stringify({ type: 'post_call_transcription', data: { agent_id: TEST_AGENT_ID, conversation_id: 'conv_noagent', status: 'done',
      transcript: [{ role: 'agent', message: 'שלום' }], metadata: {}, analysis: {} } });
    const { result: r, logged } = await captureErrors(() => call(elWebhook.POST, 'POST', '/api/elevenlabs/webhook', { raw, headers: { 'elevenlabs-signature': elSign(raw) } }));
    assert.equal(r.data.ignored, 'agent_not_configured');
    // Nothing was stored (the handler returns before touching the database, so the table may not even exist yet).
    const exists = (await sql(`SELECT to_regclass('conversations') AS t`))[0].t;
    if (exists) assert.equal((await sql(`SELECT count(*)::int n FROM conversations WHERE conversation_id = 'conv_noagent'`))[0].n, 0);
    assert.ok(logged.some(l => /CONFIGURATION ERROR: ELEVENLABS_AGENT_ID/.test(l)));
  }));
