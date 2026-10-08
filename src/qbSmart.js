// Friendlier read-only Quickbase tools, built on top of src/quickbase.js:
//   qb_search_records     query by table/field NAMES, results keyed by label
//   qb_find_project       one-step project lookup (name, address, record #, Enerflo id)
//   qb_count_records      totals and breakdowns (e.g. projects by status)
//   qb_match_project_toa  line a Quickbase project up with its TOA project
//
// Everything here goes through qbRequest(), which only ever allows reads, and
// toaRequest() GETs. Nothing in this file can change data.

import { z } from 'zod';
import { qbRequest, quickbaseConfigured } from './quickbase.js';
import { toaRequest } from './toaClient.js';

// --- config ----------------------------------------------------------------

// The Kin Projects table and the field IDs we rely on for find/match. These are
// stable IDs from the app; override the table with QB_PROJECTS_TABLE_ID if needed.
export const projectsTableId = () => process.env.QB_PROJECTS_TABLE_ID || 'br9kwm8na';
export const PF = {
  recordId: 3,
  name: 145,
  address: 146,
  status: 255,
  systemSize: 13,
  salesDate: 522,
  closer: 355,
  setter: 330,
  lender: 344,
  coordinator: 820,
  installScheduledStart: 178,
  installCompleted: 534,
  enerfloDealId: 1875
};
export const PROJECT_SELECT = Object.values(PF);

// --- small cache (tables and fields rarely change) -------------------------

const CACHE_MS = 15 * 60 * 1000;
const cache = new Map();
async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// --- helpers ---------------------------------------------------------------

export function textResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function escalationHint(err) {
  return /No (field|table) matches|ambiguous|several tables|is not set/i.test(err.message)
    ? 'If you cannot resolve this after one or two alternate tries, ask Sparky once with the details above (it is slow, so only when needed); for Quickbase schema or field-meaning questions, suggest asking Dev and offer to draft the message (never send without the user\'s OK).'
    : undefined;
}

export async function safe(fn) {
  try {
    return textResult(await fn());
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message, status: err.status, details: err.body, hint: escalationHint(err) }, null, 2) }],
      isError: true
    };
  }
}

const OPS = new Set(['EX', 'XEX', 'CT', 'XCT', 'SW', 'XSW', 'BF', 'OBF', 'AF', 'OAF', 'LT', 'LTE', 'GT', 'GTE']);
const OP_ALIASES = {
  equals: 'EX',
  is: 'EX',
  '=': 'EX',
  not_equals: 'XEX',
  contains: 'CT',
  not_contains: 'XCT',
  starts_with: 'SW',
  not_starts_with: 'XSW',
  before: 'BF',
  on_or_before: 'OBF',
  after: 'AF',
  on_or_after: 'OAF',
  less_than: 'LT',
  less_than_or_equal: 'LTE',
  greater_than: 'GT',
  greater_than_or_equal: 'GTE'
};

function normOp(op) {
  const raw = String(op).trim();
  const up = raw.toUpperCase();
  if (OPS.has(up)) return up;
  const alias = OP_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  throw new Error(
    `Unknown operator "${op}". Use one of: equals, not_equals, contains, not_contains, starts_with, before, on_or_before, after, on_or_after, less_than, greater_than (or codes ${[...OPS].join(', ')}).`
  );
}

// Quote a value for a Quickbase query string: 'text', with \ and ' escaped.
export function q(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

const isTableId = (s) => /^b[a-z0-9]{7,9}$/.test(s) && /\d/.test(s);

// --- table + field resolution ----------------------------------------------

async function listTables() {
  const appId = process.env.QB_APP_ID;
  if (!appId) throw new Error('QB_APP_ID is not set on the server, so tables can\'t be looked up by name.');
  return cached('tables:' + appId, () => qbRequest('/tables', { query: { appId } }));
}

async function resolveTable(ref) {
  const s = String(ref ?? '').trim();
  if (!s) throw new Error('table is required (a table name or ID).');
  if (isTableId(s)) return { id: s };
  const tables = await listTables();
  const low = s.toLowerCase();
  const exact = tables.filter((t) => (t.name || '').toLowerCase() === low || (t.alias || '').toLowerCase() === low);
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].name };
  const words = low.split(/\s+/).filter(Boolean);
  const pool = exact.length ? exact : tables.filter((t) => words.every((w) => `${t.name || ''} ${t.alias || ''}`.toLowerCase().includes(w)));
  if (pool.length === 1) return { id: pool[0].id, name: pool[0].name };
  if (!pool.length) throw new Error(`No table matches "${s}". Try qb_list_tables with nameContains.`);
  throw new Error(
    `"${s}" matches several tables: ${pool.slice(0, 10).map((t) => `${t.name} (${t.id})`).join('; ')}. Use the exact name or the table ID.`
  );
}

export async function getFields(tableId) {
  return cached('fields:' + tableId, async () => {
    const f = await qbRequest('/fields', { query: { tableId } });
    return Array.isArray(f) ? f.map((x) => ({ id: x.id, label: x.label || '' })) : [];
  });
}

async function resolveField(tableId, ref) {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) return Number(ref);
  const fields = await getFields(tableId);
  const low = String(ref).trim().toLowerCase();
  const exact = fields.filter((f) => f.label.toLowerCase() === low);
  if (exact.length === 1) return exact[0].id;
  const words = low.split(/\s+/).filter(Boolean);
  const pool = exact.length ? exact : fields.filter((f) => words.every((w) => f.label.toLowerCase().includes(w)));
  if (pool.length === 1) return pool[0].id;
  if (!pool.length) throw new Error(`No field matches "${ref}" in this table. Use qb_list_fields with nameContains to find it.`);
  throw new Error(
    `Field "${ref}" is ambiguous: ${pool.slice(0, 8).map((f) => `${f.id} ${f.label}`).join('; ')}. Pass the field ID or the exact label.`
  );
}

// {Status.EX.'Active'} -> {255.EX.'Active'} (labels in a raw where string)
async function resolveWhereLabels(tableId, where) {
  const re = /\{([^{}]+?)\.(EX|XEX|CT|XCT|SW|XSW|BF|OBF|AF|OAF|IR|XIR|TV|XTV|LT|LTE|GT|GTE)\./g;
  const refs = new Set();
  for (const m of where.matchAll(re)) if (!/^\d+$/.test(m[1].trim())) refs.add(m[1]);
  const map = new Map();
  for (const r of refs) map.set(r, await resolveField(tableId, r));
  return where.replace(re, (all, ref, op) => (map.has(ref) ? `{${map.get(ref)}.${op}.` : all));
}

async function buildWhere(tableId, { filters, match, where }) {
  const parts = [];
  for (const f of filters || []) {
    const id = await resolveField(tableId, f.field);
    parts.push(`{${id}.${normOp(f.op)}.${q(f.value)}}`);
  }
  let out = '';
  if (parts.length === 1) out = parts[0];
  else if (parts.length > 1) out = parts.join(match === 'any' ? 'OR' : 'AND');
  if (where && where.trim()) {
    const w = await resolveWhereLabels(tableId, where.trim());
    out = out ? `(${out})AND(${w})` : w;
  }
  return out || undefined;
}

// --- result shaping ---------------------------------------------------------

const UTC_STAMP = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(:\d{2}(\.\d+)?)?Z$/;
const MT_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' });
// Quickbase returns date-time fields in UTC; show them in Mountain Time.
function toMountain(s) {
  const m = UTC_STAMP.exec(s);
  if (!m || (m[1] === '00' && m[2] === '00')) return s; // date-only values arrive as midnight UTC
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : MT_FMT.format(d).replace(',', '');
}

export function plain(v) {
  if (typeof v === 'string') return toMountain(v);
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return v.name ?? v.email ?? v.url ?? JSON.stringify(v);
  return v;
}

// Rows keyed by field label (not ID), with empty values dropped to save space.
export function labelRows(result, rawIds = false) {
  const labelById = new Map((result.fields || []).map((f) => [String(f.id), f.label]));
  const seen = {};
  for (const l of labelById.values()) seen[l] = (seen[l] || 0) + 1;
  const keyFor = (id) => {
    if (rawIds) return id;
    const label = labelById.get(id);
    if (!label) return id;
    return seen[label] > 1 ? `${label} (${id})` : label;
  };
  return (result.data || []).map((row) => {
    const out = {};
    for (const [id, cell] of Object.entries(row)) {
      const v = plain(cell?.value);
      if (v === null || v === undefined || v === '') continue;
      out[keyFor(id)] = v;
    }
    return out;
  });
}

export const runQuery = (tableId, body) => qbRequest('/records/query', { method: 'POST', body: { from: tableId, ...body } });

const fieldRef = z.union([z.string(), z.number()]);
const filterShape = z.object({
  field: fieldRef.describe('Field label (e.g. "Status") or field ID.'),
  op: z.string().describe('equals, not_equals, contains, not_contains, starts_with, before, on_or_before, after, on_or_after, less_than, greater_than.'),
  value: z.union([z.string(), z.number(), z.boolean()]).describe('Value to compare to. Dates as YYYY-MM-DD.')
});

// --- Projects helpers (find + match) ---------------------------------------

function projectSearchWhere(query) {
  const text = String(query).trim();
  const clauses = [];
  if (/^\d+$/.test(text)) clauses.push(`{${PF.recordId}.EX.${q(text)}}`);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text)) clauses.push(`{${PF.enerfloDealId}.EX.${q(text)}}`);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length) {
    clauses.push('(' + words.map((w) => `{${PF.name}.CT.${q(w)}}`).join('AND') + ')');
    clauses.push(`{${PF.address}.CT.${q(text)}}`);
  }
  return clauses.join('OR');
}

async function findProjects(query, top = 10) {
  const result = await runQuery(projectsTableId(), {
    select: PROJECT_SELECT,
    where: projectSearchWhere(query),
    sortBy: [{ fieldId: PF.recordId, order: 'DESC' }],
    options: { skip: 0, top }
  });
  return { rows: labelRows(result), rawRows: result.data || [], total: result.metadata?.totalRecords ?? 0 };
}

export const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cellVal = (row, id) => plain(row?.[String(id)]?.value);

async function toaProjectFor(externalId) {
  const compact = (p) => ({
    id: p.id,
    url: p.url,
    name: p.name,
    externalId: p.externalId,
    systemSize: p.systemSize,
    address: p.property?.address
      ? [p.property.address.line1, p.property.address.city, p.property.address.state, p.property.address.postalCode].filter(Boolean).join(', ')
      : undefined,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  });
  try {
    const { data } = await toaRequest(`/projects/${encodeURIComponent(externalId)}`);
    if (data && data.id) return compact(data);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  try {
    const { data } = await toaRequest('/projects', { query: { externalId, limit: 1 } });
    if (Array.isArray(data) && data[0]) return compact(data[0]);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  return null;
}

// --- registration ------------------------------------------------------------

export function registerSmartQuickbaseTools(server) {
  if (!quickbaseConfigured()) return;

  server.registerTool(
    'qb_search_records',
    {
      title: 'qb_search_records',
      description:
        'PREFERRED way to read Quickbase records. Use table and field NAMES, no IDs needed, and rows come back keyed by field label. ' +
        'table: a table name ("Projects") or ID. select: field labels to return. filters: [{field, op, value}] combined with match "all" (AND, default) or "any" (OR). ' +
        'Example: table "Projects", filters [{field:"Status", op:"equals", value:"Active"}], select ["Customer Name","Status"]. ' +
        'Big tables have many similarly named fields; if a label is ambiguous the error lists candidates, so use qb_list_fields with nameContains to find the right one. ' +
        'where accepts a raw Quickbase query with labels, e.g. {Status.EX.\'Active\'}.',
      inputSchema: z.object({
        table: z.string().describe('Table name or ID.'),
        select: z.array(fieldRef).optional().describe('Field labels (or IDs) to return. Omit for the table\'s default columns.'),
        filters: z.array(filterShape).optional().describe('Filters on field labels.'),
        match: z.enum(['all', 'any']).optional().describe('Combine filters with AND (all, default) or OR (any).'),
        where: z.string().optional().describe('Optional raw Quickbase where string; field labels allowed.'),
        sortBy: z.array(z.object({ field: fieldRef, order: z.enum(['ASC', 'DESC']).optional() })).optional(),
        skip: z.number().int().min(0).optional(),
        top: z.number().int().min(1).max(500).optional().describe('Max records (default 50, max 500). Use skip to page.'),
        rawIds: z.boolean().optional().describe('Key rows by field ID instead of label.')
      })
    },
    async ({ table, select, filters, match, where, sortBy, skip, top, rawIds }) =>
      safe(async () => {
        const t = await resolveTable(table);
        const body = { options: { skip: skip ?? 0, top: top ?? 50 } };
        if (select?.length) body.select = await Promise.all(select.map((s) => resolveField(t.id, s)));
        const w = await buildWhere(t.id, { filters, match, where });
        if (w) body.where = w;
        if (sortBy?.length) {
          body.sortBy = await Promise.all(
            sortBy.map(async (s) => ({ fieldId: await resolveField(t.id, s.field), order: s.order || 'ASC' }))
          );
        }
        const result = await runQuery(t.id, body);
        return {
          table: { id: t.id, name: t.name },
          totalRecords: result.metadata?.totalRecords,
          returned: result.data?.length ?? 0,
          rows: labelRows(result, rawIds)
        };
      })
  );

  server.registerTool(
    'qb_find_project',
    {
      title: 'qb_find_project',
      description:
        'Find Kin projects in Quickbase in one step. Pass whatever you have: a customer name ("Karla Navarro"), part of a name, a street address, a project Record ID# ("11023"), or an Enerflo deal ID. ' +
        'Returns the key facts (status, system size, sales date, closer/setter, lender, coordinator, install dates). Use qb_search_records for anything beyond that.',
      inputSchema: z.object({
        query: z.string().describe('Customer name, address, Record ID#, or Enerflo V2 deal ID.'),
        top: z.number().int().min(1).max(50).optional().describe('Max matches (default 10).')
      })
    },
    async ({ query, top }) =>
      safe(async () => {
        const { rows, total } = await findProjects(query, top ?? 10);
        return { query, totalMatches: total, returned: rows.length, projects: rows };
      })
  );

  server.registerTool(
    'qb_count_records',
    {
      title: 'qb_count_records',
      description:
        'Count Quickbase records, optionally broken down by a field. Examples: "how many projects are Active?" (table "Projects", filters Status equals Active), ' +
        '"projects by status" (table "Projects", groupBy "Status"). Much cheaper than pulling records. Same table/filter conventions as qb_search_records.',
      inputSchema: z.object({
        table: z.string().describe('Table name or ID.'),
        groupBy: fieldRef.optional().describe('Field label (or ID) to break the count down by.'),
        filters: z.array(filterShape).optional(),
        match: z.enum(['all', 'any']).optional(),
        where: z.string().optional().describe('Optional raw Quickbase where string; field labels allowed.')
      })
    },
    async ({ table, groupBy, filters, match, where }) =>
      safe(async () => {
        const t = await resolveTable(table);
        const w = await buildWhere(t.id, { filters, match, where });
        if (groupBy === undefined || groupBy === null || groupBy === '') {
          const result = await runQuery(t.id, { ...(w ? { where: w } : {}), options: { skip: 0, top: 1 } });
          return { table: { id: t.id, name: t.name }, totalRecords: result.metadata?.totalRecords ?? 0 };
        }
        const fid = await resolveField(t.id, groupBy);
        const PAGE = 1000;
        const MAX_PAGES = 30;
        const counts = new Map();
        let total = 0;
        let label;
        let truncated = false;
        for (let page = 0; page < MAX_PAGES; page++) {
          const result = await runQuery(t.id, {
            select: [fid],
            ...(w ? { where: w } : {}),
            options: { skip: page * PAGE, top: PAGE }
          });
          label = label || result.fields?.find((f) => f.id === fid)?.label;
          const rows = result.data || [];
          for (const row of rows) {
            let v = plain(row[String(fid)]?.value);
            if (Array.isArray(v)) v = v.join(', ');
            const key = v === null || v === undefined || v === '' ? '(blank)' : String(v);
            counts.set(key, (counts.get(key) || 0) + 1);
          }
          total += rows.length;
          const all = result.metadata?.totalRecords ?? 0;
          if (rows.length < PAGE || total >= all) break;
          if (page === MAX_PAGES - 1) truncated = true;
        }
        const groups = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
        return {
          table: { id: t.id, name: t.name },
          groupedBy: label || String(groupBy),
          totalRecords: total,
          distinctValues: groups.length,
          groups: groups.slice(0, 100),
          note: [
            groups.length > 100 ? `Showing the top 100 of ${groups.length} values.` : undefined,
            truncated ? `Stopped after ${MAX_PAGES * PAGE} records; counts are partial.` : undefined
          ].filter(Boolean).join(' ') || undefined
        };
      })
  );
}
