// Install / M2 triage tools. READ-ONLY: only qbRequest() reads and toaRequest() GETs.
//
//   wip_install_triage       installs that are NOT truly complete (QB vs. field-task reconciliation)
//   project_schedule_history original vs current install date, roll count, go-backs (+ TOA events)
//   m2_readiness             what is blocking M2 (inspection / permit / M2 status) and who owns it
//   aging_stalls             oldest stuck installs, ranked
//   battery_only_projects    battery-only projects (size < 1 kW), with the blank-market signal
//   test_record_check        is this a real job or a test record?
//
// Every tool takes `scope`: "kin" (default, Kin Home only), "other", or "all", and
// always excludes Test Projects unless includeTests is true.
//
// "Field task" history comes from the Arrivy task mirror table in Quickbase
// (Arrivy is being retired, so TOA events are shown alongside where available).

import { z } from 'zod';
import { quickbaseConfigured } from './quickbase.js';
import { toaRequest } from './toaClient.js';
import { PF, projectsTableId, safe, runQuery, q, plain } from './qbSmart.js';

// --- ids -------------------------------------------------------------------

const TASKS_TABLE = () => process.env.QB_TASKS_TABLE_ID || 'bvbqgs5yc';
const INSTALL_TEMPLATE_ID = process.env.QB_INSTALL_TEMPLATE_ID || '5020533932032000';
const SERVICE_TEMPLATE_ID = process.env.QB_SERVICE_TEMPLATE_ID || '6355777690927104';

// Projects table fields used here (verified against the live app).
const P = {
  ...PF,
  epc: 606, // EPC Name - Formula ("Kin Home" for our own jobs)
  testProject: 622,
  marketCalc: 1981, // Calculated EPC Market (blank on many battery deals)
  marketName: 378, // Epc Market - Market Name (dirty)
  inspectionsTotal: 1410,
  inspectionsPassed: 1073,
  inspectionScheduled: 226,
  inspectionPassFail: 571,
  inspectionPassedDate: 491,
  openInspections: 1747,
  m2Status: 2050,
  m2Readiness: 2853,
  m2RequestDate: 445,
  readyForM2: 1993,
  permitCount: 640,
  permitStatus: 2059,
  permitApproved: 2058,
  ptoSubmitted: 537,
  ptoApproved: 538,
  ptoMissing: 2007,
  rtrStatus: 2715, // RTR (ready-to-review) status of the latest PV module install task
  rtrInstallStatus: 2716, // Fully Installed / Partially Completed
  rtrWorkRemaining: 2719,
  rtrUpdatedAt: 2718
};

// Arrivy task mirror table fields.
const T = {
  id: 3,
  project: 6,
  templateName: 24,
  templateId: 57,
  status: 85, // Official: Task Status (Scheduled / Overdue / Approved / ...)
  logStatus: 86, // last field status (COMPLETE / STARTED / NOSHOW / EXCEPTION / RESCHEDULED ...)
  submitted: 97,
  approved: 111,
  rejected: 112,
  scheduled: 115,
  techComplete: 137
};

// --- helpers ---------------------------------------------------------------

const raw = (row, id) => row?.[String(id)]?.value;
const isBlank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const todayDenver = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
const denverDate = (iso) => (iso ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date(iso)) : undefined);
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const addDays = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const sizeOf = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));
export const isBatteryOnly = (size) => typeof size === 'number' && size > 0 && size < 1;

// Scope clause: Kin Home only by default, never test records unless asked.
export function scopeClauses(scope = 'kin', includeTests = false) {
  const c = [];
  if (scope === 'kin') c.push(`{${P.epc}.EX.${q('Kin Home')}}`);
  else if (scope === 'other') c.push(`{${P.epc}.XEX.${q('Kin Home')}}`);
  if (!includeTests) c.push(`{${P.testProject}.EX.${q('false')}}`);
  return c;
}
const and = (clauses) => clauses.filter(Boolean).map((c) => (c.startsWith('(') ? c : `(${c})`)).join('AND');

const scopeShape = {
  scope: z.enum(['kin', 'other', 'all']).optional().describe('kin (default) = Kin Home projects only; other = other EPCs; all = everyone.'),
  includeTests: z.boolean().optional().describe('Include records flagged Test Project (default false).')
};

async function queryAll(tableId, { select, where, sortBy, max = 1000 }) {
  const rows = [];
  let skip = 0;
  let total = 0;
  while (rows.length < max) {
    const top = Math.min(1000, max - rows.length);
    const r = await runQuery(tableId, { select, where, sortBy, options: { skip, top } });
    const data = r.data || [];
    total = r.metadata?.totalRecords ?? data.length;
    rows.push(...data);
    if (data.length < top || rows.length >= total) break;
    skip += data.length;
  }
  return { rows, total, truncated: rows.length < total };
}

// Resolve a mix of record IDs and name/address text into project rows.
async function resolveProjects(inputs, select, { scope = 'all', includeTests = true, perInput = 5 } = {}) {
  const out = new Map();
  for (const input of inputs) {
    const text = String(input).trim();
    if (!text) continue;
    const words = text.split(/\s+/);
    const match = /^\d+$/.test(text)
      ? `{${P.recordId}.EX.${q(text)}}`
      : `(${words.map((w) => `{${P.name}.CT.${q(w)}}`).join('AND')})OR{${P.address}.CT.${q(text)}}`;
    const r = await runQuery(projectsTableId(), {
      select,
      where: and([`(${match})`, ...scopeClauses(scope, includeTests)]),
      sortBy: [{ fieldId: P.recordId, order: 'DESC' }],
      options: { skip: 0, top: perInput }
    });
    for (const row of r.data || []) out.set(String(raw(row, P.recordId)), row);
  }
  return [...out.values()];
}

// Arrivy-mirror tasks for a set of project record IDs.
async function tasksFor(projectIds, templateIds) {
  const tasks = new Map(); // projectId -> task[]
  for (const ids of chunk(projectIds, 40)) {
    const idClause = ids.map((id) => `{${T.project}.EX.${q(id)}}`).join('OR');
    const clauses = [`(${idClause})`];
    if (templateIds) clauses.push(`(${templateIds.map((t) => `{${T.templateId}.EX.${q(t)}}`).join('OR')})`);
    const { rows } = await queryAll(TASKS_TABLE(), {
      select: [T.id, T.project, T.templateName, T.templateId, T.status, T.logStatus, T.submitted, T.approved, T.rejected, T.scheduled, T.techComplete],
      where: and(clauses)
    });
    for (const row of rows) {
      const pid = String(raw(row, T.project));
      const task = {
        taskId: raw(row, T.id),
        type: raw(row, T.templateName),
        templateId: String(raw(row, T.templateId) ?? ''),
        status: raw(row, T.status),
        fieldStatus: raw(row, T.logStatus),
        scheduledAt: raw(row, T.scheduled),
        scheduledDate: denverDate(raw(row, T.scheduled)),
        submittedAt: raw(row, T.submitted),
        approvedAt: raw(row, T.approved),
        rejectedAt: raw(row, T.rejected)
      };
      if (!tasks.has(pid)) tasks.set(pid, []);
      tasks.get(pid).push(task);
    }
  }
  for (const list of tasks.values()) list.sort((a, b) => String(a.scheduledAt || '').localeCompare(String(b.scheduledAt || '')));
  return tasks;
}

const OPEN_FIELD = new Set(['ARRIVING', 'ENROUTE', 'STARTED']);
const submittedOrApproved = (t) =>
  !isBlank(t.submittedAt) || !isBlank(t.approvedAt) || t.status === 'Approved' || String(t.fieldStatus || '').toUpperCase() === 'COMPLETE';

// Summarize one project's install tasks.
function installSummary(tasks = [], today) {
  const installs = tasks.filter((t) => t.templateId === INSTALL_TEMPLATE_ID);
  const service = tasks.filter((t) => t.templateId === SERVICE_TEMPLATE_ID);
  const first = installs[0];
  const last = installs[installs.length - 1];
  const done = installs.find(submittedOrApproved);
  const future = installs.find((t) => t.scheduledDate && t.scheduledDate >= today && !submittedOrApproved(t));
  return {
    installTasks: installs.length,
    originalInstallDate: first?.scheduledDate,
    currentInstallDate: last?.scheduledDate,
    rolls: Math.max(0, installs.length - 1),
    latestFieldStatus: last?.fieldStatus,
    latestTaskStatus: last?.status,
    taskSubmitted: Boolean(done),
    hasFutureInstall: Boolean(future),
    serviceTasks: service.map((t) => ({ date: t.scheduledDate, status: t.status, fieldStatus: t.fieldStatus, type: t.type })),
    installDates: installs.map((t) => ({ date: t.scheduledDate, status: t.status, fieldStatus: t.fieldStatus }))
  };
}

const asList = (v) => (Array.isArray(v) ? v : isBlank(v) ? [] : [v]).map((x) => plain(x)).filter(Boolean);

function classify({ qbCompleted, s, rtr }) {
  if (s.installTasks === 0) return qbCompleted ? 'QB says complete, but no install task exists' : 'No install task scheduled';
  if (qbCompleted && !s.taskSubmitted) return 'FALSE COMPLETE: QB shows install complete, but no install task was submitted';
  if (qbCompleted) {
    if (/partial/i.test(rtr.installStatus || '')) return 'Partially completed per RTR (work remaining)';
    if (rtr.workRemaining.length) return 'RTR conflict: says Fully Installed but lists work remaining';
    if (!rtr.installStatus) return 'No RTR on file for a completed install';
    return 'Complete';
  }
  const f = String(s.latestFieldStatus || '').toUpperCase();
  if (f === 'NOSHOW') return 'No-show on last visit';
  if (f === 'EXCEPTION') return 'Exception on last visit';
  if (OPEN_FIELD.has(f)) return s.latestTaskStatus === 'Overdue' ? 'Started/in progress, never submitted (overdue)' : 'In progress';
  if (s.serviceTasks.length && !s.hasFutureInstall) return 'Go-back may be booked as a Service task, not a Full Install';
  if (!s.hasFutureInstall) return 'Needs reschedule (no future install on the books)';
  return 'Scheduled';
}

// Shared engine: Active installs whose start date has arrived, plus recently "completed" ones to check.
async function collectInstalls({ scope, includeTests, lookbackDays, includeFuture, max, status = 'Active' }) {
  const today = todayDenver();
  const select = [P.recordId, P.name, P.address, P.status, P.installScheduledStart, P.installCompleted, P.coordinator, P.systemSize, P.rtrStatus, P.rtrInstallStatus, P.rtrWorkRemaining];
  const base = [...(status === 'any' ? [] : [`{${P.status}.EX.${q(status)}}`]), ...scopeClauses(scope, includeTests)];
  const open = [...base, `{${P.installCompleted}.EX.${q('')}}`, `{${P.installScheduledStart}.XEX.${q('')}}`];
  if (!includeFuture) open.push(`{${P.installScheduledStart}.OBF.${q(today)}}`);
  const recent = [...base, `{${P.installCompleted}.OAF.${q(addDays(today, -lookbackDays))}}`];
  const [a, b] = await Promise.all([
    queryAll(projectsTableId(), { select, where: and(open), max }),
    lookbackDays > 0 ? queryAll(projectsTableId(), { select, where: and(recent), max }) : Promise.resolve({ rows: [], total: 0, truncated: false })
  ]);
  const byId = new Map();
  for (const row of [...a.rows, ...b.rows]) byId.set(String(raw(row, P.recordId)), row);
  const ids = [...byId.keys()];
  const tasks = await tasksFor(ids, [INSTALL_TEMPLATE_ID, SERVICE_TEMPLATE_ID]);
  const entries = ids.map((id) => {
    const row = byId.get(id);
    const qbCompleted = !isBlank(raw(row, P.installCompleted));
    const s = installSummary(tasks.get(id), today);
    const originalDate = s.originalInstallDate || raw(row, P.installScheduledStart);
    const completedOn = raw(row, P.installCompleted);
    const startOn = [s.originalInstallDate, raw(row, P.installScheduledStart)].filter((d) => !isBlank(d)).sort()[0];
    const backdated = qbCompleted && !isBlank(startOn) && String(completedOn) < String(startOn);
    const rtr = {
      status: plain(raw(row, P.rtrStatus)) || undefined,
      installStatus: plain(raw(row, P.rtrInstallStatus)) || undefined,
      workRemaining: asList(raw(row, P.rtrWorkRemaining))
    };
    return {
      recordId: Number(id),
      customer: plain(raw(row, P.name)),
      address: plain(raw(row, P.address)),
      coordinator: plain(raw(row, P.coordinator)),
      batteryOnly: isBatteryOnly(sizeOf(raw(row, P.systemSize))) || undefined,
      qbInstallScheduledStart: raw(row, P.installScheduledStart),
      qbInstallCompleted: raw(row, P.installCompleted),
      originalInstallDate: originalDate,
      currentInstallDate: s.currentInstallDate,
      rolls: s.rolls,
      projectStatus: plain(raw(row, P.status)),
      latestFieldStatus: s.latestFieldStatus,
      latestTaskStatus: s.latestTaskStatus,
      taskSubmitted: s.taskSubmitted,
      rtrInstallStatus: rtr.installStatus,
      rtrStatus: rtr.status,
      rtrWorkRemaining: rtr.workRemaining.length ? rtr.workRemaining : undefined,
      serviceTasks: s.serviceTasks.length ? s.serviceTasks : undefined,
      daysSinceOriginal: originalDate ? daysBetween(originalDate, today) : undefined,
      blocker: classify({ qbCompleted, s, rtr }),
      completedBeforeStart: backdated || undefined,
      qbCompleted
    };
  });
  return { entries, truncated: a.truncated || b.truncated, today };
}

// --- registration ------------------------------------------------------------

export function registerTriageTools(server) {
  if (!quickbaseConfigured()) return;

  server.registerTool(
    'wip_install_triage',
    {
      title: 'Install work-in-progress triage',
      description:
        'Installs that are NOT truly complete. Reconciles the Quickbase install-completed date against BOTH the field task (never submitted = FALSE COMPLETE) and the crew RTR (Partially Completed, work remaining, RTR saying Fully Installed while listing work remaining, or no RTR at all). ' +
        'Per project: original vs current install date, number of reschedules (rolls), last field status, and the blocker. Defaults to Kin Home, non-test projects. Read-only.',
      inputSchema: {
        ...scopeShape,
        status: z.string().optional().describe('Project status to include (default Active; use "any" to include Complete/other statuses too).'),
        lookbackDays: z.number().int().min(0).max(200).optional().describe('Also check installs QB marked complete within this many days against the field task and RTR (default 60; 0 = skip).'),
        includeFuture: z.boolean().optional().describe('Include projects whose install start date is still in the future (default false).'),
        onlyProblems: z.boolean().optional().describe('Hide rows that look healthy (Scheduled / In progress / Complete). Default true.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows returned (default 60).')
      }
    },
    async ({ scope, includeTests, status = 'Active', lookbackDays = 60, includeFuture = false, onlyProblems = true, limit = 60 }) =>
      safe(async () => {
        const { entries, truncated, today } = await collectInstalls({ scope, includeTests, lookbackDays, includeFuture, max: 1000, status });
        const healthy = new Set(['Scheduled', 'In progress', 'Complete']);
        let rows = entries.filter((e) => (onlyProblems ? !healthy.has(e.blocker) || e.completedBeforeStart : true));
        rows.sort((a, b) => (b.daysSinceOriginal ?? -1) - (a.daysSinceOriginal ?? -1));
        const counts = {};
        for (const e of rows) counts[e.blocker] = (counts[e.blocker] || 0) + 1;
        const backdated = rows.filter((e) => e.completedBeforeStart).length;
        const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k.split(':')[0]}`);
        if (backdated) parts.push(`${backdated} with a Quickbase complete date earlier than the install start (likely backfilled)`);
        return ({
          summary: `${rows.length} of ${entries.length} installs checked need attention` + (parts.length ? ': ' + parts.join('; ') : '') + '.',
          asOf: today,
          scope: scope || 'kin',
          checked: entries.length,
          flagged: rows.length,
          byBlocker: counts,
          completedBeforeStart: backdated,
          truncated: truncated || rows.length > limit || undefined,
          projects: rows.slice(0, limit).map(({ qbCompleted, ...e }) => e),
          note: 'Field-task history is from the Arrivy task mirror in Quickbase. Arrivy is being retired, so TOA events will matter more as they replace it.'
        });
      })
  );

  server.registerTool(
    'aging_stalls',
    {
      title: 'Oldest stalled installs',
      description:
        'Ranks installs that are not complete by days since the ORIGINAL scheduled install date (oldest first), flagging ones with no future install booked. Defaults to Kin Home, Active, non-test. Read-only.',
      inputSchema: {
        ...scopeShape,
        minDays: z.number().int().min(0).optional().describe('Only installs at least this many days past their original date (default 7).'),
        limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 25).')
      }
    },
    async ({ scope, includeTests, minDays = 7, limit = 25 }) =>
      safe(async () => {
        const { entries, today } = await collectInstalls({ scope, includeTests, lookbackDays: 0, includeFuture: false, max: 500 });
        const rows = entries
          .filter((e) => !e.qbCompleted && (e.daysSinceOriginal ?? 0) >= minDays)
          .sort((a, b) => (b.daysSinceOriginal ?? 0) - (a.daysSinceOriginal ?? 0))
          .slice(0, limit)
          .map(({ qbCompleted, taskSubmitted, ...e }) => ({ ...e, needsReschedule: /Needs reschedule|Go-back|No install task/.test(e.blocker) }));
        return ({ asOf: today, scope: scope || 'kin', returned: rows.length, projects: rows });
      })
  );

  server.registerTool(
    'project_schedule_history',
    {
      title: 'Project schedule history',
      description:
        'For one or more projects (record IDs, customer names, or addresses): the original install date, current/next date, how many times it was rescheduled, every install visit with its status, and whether a go-back was booked as a Service task instead of a Full Install. Also lists TOA events when the project exists in TOA. Read-only.',
      inputSchema: {
        projects: z.array(z.union([z.string(), z.number()])).min(1).max(10).describe('Record IDs and/or customer names/addresses.'),
        includeToa: z.boolean().optional().describe('Also pull TOA events (default true).')
      }
    },
    async ({ projects, includeToa = true }) =>
      safe(async () => {
        const rows = await resolveProjects(projects, [P.recordId, P.name, P.address, P.status, P.installScheduledStart, P.installCompleted, P.coordinator], { perInput: 3 });
        if (!rows.length) return ({ found: 0, note: 'No matching projects.' });
        const today = todayDenver();
        const ids = rows.map((r) => String(raw(r, P.recordId)));
        const tasks = await tasksFor(ids);
        const out = [];
        for (const row of rows) {
          const id = String(raw(row, P.recordId));
          const all = tasks.get(id) || [];
          const s = installSummary(all, today);
          const entry = {
            recordId: Number(id),
            customer: plain(raw(row, P.name)),
            status: raw(row, P.status),
            qbInstallScheduledStart: raw(row, P.installScheduledStart),
            qbInstallCompleted: raw(row, P.installCompleted),
            originalInstallDate: s.originalInstallDate,
            currentInstallDate: s.currentInstallDate,
            rolls: s.rolls,
            installVisits: s.installDates,
            serviceTasks: s.serviceTasks.length ? s.serviceTasks : undefined,
            goBackBookedAsService: s.serviceTasks.length > 0 && !s.hasFutureInstall ? true : undefined,
            otherTasks: all
              .filter((t) => t.templateId !== INSTALL_TEMPLATE_ID && t.templateId !== SERVICE_TEMPLATE_ID)
              .map((t) => ({ type: t.type, date: t.scheduledDate, status: t.status, fieldStatus: t.fieldStatus }))
          };
          if (includeToa) {
            try {
              const { data } = await toaRequest(`/projects/${encodeURIComponent(id)}`);
              const toaId = data?.id;
              if (toaId) {
                const ev = await toaRequest('/events', { query: { jobId: toaId, limit: 100 } });
                const list = Array.isArray(ev.data) ? ev.data : [];
                entry.toa = {
                  projectId: toaId,
                  events: list
                    .map((e) => ({ date: (e.start?.dateTime || '').slice(0, 10), status: e.status, visit: e.visitNumber, title: e.title }))
                    .sort((a, b) => a.date.localeCompare(b.date))
                };
              } else entry.toa = { note: 'Not in TOA yet.' };
            } catch (err) {
              entry.toa = { note: err.status === 404 ? 'Not in TOA yet.' : `TOA lookup failed: ${err.message}` };
            }
          }
          out.push(entry);
        }
        return ({ asOf: today, projects: out });
      })
  );

  server.registerTool(
    'm2_readiness',
    {
      title: 'M2 readiness',
      description:
        'For installs that are done but not yet M2-ready/received: the downstream blocker (install, inspection, permit, M2 status), the M2 readiness notes from Quickbase, and the project coordinator who owns the next action. Pass specific projects, or leave empty to scan Active Kin Home projects installed in the last N days. Read-only.',
      inputSchema: {
        ...scopeShape,
        projects: z.array(z.union([z.string(), z.number()])).max(25).optional().describe('Record IDs and/or names. Omit to scan recent installs.'),
        installedWithinDays: z.number().int().min(1).max(365).optional().describe('When scanning: installs completed within this many days (default 45).'),
        includeReceived: z.boolean().optional().describe('Include projects whose M2 is already received (default false).'),
        limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 40).')
      }
    },
    async ({ scope, includeTests, projects, installedWithinDays = 45, includeReceived = false, limit = 40 }) =>
      safe(async () => {
        const select = [
          P.recordId, P.name, P.status, P.coordinator, P.installCompleted, P.installScheduledStart, P.inspectionsTotal, P.inspectionsPassed,
          P.inspectionScheduled, P.inspectionPassFail, P.inspectionPassedDate, P.openInspections, P.m2Status, P.m2Readiness, P.m2RequestDate,
          P.readyForM2, P.permitCount, P.permitStatus, P.permitApproved, P.ptoSubmitted, P.ptoApproved
        ];
        const today = todayDenver();
        let rows;
        if (projects?.length) {
          rows = await resolveProjects(projects, select, { scope: scope || 'all', includeTests: includeTests ?? true, perInput: 3 });
        } else {
          const where = and([
            `{${P.status}.EX.${q('Active')}}`,
            `{${P.installCompleted}.OAF.${q(addDays(today, -installedWithinDays))}}`,
            ...scopeClauses(scope, includeTests)
          ]);
          rows = (await queryAll(projectsTableId(), { select, where, sortBy: [{ fieldId: P.installCompleted, order: 'ASC' }], max: 500 })).rows;
        }
        const results = rows.map((row) => {
          const g = (id) => raw(row, id);
          const m2 = g(P.m2Status);
          const installDone = !isBlank(g(P.installCompleted));
          const passed = Number(g(P.inspectionsPassed) || 0) > 0 || !isBlank(g(P.inspectionPassedDate));
          const inspDate = g(P.inspectionScheduled);
          const permitStatus = g(P.permitStatus);
          const blockers = [];
          if (!installDone) blockers.push('Install not complete');
          if (installDone && !passed) {
            if (isBlank(inspDate) && Number(g(P.inspectionsTotal) || 0) === 0) blockers.push('Inspection not scheduled');
            else if (!isBlank(inspDate) && inspDate < today) blockers.push(`Inspection was ${inspDate}, no pass recorded yet`);
            else if (!isBlank(inspDate)) blockers.push(`Inspection scheduled ${inspDate}`);
            else blockers.push('Inspection not passed yet');
          }
          if (installDone && Number(g(P.permitCount) || 0) > 0 && isBlank(g(P.permitApproved)) && permitStatus && !/approved|closed|complete/i.test(permitStatus)) blockers.push(`Permit: ${permitStatus}`);
          if (installDone && /^not ready/i.test(m2 || '')) blockers.push('QB M2 status: Not Ready for M2');
          return {
            recordId: Number(g(P.recordId)),
            customer: plain(g(P.name)),
            coordinator: plain(g(P.coordinator)),
            installCompleted: g(P.installCompleted),
            inspection: { passed, scheduled: inspDate, passFail: g(P.inspectionPassFail), openInspections: g(P.openInspections) },
            permit: permitStatus ? { status: permitStatus, approved: g(P.permitApproved) } : undefined,
            pto: { submitted: g(P.ptoSubmitted), approved: g(P.ptoApproved) },
            m2Status: m2,
            m2ReadinessNotes: plain(g(P.m2Readiness)),
            blockers: blockers.length ? blockers : ['No blocker found in the data'],
            nextAction: blockers.length ? `${plain(g(P.coordinator)) || 'Project coordinator'}: ${blockers[0]}` : undefined
          };
        });
        const filtered = results.filter((r) => includeReceived || !/received/i.test(r.m2Status || '')).slice(0, limit);
        return ({
          asOf: today,
          scope: scope || 'kin',
          returned: filtered.length,
          projects: filtered,
          note: 'Blockers are derived from Quickbase inspection/permit/M2 fields. The m2ReadinessNotes are Quickbase\'s own text and can disagree with the derived blockers; flag that rather than choosing.'
        });
      })
  );

  server.registerTool(
    'battery_only_projects',
    {
      title: 'Battery-only projects',
      description:
        'Lists battery-only projects (system size above 0 and under 1 kW; Kin stores battery-only as 0.00001 kW, not 0). Shows the market fields so blank-market battery deals stand out. Defaults to Kin Home, Active, non-test. Read-only.',
      inputSchema: {
        ...scopeShape,
        status: z.string().optional().describe('Project status to include (default Active; use "any" for all).'),
        blankMarketOnly: z.boolean().optional().describe('Only battery-only projects with no Calculated EPC Market.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50).')
      }
    },
    async ({ scope, includeTests, status = 'Active', blankMarketOnly = false, limit = 50 }) =>
      safe(async () => {
        const clauses = [`{${P.systemSize}.GT.${q('0')}}`, `{${P.systemSize}.LT.${q('1')}}`, ...scopeClauses(scope, includeTests)];
        if (status !== 'any') clauses.push(`{${P.status}.EX.${q(status)}}`);
        if (blankMarketOnly) clauses.push(`{${P.marketCalc}.EX.${q('')}}`);
        const { rows, total } = await queryAll(projectsTableId(), {
          select: [P.recordId, P.name, P.status, P.systemSize, P.marketCalc, P.marketName, P.coordinator, P.installScheduledStart, P.installCompleted],
          where: and(clauses),
          sortBy: [{ fieldId: P.recordId, order: 'DESC' }],
          max: 500
        });
        const items = rows.map((r) => ({
          recordId: raw(r, P.recordId),
          customer: plain(raw(r, P.name)),
          status: raw(r, P.status),
          systemSizeKw: raw(r, P.systemSize),
          market: raw(r, P.marketCalc) || undefined,
          marketNameField: raw(r, P.marketName) || undefined,
          coordinator: plain(raw(r, P.coordinator)),
          installScheduledStart: raw(r, P.installScheduledStart),
          installCompleted: raw(r, P.installCompleted)
        }));
        return ({
          scope: scope || 'kin',
          totalBatteryOnly: total,
          blankMarket: items.filter((i) => !i.market).length,
          returned: Math.min(items.length, limit),
          projects: items.slice(0, limit),
          note: 'Battery-only = size above 0 and under 1 kW (stored as 0.00001). Never test size == 0.'
        });
      })
  );

  server.registerTool(
    'test_record_check',
    {
      title: 'Is this a real job or a test record?',
      description:
        'Check projects (record IDs, names or addresses) before anything is dispatched: the Test Project flag, whether the name/address looks like a test, and the selling entity (Kin Home or other). The flag is set by hand, so the name check is a second safety net. Read-only.',
      inputSchema: {
        projects: z.array(z.union([z.string(), z.number()])).min(1).max(25)
      }
    },
    async ({ projects }) =>
      safe(async () => {
        const rows = await resolveProjects(projects, [P.recordId, P.name, P.address, P.status, P.epc, P.testProject, P.systemSize], { perInput: 5 });
        const looksTest = (s) => /\b(test|testing|tester|demo|sample|dummy|do not use|zz)\b/i.test(String(s || ''));
        const items = rows.map((r) => {
          const flagged = raw(r, P.testProject) === true;
          const nameTest = looksTest(plain(raw(r, P.name))) || looksTest(plain(raw(r, P.address)));
          return {
            recordId: raw(r, P.recordId),
            customer: plain(raw(r, P.name)),
            address: plain(raw(r, P.address)),
            status: raw(r, P.status),
            sellingEntity: raw(r, P.epc),
            testProjectFlag: flagged,
            nameLooksLikeTest: nameTest,
            verdict: flagged ? 'TEST (flagged)' : nameTest ? 'SUSPECT: not flagged, but the name/address looks like a test' : 'Real'
          };
        });
        return ({ checked: items.length, projects: items });
      })
  );
}
