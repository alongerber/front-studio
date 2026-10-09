#!/usr/bin/env node
// Usage: node scripts/hash-password.js
// Prompts for a password (hidden) and prints the value for ADMIN_PASSWORD_HASH. Run it on your own computer.
import { scryptSync, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl._writeToOutput = function (s) { if (!rl.muted) rl.output.write(s); };
rl.question('Admin password (min 12 chars): ', (pw) => {
  rl.close(); process.stdout.write('\n');
  if (!pw || pw.length < 12) { console.error('Too short.'); process.exit(1); }
  const salt = randomBytes(16);
  console.log('scrypt$' + salt.toString('hex') + '$' + scryptSync(pw, salt, 32).toString('hex'));
});
rl.muted = true;
