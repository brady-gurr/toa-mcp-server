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

app.post('/mcp', (req, res) => {
  transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`toa-mcp-wrapper listening on port ${PORT}`);
});
