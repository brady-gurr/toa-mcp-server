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

// Some MCP clients probe with an OPTIONS preflight, and a browser-hosted
// client enforces CORS — allow it. The shared-secret check below still
// protects the endpoint; this only controls who's allowed to *ask*.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Accept, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Temporary diagnostic logging — lets us see exactly what a connecting
// client (e.g. Claude's custom connector) actually sends, since the
// "Couldn't connect" error in Claude's UI gives no detail on its own.
// Safe to remove once the connector is working reliably.
app.use((req, res, next) => {
  const hasAuthHeader = Boolean(req.headers.authorization);
  const authLooksRight = req.headers.authorization === `Bearer ${SHARED_SECRET}`;
  console.log(
    `[req] ${req.method} ${req.originalUrl} ` +
      `accept="${req.headers.accept || ''}" ` +
      `content-type="${req.headers['content-type'] || ''}" ` +
      `auth-header-present=${hasAuthHeader} auth-matches=${authLooksRight}`
  );
  res.on('finish', () => {
    console.log(`[res] ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
  });
  next();
});

app.use(express.json({ limit: '2mb' }));

// Health check — useful for the hosting platform and for a quick manual check.
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'toa-mcp-wrapper' });
});

// Gate the MCP endpoint behind a shared secret. Give Claude's custom
// connector the same value as an `Authorization: Bearer <secret>` request
// header (Add custom connector -> No sign-in -> Request headers).
app.use('/mcp', (req, res, next) => {
  if (!SHARED_SECRET) return next();
  if (req.headers.authorization === `Bearer ${SHARED_SECRET}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

const server = new McpServer({ name: 'toa-energy', version: '1.0.0' });
registerAllTools(server);

// Stateless transport: one server instance, reused across requests, no
// session bookkeeping. Simplest shape for a connector that only POSTs.
const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);

// Handle all three Streamable HTTP verbs on the same transport — some
// clients probe with GET (open an SSE stream) or DELETE (end a session)
// even in stateless mode, and an unhandled verb here can make a client
// conclude the URL isn't a valid MCP server at all.
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
