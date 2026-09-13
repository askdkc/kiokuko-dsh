import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { openConnection } from '../dist/db/connection.js';
import { backfillProfileMemory } from '../dist/akinator/profile-memory-store.js';

const args = process.argv.slice(2);
const databaseIndex = args.indexOf('--database');
const path = databaseIndex >= 0 ? args[databaseIndex + 1] : undefined;
const allowed = new Set(['--database', '--batch-size', '--rebuild']);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  if (args[i] !== '--rebuild') i++;
}
if (!path || !isAbsolute(path) || !statSync(path).isFile()) throw new Error('--database must name an existing absolute SQLite path');
const batchIndex = args.indexOf('--batch-size');
const batchSize = batchIndex < 0 ? 100 : Number(args[batchIndex + 1]);
const database = openConnection(path);
try {
  let processed = 0, batches = 0, result;
  do {
    result = backfillProfileMemory(database, batchSize, batches === 0 && args.includes('--rebuild'));
    processed += result.processed; batches++;
  } while (!result.complete);
  console.log(JSON.stringify({ processed, batches, complete: true }));
} finally { database.close(); }
