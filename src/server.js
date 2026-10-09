import express from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { registerAllTools } from './tools.js';
import { registerQuickbaseTools } from './quickbase.js';
import { registerSmartQuickbaseTools } from './qbSmart.js';
import { registerOpsTools, SERVER_INSTRUCTIONS } from './ops.js';
import { registerTriageTools } from './triage.js';

const PORT = process.env.PORT || 3000;

// MCP_SHARED_SECRETS holds one or more named secrets, e.g.
//   brady:3f9a...,sarah:7c2d...
// so each person gets their own key and can be revoked individually by
// removing their "name:secret" pair from the env var and saving.
// Falls back to the older single-secret MCP_SHARED_SECRET var if present.
const SHARED_SECRETS = parseSharedSecrets(process.env.MCP_SHARED_SECRETS);
if (process.env.MCP_SHARED_SECRET) {
  SHARED_SECRETS.set(process.env.MCP_SHARED_SECRET, 'default');
}

function parseSharedSecrets(raw) {
  const map = new Map(); // secret -> name
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const sep = entry.indexOf(':');
    if (sep === -1) continue;
    const name = entry.slice(0, sep).trim();
    const secret = entry.slice(sep + 1).trim();
    if (name && secret) map.set(secret, name);
  }
  return map;
}

if (SHARED_SECRETS.size === 0) {
  console.warn(
    '[toa-mcp-wrapper] No shared secrets configured (MCP_SHARED_SECRETS) — the /mcp endpoint is open to anyone who finds the URL. ' +
      'Set MCP_SHARED_SECRETS before deploying for real use.'
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

app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'toa-mcp-wrapper' });
});

// Gate the MCP endpoint behind one of the named shared secrets.
app.use('/mcp', (req, res, next) => {
  if (SHARED_SECRETS.size === 0) return next();
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
  const name = token ? SHARED_SECRETS.get(token) : undefined;
  if (name) {
    req.connectorUser = name;
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
});

function buildServer() {
  const server = new McpServer({ name: 'toa-energy', version: '1.0.0' }, { instructions: SERVER_INSTRUCTIONS });
  // Every tool in this wrapper is read-only. Declare that on each one so Claude
  // can group them as "read-only" in its tool-permission settings.
  const register = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) =>
    register(
      name,
      { ...config, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true, ...(config.annotations || {}) } },
      handler
    );
  registerAllTools(server);
  registerQuickbaseTools(server); // no-op unless QB_USER_TOKEN + QB_REALM_HOSTNAME are set
  registerOpsTools(server); // schedule, workload, stats, project 360, TOA<->QB match, sync check
  registerTriageTools(server); // install triage, schedule history, M2 readiness, stalls, battery-only, test check
  registerSmartQuickbaseTools(server); // label-based search, project find, counts, TOA matching
  return server;
}

// Stateless: a fresh server + transport for every request (the pattern the
// MCP SDK recommends), so no state is shared between requests or users.
app.post('/mcp', async (req, res) => {
  try {
    const server = buildServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[toa-mcp-wrapper] MCP request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

// No server-initiated streams or sessions in stateless mode.
const methodNotAllowed = (req, res) => {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

app.listen(PORT, () => {
  console.log(`toa-mcp-wrapper listening on port ${PORT}`);
});
