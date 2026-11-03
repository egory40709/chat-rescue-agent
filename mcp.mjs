#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './lib/server.mjs';

const { server, shutdown } = createServer();
const transport = new StdioServerTransport();
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await shutdown(); await server.close();
};
process.on('SIGINT', () => close().catch(() => {}));
process.on('SIGTERM', () => close().catch(() => {}));
process.stdin.on('end', () => close().catch(() => {}));
await server.connect(transport);
