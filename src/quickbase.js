// Read-only Quickbase tools for the MCP wrapper.
// Quickbase JSON REST API v1: https://developer.quickbase.com
//
// Env vars (all optional — if QB_USER_TOKEN and QB_REALM_HOSTNAME aren't both
// set, the Quickbase tools simply aren't registered and nothing else changes):
//   QB_USER_TOKEN       Quickbase user token (acts with that user's permissions)
//   QB_REALM_HOSTNAME   e.g. yourcompany.quickbase.com
//   QB_APP_ID           default app ID so tools don't need one passed in
//   QB_BASE_URL         override, defaults to https://api.quickbase.com/v1

import { z } from 'zod';

const DEFAULT_TOP = 100;
const MAX_TOP = 1000;

// App ID: use the one passed in, else the QB_APP_ID default, so people never
// have to supply an ID by hand.
function resolveAppId(appId) {
  const id = appId || process.env.QB_APP_ID;
  if (!id) throw new Error('No Quickbase app ID given and QB_APP_ID is not set on the server.');
  return id;
}

export function quickbaseConfigured() {
  return Boolean(process.env.QB_USER_TOKEN && process.env.QB_REALM_HOSTNAME);
}

// The only POST endpoints we ever allow. Both are reads (a records query and
// running a saved report). Everything else must be a GET, so this wrapper
// cannot create, change or delete anything in Quickbase.
const READ_ONLY_POSTS = [/^\/records\/query$/, /^\/reports\/[^/]+\/run$/];

export async function qbRequest(path, { method = 'GET', query, body } = {}) {
  if (method !== 'GET' && !(method === 'POST' && READ_ONLY_POSTS.some((re) => re.test(path)))) {
    throw new Error(`Blocked: this wrapper is read-only (${method} ${path} is not allowed).`);
  }

  const base = process.env.QB_BASE_URL || 'https://api.quickbase.com/v1';
  const url = new URL(base + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      'QB-Realm-Hostname': process.env.QB_REALM_HOSTNAME,
      Authorization: `QB-USER-TOKEN ${process.env.QB_USER_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!res.ok) {
    const hint = res.status === 429 ? ' (rate limited — wait a bit and retry)' : '';
    const err = new Error(`Quickbase API ${method} ${path} -> ${res.status} ${res.statusText}${hint}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Quickbase returns rows as [{ "3": { value: 1 }, "7": { value: "x" } }, ...].
// Flatten to [{ "3": 1, "7": "x" }] and keep a small id->label legend, which
// is far fewer tokens and easier to read.
export function formatRecords(result) {
  const fields = (result?.fields || []).map((f) => ({ id: f.id, label: f.label, type: f.type }));
  const rows = (result?.data || []).map((row) =>
    Object.fromEntries(Object.entries(row).map(([id, cell]) => [id, cell?.value ?? null]))
  );
  return { fields, rows, metadata: result?.metadata };
}

function textResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

async function safe(fn) {
  try {
    return textResult(await fn());
  } catch (err) {
    return {
      content: [
        { type: 'text', text: JSON.stringify({ error: err.message, status: err.status, details: err.body }, null, 2) }
      ],
      isError: true
    };
  }
}

const pagingShape = {
  skip: z.number().int().min(0).optional().describe('Number of records to skip (for paging).'),
  top: z
    .number()
    .int()
    .min(1)
    .max(MAX_TOP)
    .optional()
    .describe(`Max records to return (default ${DEFAULT_TOP}, max ${MAX_TOP}). Use skip to page.`)
};

export function registerQuickbaseTools(server) {
  if (!quickbaseConfigured()) {
    console.log('[toa-mcp-wrapper] Quickbase not configured (QB_USER_TOKEN / QB_REALM_HOSTNAME) — skipping Quickbase tools.');
    return;
  }

  server.registerTool(
    'qb_get_app',
    {
      title: 'qb_get_app',
      description: 'Get the Quickbase app\'s details. No ID needed — uses the configured default app unless appId is given.',
      inputSchema: z.object({ appId: z.string().optional().describe('Quickbase app ID. Optional — defaults to the server\'s configured app.') })
    },
    async ({ appId }) => safe(() => qbRequest(`/apps/${encodeURIComponent(resolveAppId(appId))}`))
  );

  server.registerTool(
    'qb_list_tables',
    {
      title: 'qb_list_tables',
      description:
        'Find Quickbase tables by name. No app ID needed. The app has ~170 tables, so pass nameContains ' +
        '(e.g. "project", "customer", "install") to search instead of listing everything. Returns table id, name and alias.',
      inputSchema: z.object({
        nameContains: z.string().optional().describe('Case-insensitive text to match in the table name or alias.'),
        appId: z.string().optional().describe('Optional — defaults to the server\'s configured app.'),
        detail: z.boolean().optional().describe('Return full raw table definitions (large). Default false.')
      })
    },
    async ({ nameContains, appId, detail }) =>
      safe(async () => {
        const tables = await qbRequest('/tables', { query: { appId: resolveAppId(appId) } });
        if (!Array.isArray(tables)) return tables;
        const needle = nameContains?.trim().toLowerCase();
        const matched = needle
          ? tables.filter((t) => `${t.name || ''} ${t.alias || ''}`.toLowerCase().includes(needle))
          : tables;
        if (detail) return matched;
        return {
          totalTables: tables.length,
          matched: matched.length,
          tables: matched.map((t) => ({ id: t.id, name: t.name, alias: t.alias, keyFieldId: t.keyFieldId }))
        };
      })
  );

  server.registerTool(
    'qb_get_table',
    {
      title: 'qb_get_table',
      description: 'Get one Quickbase table\'s details (key field, name, etc.).',
      inputSchema: z.object({
        tableId: z.string().describe('Quickbase table ID (find it with qb_list_tables).'),
        appId: z.string().optional().describe('Quickbase app ID. Optional — defaults to the server\'s configured app.')
      })
    },
    async ({ appId, tableId }) =>
      safe(() => qbRequest(`/tables/${encodeURIComponent(tableId)}`, { query: { appId: resolveAppId(appId) } }))
  );

  server.registerTool(
    'qb_list_fields',
    {
      title: 'qb_list_fields',
      description:
        'List the fields in a Quickbase table (field IDs, labels, types). You need field IDs to build queries. Returns a compact summary unless detail=true.',
      inputSchema: z.object({
        tableId: z.string().describe('Quickbase table ID.'),
        detail: z.boolean().optional().describe('Return the full raw field definitions (large). Default false.')
      })
    },
    async ({ tableId, detail }) =>
      safe(async () => {
        const fields = await qbRequest('/fields', { query: { tableId } });
        if (detail || !Array.isArray(fields)) return fields;
        return fields.map((f) => ({
          id: f.id,
          label: f.label,
          fieldType: f.fieldType,
          mode: f.mode || undefined,
          required: f.required || undefined,
          unique: f.unique || undefined
        }));
      })
  );

  server.registerTool(
    'qb_list_reports',
    {
      title: 'qb_list_reports',
      description: 'List the saved reports on a Quickbase table (names and report IDs).',
      inputSchema: z.object({ tableId: z.string().describe('Quickbase table ID.') })
    },
    async ({ tableId }) => safe(() => qbRequest('/reports', { query: { tableId } }))
  );

  server.registerTool(
    'qb_run_report',
    {
      title: 'qb_run_report',
      description: 'Run a saved Quickbase report and return its records (read-only).',
      inputSchema: z.object({
        tableId: z.string().describe('Quickbase table ID the report belongs to.'),
        reportId: z.string().describe('Report ID (from qb_list_reports).'),
        ...pagingShape
      })
    },
    async ({ tableId, reportId, skip, top }) =>
      safe(async () =>
        formatRecords(
          await qbRequest(`/reports/${encodeURIComponent(reportId)}/run`, {
            method: 'POST',
            query: { tableId, skip, top: top ?? DEFAULT_TOP }
          })
        )
      )
  );

  server.registerTool(
    'qb_query_records',
    {
      title: 'qb_query_records',
      description:
        'Query records in a Quickbase table (read-only). Pass select (field IDs) to limit columns, and where to filter, ' +
        'e.g. {3.EX.\'1234\'} or ({7.CT.\'solar\'}AND{12.GT.\'2026-01-01\'}). Operators: EX, XEX, CT, XCT, SW, XSW, ' +
        'BF, OBF, AF, OAF, IR, XIR, TV, XTV, LT, LTE, GT, GTE. Get field IDs from qb_list_fields. ' +
        'Rows come back keyed by field ID with a fields legend; check metadata.totalRecords and page with skip/top.',
      inputSchema: z.object({
        tableId: z.string().describe('Quickbase table ID to query.'),
        select: z.array(z.number().int()).optional().describe('Field IDs to return. Omit for the table\'s default columns.'),
        where: z.string().optional().describe('Quickbase query string, e.g. {3.EX.\'1234\'}.'),
        sortBy: z
          .array(z.object({ fieldId: z.number().int(), order: z.enum(['ASC', 'DESC']) }))
          .optional()
          .describe('Sort order, e.g. [{"fieldId": 3, "order": "DESC"}].'),
        ...pagingShape
      })
    },
    async ({ tableId, select, where, sortBy, skip, top }) =>
      safe(async () =>
        formatRecords(
          await qbRequest('/records/query', {
            method: 'POST',
            body: {
              from: tableId,
              ...(select?.length ? { select } : {}),
              ...(where ? { where } : {}),
              ...(sortBy?.length ? { sortBy } : {}),
              options: { skip: skip ?? 0, top: top ?? DEFAULT_TOP }
            }
          })
        )
      )
  );
}
