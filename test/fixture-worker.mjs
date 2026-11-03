import { readFile } from 'node:fs/promises';
import { worker } from '../lib/worker.mjs';
import { fixtureSession } from './fixtures.mjs';
if (process.argv[2] !== 'worker' || process.argv[3] !== '--config') throw new Error('Invalid test worker invocation');
const path = process.argv[4];
const config = JSON.parse(await readFile(path, 'utf8'));
await worker(path, { sessionFactory: () => fixtureSession(config.fixture_root, 'file-worker', 30) });
