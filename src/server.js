import express from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { registerAllTools } from './tools.js';

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.MCP_SHARED_SECRET;

if (!SHARED_SECRET) {
  console.warn(
    '[toa-mcp-wrapper] MCP_SHARED_SECRET is not set — the /mcp endpoint is open to anyone who finds the URL. ' +
      'Set MCP_SHARED_SECRET before deploying for real use.'
  );
}

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Accept, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  const received = req.headers.authorization || '';
  const expected = `Bearer ${SHARED_SECRET}`;
  const authLooksRight = received === expected;
  console.log(
    `[req] ${req.method} ${req.originalUrl} ` +
      `accept="${req.headers.accept || ''}" ` +
      `content-type="${req.headers['content-type'] || ''}" ` +
      `auth-header-present=${Boolean(received)} auth-matches=${authLooksRight} ` +
      `received-len=${received.length} expected-len=${expected.length} ` +
      `received-prefix="${received.slice(0, 12)}" expected-prefix="${expected.slice(0, 12)}" ` +
      `received-suffix="${received.slice(-6)}" expected-suffix="${expected.slice(-6)}"`
  );
  res.on('finish', () => {
    console.log(`[res] ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
  });
  next();
});

app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'toa-mcp-wrapper' });
});

app.use('/mcp', (req, res, next) => {
  if (!SHARED_SECRET) return next();
  if (req.headers.authorization === `Bearer ${SHARED_SECRET}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

const server = new McpServer({ name: 'toa-energy', version: '1.0.0' });
registerAllTools(server);

const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);

app.post('/mcp', (req, res) => {
  transport.handleRequest(req, res, req.body);
});
app.get('/mcp', (req, res) => {
  transport.handleRequest(req, res);
});
app.delete('/mcp', (req, res) => {
  transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`toa-mcp-wrapper listening on port ${PORT}`);
});
