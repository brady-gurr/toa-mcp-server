// Operations tools that combine TOA (scheduling / field work) and Quickbase
// (project system of record). Everything here is READ-ONLY: it only uses
// qbRequest() (reads) and toaRequest() GETs.
//
//   toa_schedule          what's scheduled (by date range / team / crew / work type)
//   crew_workload         load per team and crew member, unassigned work, double-bookings
//   toa_schedule_stats    cycle-time and reschedule reporting from TOA events
//   project_360           one project across Quickbase + TOA (facts, schedule, work)
//   qb_match_project_toa  Quickbase <-> TOA comparison (name, size, address, phone, email)
//   sync_check            Quickbase vs TOA consistency scan

import { z } from 'zod';
import { qbRequest, quickbaseConfigured } from './quickbase.js';
import { toaRequest } from './toaClient.js';
import {
  PF,
  PROJECT_SELECT,
  projectsTableId,
  safe,
  getFields,
  runQuery,
  labelRows,
  plain,
  norm,
  q
} from './qbSmart.js';

// --- guidance for Claude: what to do when this connector can't settle something ---

export const SERVER_INSTRUCTIONS =
  'Kin Home data connector: TOA (field scheduling and work) and Quickbase (project system of record), read-only. ' +
  'Prefer the high-level tools (qb_find_project, qb_search_records, project_360, toa_schedule, crew_workload) over raw ones. ' +
  'If something cannot be determined or validated here (an ambiguous table or field, no matching record after one or two alternate searches, ' +
  'TOA and Quickbase disagreeing, or a business-rule question the data cannot answer), do not guess. ' +
  'Say what you checked and what you are unsure about. Then, if a Sparky connector is available, ask Sparky once with a specific question that includes the table, field or ID involved ' +
  '(Sparky is slow, so use it only when actually needed). For Quickbase schema or field-meaning questions Sparky cannot settle, suggest asking Dev and offer to draft the message. ' +
  'Never send anything to Dev or anyone else without the user saying so. ' +
  'Kin conventions: a system size of 0.00001 kW in Quickbase or TOA means a battery-only project; describe it as battery-only, never as a placeholder or missing data. ' +
  'For install questions use wip_install_triage (not-truly-complete installs), project_schedule_history (original vs current date, rolls, go-backs), aging_stalls, m2_readiness, battery_only_projects and test_record_check; they default to Kin Home, non-test projects. ' +
  'TOA scheduling and its integrations are still being rolled out, so status or schedule gaps between Quickbase and TOA are expected for now; report them as observations, not errors.';

// --- small utilities --------------------------------------------------------

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();
async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const round = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(d)) : n);
const todayDenver = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
const addDays = (dateStr, n) => new Date(new Date(dateStr + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function nameFromEmail(email) {
  if (!email) return undefined;
  return email
    .split('@')[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// --- TOA helpers --------------------------------------------------------------

// Fetch a TOA list endpoint across pages (100 per page).
async function toaAll(path, { query = {}, maxPages = 5 } = {}) {
  const items = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await toaRequest(path, { query: { ...query, limit: 100, page } });
    const rows = Array.isArray(data) ? data : [];
    items.push(...rows);
    if (rows.length < 100) return { items, truncated: false };
    if (page === maxPages) truncated = true;
  }
  return { items, truncated };
}

const getTeams = () =>
  cached('teams', async () => {
    const { items } = await toaAll('/teams', { maxPages: 5 });
    return new Map(items.map((t) => [t.id, t.name]));
  });

const getUsers = () =>
  cached('users', async () => {
    const { items } = await toaAll('/users', { maxPages: 10 });
    return new Map(items.map((u) => [u.id, { name: nameFromEmail(u.email) || u.id, email: u.email, jobFunction: u.jobFunction }]));
  });

const getWorkTypes = () =>
  cached('workTypes', async () => {
    const { data } = await toaRequest('/work-types');
    return new Map((Array.isArray(data) ? data : []).map((w) => [w.id, w.name]));
  });

async function workTypeForWork(workId) {
  return cached('work:' + workId, async () => {
    try {
      const { data } = await toaRequest(`/work/${encodeURIComponent(workId)}`);
      const types = await getWorkTypes();
      return { workType: types.get(data?.workType) || data?.workType, jobId: data?.jobId, workStatus: data?.currentStatus };
    } catch (err) {
      if (err.status === 404) return {};
      throw err;
    }
  });
}

// Normalise a TOA event into a compact, human-readable row.
function normEvent(e, teams, users) {
  const teamNames = (e.assignmentTargets || [])
    .filter((t) => t.kind === 'team')
    .map((t) => teams.get(t.ref) || t.ref);
  const crew = (e.assignedMembers || []).map((id) => users.get(id)?.name || id);
  const startLocal = e.start?.dateTime || '';
  const endLocal = e.end?.dateTime || '';
  return {
    eventId: e.id,
    code: e.shortCode,
    jobId: e.jobId,
    workId: e.workId,
    customer: e.title,
    kind: e.eventKind,
    status: e.status,
    scheduleStatus: e.scheduleStatus,
    visit: e.visitNumber,
    date: startLocal.slice(0, 10),
    start: startLocal.slice(11, 16),
    end: endLocal.slice(11, 16),
    timeZone: e.start?.timeZone,
    hours: round((e.durationMinutes || 0) / 60),
    teams: teamNames,
    crew,
    startAt: e.startAt,
    endAt: e.endAt,
    createdAt: e.createdAt
  };
}

// Events whose LOCAL start date falls within [from, to] (inclusive).
async function eventsInRange(from, to, { maxPages = 10, extra = {} } = {}) {
  const fromIso = new Date(new Date(from + 'T00:00:00Z').getTime() - 14 * 3600000).toISOString();
  const toIso = new Date(new Date(to + 'T23:59:59Z').getTime() + 12 * 3600000).toISOString();
  const { items, truncated } = await toaAll('/events', { query: { from: fromIso, to: toIso, ...extra }, maxPages });
  const [teams, users] = await Promise.all([getTeams(), getUsers()]);
  const events = items
    .map((e) => normEvent(e, teams, users))
    .filter((e) => e.date >= from && e.date <= to)
    .sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
  return { events, truncated };
}

function resolveRange({ date, from, to, days }, defaultDays = 1) {
  if (date && !isDate(date)) throw new Error('date must be YYYY-MM-DD.');
  if (from && !isDate(from)) throw new Error('from must be YYYY-MM-DD.');
  if (to && !isDate(to)) throw new Error('to must be YYYY-MM-DD.');
  const start = date || from || todayDenver();
  const end = date ? date : to || addDays(start, (days ?? defaultDays) - 1);
  if (end < start) throw new Error('to must not be before from.');
  if ((new Date(end) - new Date(start)) / 86400000 > 92) throw new Error('Range too large (max about 3 months).');
  return { from: start, to: end };
}

const has = (hay, needle) => String(hay ?? '').toLowerCase().includes(String(needle).toLowerCase());

async function attachWorkTypes(events, cap) {
  const ids = [...new Set(events.map((e) => e.workId).filter(Boolean))];
  const todo = ids.slice(0, cap);
  const info = new Map();
  for (const id of todo) info.set(id, await workTypeForWork(id));
  for (const e of events) e.workType = info.get(e.workId)?.workType;
  return { resolved: todo.length, skipped: Math.max(0, ids.length - todo.length) };
}

// --- QB <-> TOA comparison ------------------------------------------------------

const SUFFIX = {
  street: 'st', avenue: 'ave', boulevard: 'blvd', drive: 'dr', road: 'rd', lane: 'ln', court: 'ct', circle: 'cir',
  place: 'pl', highway: 'hwy', parkway: 'pkwy', terrace: 'ter', trail: 'trl', north: 'n', south: 's', east: 'e',
  west: 'w', apartment: 'apt', suite: 'ste'
};
const normAddr = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SUFFIX[w] || w)
    .join(' ');

function addressMatches(qbAddr, toaAddr) {
  if (!qbAddr || !toaAddr?.line1) return undefined;
  const qa = normAddr(qbAddr);
  const line1 = normAddr(toaAddr.line1);
  if (!qa || !line1) return undefined;
  if (qa.includes(line1)) return true;
  const [num, first] = line1.split(' ');
  return Boolean(num && first && new RegExp(`(^| )${num} ${first}( |$)`).test(qa));
}

const digits10 = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);
const sameEmail = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const toaAddrString = (a) => (a ? [a.line1, a.city, a.state, a.postalCode].filter(Boolean).join(', ') : undefined);

// Customer contact fields in the Projects table ("Residential Client Main Contact"):
// 147 office/home phone, 148 mobile phone, 149 email.
const CONTACT_PHONE_IDS = [148, 147];
const CONTACT_EMAIL_ID = 149;
async function contactFields() {
  return { phone: { id: CONTACT_PHONE_IDS[0] }, email: { id: CONTACT_EMAIL_ID } };
}

async function toaProjectRaw(externalId) {
  try {
    const { data } = await toaRequest(`/projects/${encodeURIComponent(externalId)}`);
    if (data && data.id) return data;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  try {
    const { data } = await toaRequest('/projects', { query: { externalId, limit: 1 } });
    if (Array.isArray(data) && data[0]) return data[0];
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  return null;
}

function compareProject(qb, toa) {
  if (!toa) return { foundInToa: false };
  const checks = { foundInToa: true, nameMatches: norm(qb.name) === norm(toa.name) };
  if (Number(qb.systemSizeKw) > 0 && Number(qb.systemSizeKw) < 0.001) checks.batteryOnly = true; // 0.00001 kW = battery-only project
  if (qb.systemSizeKw !== null && qb.systemSizeKw !== undefined && toa.systemSize !== null && toa.systemSize !== undefined) {
    checks.systemSizeMatches = Math.abs(Number(qb.systemSizeKw) - Number(toa.systemSize)) < 0.01;
  }
  const addr = addressMatches(qb.address, toa.property?.address);
  if (addr !== undefined) checks.addressMatches = addr;
  const qbPhones = qb.phones?.length ? qb.phones : qb.phone ? [qb.phone] : [];
  if (qbPhones.length && toa.customer?.phone) checks.phoneMatches = qbPhones.some((ph) => digits10(ph) === digits10(toa.customer.phone));
  if (qb.email && toa.customer?.email) checks.emailMatches = sameEmail(qb.email, toa.customer.email);
  const problems = Object.entries(checks)
    .filter(([k, v]) => k.endsWith('Matches') && v === false)
    .map(([k]) => k.replace('Matches', ''));
  if (problems.length) checks.differences = problems;
  return checks;
}

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

// Look up Kin projects in Quickbase, with phone/email when those fields can be identified.
async function lookupProjects(query, top) {
  const contact = await contactFields();
  const extra = [...CONTACT_PHONE_IDS, contact.email.id];
  const result = await runQuery(projectsTableId(), {
    select: [...PROJECT_SELECT, ...extra],
    where: projectSearchWhere(query),
    sortBy: [{ fieldId: PF.recordId, order: 'DESC' }],
    options: { skip: 0, top }
  });
  const cell = (row, id) => (id ? plain(row?.[String(id)]?.value) : undefined);
  const projects = (result.data || []).map((row) => ({
    row,
    recordId: cell(row, PF.recordId),
    name: cell(row, PF.name),
    address: cell(row, PF.address),
    status: cell(row, PF.status),
    systemSizeKw: cell(row, PF.systemSize),
    phones: CONTACT_PHONE_IDS.map((id) => cell(row, id)).filter(Boolean),
    phone: CONTACT_PHONE_IDS.map((id) => cell(row, id)).filter(Boolean).join(' / ') || undefined,
    email: cell(row, contact.email.id)
  }));
  return { projects, total: result.metadata?.totalRecords ?? 0, contact, result };
}

function contactNote(contact) {
  const notes = [];
  if (!contact.phone.id) notes.push(`Quickbase customer phone field not identified (candidates: ${(contact.phone.candidates || []).join('; ') || 'none'}).`);
  if (!contact.email.id) notes.push(`Quickbase customer email field not identified (candidates: ${(contact.email.candidates || []).join('; ') || 'none'}).`);
  return notes.length
    ? notes.join(' ') + ' Phone/email were not compared. If needed, ask Dev which Projects fields hold the customer phone and email.'
    : undefined;
}

async function compactToa(toa) {
  if (!toa) return null;
  return {
    id: toa.id,
    url: toa.url,
    name: toa.name,
    externalId: toa.externalId,
    systemSizeKw: toa.systemSize,
    address: toaAddrString(toa.property?.address),
    phone: toa.customer?.phone,
    email: toa.customer?.email,
    createdAt: toa.createdAt,
    updatedAt: toa.updatedAt
  };
}

// --- registration -------------------------------------------------------------------

export function registerOpsTools(server) {
  const qbOn = quickbaseConfigured();

  // 1. toa_schedule ----------------------------------------------------------------
  server.registerTool(
    'toa_schedule',
    {
      title: 'toa_schedule',
      description:
        'What is scheduled in TOA, with team and crew NAMES and work types resolved. Use for "what\'s on the schedule Friday", "what is the Express crew doing this week", "who is on the Garland install". ' +
        'Pass date (one day) or from/to (YYYY-MM-DD, inclusive) or days (from today, Mountain time). Times are each job\'s local time. ' +
        'Optional filters: team (name contains), crew (person name contains), customer (name contains), workType (name contains).',
      inputSchema: z.object({
        date: z.string().optional().describe('One day, YYYY-MM-DD.'),
        from: z.string().optional().describe('Start date, YYYY-MM-DD.'),
        to: z.string().optional().describe('End date, YYYY-MM-DD (inclusive).'),
        days: z.number().int().min(1).max(31).optional().describe('Number of days starting today (default 1).'),
        team: z.string().optional(),
        crew: z.string().optional().describe('Crew member name or email fragment.'),
        customer: z.string().optional(),
        workType: z.string().optional().describe('e.g. "install", "survey", "inspection".'),
        includeNonWork: z.boolean().optional().describe('Include time off / blockouts (default false).')
      })
    },
    async (args) =>
      safe(async () => {
        const { from, to } = resolveRange(args, 1);
        const { events: all, truncated } = await eventsInRange(from, to);
        let events = all.filter((e) => args.includeNonWork || e.kind === 'work' || !e.kind);
        if (args.team) events = events.filter((e) => e.teams.some((t) => has(t, args.team)));
        if (args.crew) events = events.filter((e) => e.crew.some((c) => has(c, args.crew)));
        if (args.customer) events = events.filter((e) => has(e.customer, args.customer));
        const cap = args.workType ? 150 : 40;
        const wt = await attachWorkTypes(events, cap);
        if (args.workType) events = events.filter((e) => has(e.workType, args.workType));
        const byDay = new Map();
        for (const e of events.slice(0, 300)) {
          const row = {
            time: `${e.start}-${e.end} ${e.timeZone?.split('/')[1]?.replace(/_/g, ' ') || ''}`.trim(),
            customer: e.customer,
            workType: e.workType,
            teams: e.teams,
            crew: e.crew,
            scheduleStatus: e.scheduleStatus !== 'scheduled' ? e.scheduleStatus : undefined,
            status: e.status !== 'confirmed' ? e.status : undefined,
            visit: e.visit > 1 ? e.visit : undefined,
            jobId: e.jobId
          };
          if (!byDay.has(e.date)) byDay.set(e.date, []);
          byDay.get(e.date).push(row);
        }
        return {
          range: { from, to },
          totalEvents: events.length,
          days: [...byDay.entries()].map(([date, rows]) => ({ date, count: rows.length, events: rows })),
          notes: [
            events.length > 300 ? 'Showing the first 300 events.' : undefined,
            truncated ? 'More events exist in this range than were fetched; narrow the dates.' : undefined,
            wt.skipped ? `Work types were looked up for ${wt.resolved} events; ${wt.skipped} more were not (narrow the range or filter).` : undefined
          ].filter(Boolean)
        };
      })
  );

  // 2. crew_workload ----------------------------------------------------------------
  server.registerTool(
    'crew_workload',
    {
      title: 'crew_workload',
      description:
        'Workload and problems on the TOA schedule: events and hours per team and per crew member per day, UNASSIGNED events, and DOUBLE-BOOKED crew members (overlapping events) . ' +
        'Defaults to the next 7 days from today (Mountain time). Also flags crew over a daily hours threshold (default 10).',
      inputSchema: z.object({
        from: z.string().optional().describe('Start date YYYY-MM-DD (default today).'),
        to: z.string().optional().describe('End date YYYY-MM-DD (default 6 days after start).'),
        days: z.number().int().min(1).max(31).optional(),
        maxHoursPerDay: z.number().min(1).max(24).optional().describe('Flag crew above this many hours in a day (default 10).')
      })
    },
    async (args) =>
      safe(async () => {
        const { from, to } = resolveRange({ from: args.from, to: args.to, days: args.days }, 7);
        const { events: all, truncated } = await eventsInRange(from, to);
        const events = all.filter((e) => e.kind === 'work' || !e.kind);
        const limit = args.maxHoursPerDay ?? 10;

        const teamDay = new Map();
        const crewDay = new Map();
        const unassigned = [];
        for (const e of events) {
          if (!e.teams.length && !e.crew.length) unassigned.push({ date: e.date, time: `${e.start}-${e.end}`, customer: e.customer, jobId: e.jobId });
          for (const t of e.teams.length ? e.teams : []) {
            const k = `${t}|${e.date}`;
            const v = teamDay.get(k) || { team: t, date: e.date, events: 0, hours: 0 };
            v.events += 1;
            v.hours = round(v.hours + e.hours);
            teamDay.set(k, v);
          }
          for (const c of e.crew) {
            const k = `${c}|${e.date}`;
            const v = crewDay.get(k) || { person: c, date: e.date, events: 0, hours: 0 };
            v.events += 1;
            v.hours = round(v.hours + e.hours);
            crewDay.set(k, v);
          }
        }

        // double-bookings: same person, overlapping time windows
        const byPerson = new Map();
        for (const e of events) {
          for (const c of e.crew) {
            if (!byPerson.has(c)) byPerson.set(c, []);
            byPerson.get(c).push(e);
          }
        }
        const doubleBooked = [];
        for (const [person, list] of byPerson) {
          list.sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
          for (let i = 1; i < list.length; i++) {
            if (new Date(list[i].startAt) < new Date(list[i - 1].endAt)) {
              doubleBooked.push({
                person,
                date: list[i].date,
                first: { customer: list[i - 1].customer, time: `${list[i - 1].start}-${list[i - 1].end}` },
                second: { customer: list[i].customer, time: `${list[i].start}-${list[i].end}` }
              });
            }
          }
        }

        const overloaded = [...crewDay.values()].filter((c) => c.hours > limit);
        const perTeam = [...teamDay.values()].sort((a, b) => a.date.localeCompare(b.date) || a.team.localeCompare(b.team));
        return {
          range: { from, to },
          totalEvents: events.length,
          unassignedCount: unassigned.length,
          unassigned: unassigned.slice(0, 50),
          doubleBookedCount: doubleBooked.length,
          doubleBooked: doubleBooked.slice(0, 50),
          overThreshold: { maxHoursPerDay: limit, crew: overloaded.slice(0, 50) },
          teamsByDay: perTeam.slice(0, 200),
          busiestCrew: [...crewDay.values()].sort((a, b) => b.hours - a.hours).slice(0, 15),
          notes: [truncated ? 'More events exist than were fetched; narrow the dates.' : undefined].filter(Boolean)
        };
      })
  );

  // 3. toa_schedule_stats ------------------------------------------------------------
  server.registerTool(
    'toa_schedule_stats',
    {
      title: 'toa_schedule_stats',
      description:
        'Reporting on TOA scheduled work over a period: counts by status and team, repeat visits (visit number above 1, i.e. reschedules/return trips), average job length, ' +
        'and lead time from when an event was created to when it starts. Defaults to the last 30 days through today (Mountain time).',
      inputSchema: z.object({
        from: z.string().optional().describe('Start date YYYY-MM-DD.'),
        to: z.string().optional().describe('End date YYYY-MM-DD.'),
        team: z.string().optional().describe('Limit to teams whose name contains this.')
      })
    },
    async ({ from, to, team }) =>
      safe(async () => {
        const end = to || todayDenver();
        const start = from || addDays(end, -29);
        if (!isDate(start) || !isDate(end)) throw new Error('from/to must be YYYY-MM-DD.');
        const { events: all, truncated } = await eventsInRange(start, end, { maxPages: 15 });
        let events = all.filter((e) => e.kind === 'work' || !e.kind);
        if (team) events = events.filter((e) => e.teams.some((t) => has(t, team)));
        const tally = (fn) => {
          const m = new Map();
          for (const e of events) {
            const k = fn(e) ?? '(none)';
            m.set(k, (m.get(k) || 0) + 1);
          }
          return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
        };
        const repeat = events.filter((e) => e.visit > 1);
        const leads = events
          .map((e) => (new Date(e.startAt) - new Date(e.createdAt)) / 86400000)
          .filter((d) => Number.isFinite(d))
          .sort((a, b) => a - b);
        const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : undefined);
        const teamStats = new Map();
        for (const e of events) {
          for (const t of e.teams.length ? e.teams : ['(unassigned)']) {
            const v = teamStats.get(t) || { team: t, events: 0, repeatVisits: 0, hours: 0 };
            v.events += 1;
            v.hours = round(v.hours + e.hours);
            if (e.visit > 1) v.repeatVisits += 1;
            teamStats.set(t, v);
          }
        }
        return {
          range: { from: start, to: end },
          totalEvents: events.length,
          byScheduleStatus: tally((e) => e.scheduleStatus),
          byStatus: tally((e) => e.status),
          repeatVisits: { count: repeat.length, percent: events.length ? round((repeat.length / events.length) * 100, 1) : 0 },
          avgJobHours: round(avg(events.map((e) => e.hours))),
          leadTimeDays: leads.length
            ? { average: round(avg(leads), 1), median: round(leads[Math.floor(leads.length / 2)], 1) }
            : undefined,
          byTeam: [...teamStats.values()].sort((a, b) => b.events - a.events).slice(0, 25),
          notes: [
            'Repeat visits are inferred from TOA\'s visit number; they include return trips as well as reschedules.',
            'TOA only has data from when scheduling moved into it, so early periods will look thin.',
            truncated ? 'More events exist than were fetched; narrow the dates.' : undefined
          ].filter(Boolean)
        };
      })
  );

  if (!qbOn) return; // the rest need Quickbase

  // 4. qb_match_project_toa ------------------------------------------------------------
  server.registerTool(
    'qb_match_project_toa',
    {
      title: 'qb_match_project_toa',
      description:
        'Compare a Kin project between Quickbase and TOA. A TOA project\'s externalId is the Quickbase Record ID#. Checks name, system size, ADDRESS, phone and email, and lists differences. ' +
        'Pass a customer name, address, Record ID# (e.g. "11306"), or a TOA project id.',
      inputSchema: z.object({
        query: z.string().describe('Customer name, address, Record ID# / TOA externalId, or TOA project id.'),
        top: z.number().int().min(1).max(5).optional().describe('Max projects to compare (default 3).')
      })
    },
    async ({ query, top }) =>
      safe(async () => {
        let text = String(query).trim();
        if (/^[0-9a-f]{24}$/i.test(text)) {
          const { data } = await toaRequest(`/projects/${encodeURIComponent(text)}`);
          if (!data?.externalId) return { query, error: 'That TOA project has no externalId, so it cannot be matched to Quickbase.', toa: data };
          text = String(data.externalId);
        }
        const { projects, total, contact } = await lookupProjects(text, top ?? 3);
        const results = [];
        for (const p of projects) {
          const toa = await toaProjectRaw(p.recordId);
          results.push({
            quickbase: { recordId: p.recordId, name: p.name, address: p.address, status: p.status, systemSizeKw: p.systemSizeKw, phone: p.phone, email: p.email },
            toa: await compactToa(toa),
            checks: compareProject(p, toa)
          });
        }
        return { query, quickbaseMatches: total, compared: results.length, results, note: contactNote(contact) };
      })
  );

  // 5. project_360 --------------------------------------------------------------------------
  server.registerTool(
    'project_360',
    {
      title: 'project_360',
      description:
        'Everything about one Kin project in one call: Quickbase facts (status, size, sales, lender, coordinator, install dates), the matching TOA project, ' +
        'its TOA schedule (events with team/crew names), its TOA work, and a Quickbase-vs-TOA comparison. Pass a customer name, address, Record ID#, or TOA project id.',
      inputSchema: z.object({
        query: z.string().describe('Customer name, address, Record ID#, or TOA project id.'),
        top: z.number().int().min(1).max(3).optional().describe('Max projects (default 1; use more if the name is ambiguous).')
      })
    },
    async ({ query, top }) =>
      safe(async () => {
        let text = String(query).trim();
        if (/^[0-9a-f]{24}$/i.test(text)) {
          const { data } = await toaRequest(`/projects/${encodeURIComponent(text)}`);
          if (!data?.externalId) return { query, error: 'That TOA project has no externalId, so it cannot be matched to Quickbase.', toa: data };
          text = String(data.externalId);
        }
        const { projects, total, contact, result } = await lookupProjects(text, top ?? 1);
        const labeled = labelRows({ fields: result.fields, data: projects.map((p) => p.row) });
        const [teams, users, types] = await Promise.all([getTeams(), getUsers(), getWorkTypes()]);
        const out = [];
        for (let i = 0; i < projects.length; i++) {
          const p = projects[i];
          const toa = await toaProjectRaw(p.recordId);
          let events = [];
          let work = [];
          let tracks = [];
          if (toa) {
            const ev = await toaAll('/events', { query: { jobId: toa.id }, maxPages: 2 });
            events = ev.items
              .map((e) => normEvent(e, teams, users))
              .sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)))
              .map((e) => ({
                date: e.date,
                time: `${e.start}-${e.end} ${e.timeZone?.split('/')[1]?.replace(/_/g, ' ') || ''}`.trim(),
                kind: e.kind,
                status: e.status,
                scheduleStatus: e.scheduleStatus,
                visit: e.visit,
                teams: e.teams,
                crew: e.crew,
                workId: e.workId
              }));
            const wk = await toaAll('/work', { query: { jobId: toa.id }, maxPages: 2 });
            work = wk.items.map((w) => ({
              id: w.id,
              workType: types.get(w.workType) || w.workType,
              scheduleStatus: w.scheduleStatus,
              archived: w.archived || undefined,
              source: w.source
            }));
            try {
              const tr = await toaRequest('/tracks', { query: { projectId: toa.id, limit: 50 } });
              tracks = Array.isArray(tr.data) ? tr.data : [];
            } catch (err) {
              if (err.status !== 404) throw err;
            }
          }
          out.push({
            quickbase: labeled[i],
            toa: await compactToa(toa),
            schedule: events,
            work,
            tracks: tracks.length ? tracks : undefined,
            checks: compareProject(p, toa)
          });
        }
        return { query, quickbaseMatches: total, projects: out, note: contactNote(contact) };
      })
  );

  // 6. sync_check ------------------------------------------------------------------------------
  server.registerTool(
    'sync_check',
    {
      title: 'sync_check',
      description:
        'Consistency scan between Quickbase and TOA. Finds Quickbase projects flagged "Create Job in TOA" that are missing in TOA, TOA projects with no Quickbase record or without that flag, ' +
        'and name / system size / address differences. Scans the newest TOA projects first and double-checks missing ones individually, so it is bounded and may be partial; the result says so.',
      inputSchema: z.object({
        scanPages: z.number().int().min(1).max(10).optional().describe('TOA project pages (100 each, newest first) to scan. Default 5.'),
        maxLookups: z.number().int().min(0).max(100).optional().describe('Individual TOA lookups to verify "missing" projects. Default 40.')
      })
    },
    async ({ scanPages, maxLookups }) =>
      safe(async () => {
        // Quickbase: projects flagged to be created in TOA
        const flagged = [];
        for (let skip = 0; skip < 3000; skip += 1000) {
          const r = await runQuery(projectsTableId(), {
            select: [PF.recordId, PF.name, PF.address, PF.systemSize, PF.status],
            where: `{2587.EX.'true'}`,
            options: { skip, top: 1000 }
          });
          for (const row of r.data || []) {
            flagged.push({
              recordId: plain(row[String(PF.recordId)]?.value),
              name: plain(row[String(PF.name)]?.value),
              address: plain(row[String(PF.address)]?.value),
              systemSizeKw: plain(row[String(PF.systemSize)]?.value),
              status: plain(row[String(PF.status)]?.value)
            });
          }
          if ((r.data || []).length < 1000) break;
        }

        // TOA: newest projects
        const { items: toaItems, truncated } = await toaAll('/projects', { maxPages: scanPages ?? 5 });
        const toaByExt = new Map(toaItems.filter((p) => p.externalId).map((p) => [String(p.externalId), p]));

        const missing = [];
        const mismatches = [];
        const unverified = [];
        let lookups = 0;
        for (const f of flagged) {
          let toa = toaByExt.get(String(f.recordId));
          if (!toa) {
            if (lookups >= (maxLookups ?? 40)) {
              unverified.push(f.recordId);
              continue;
            }
            lookups++;
            toa = await toaProjectRaw(f.recordId);
          }
          if (!toa) {
            missing.push({ recordId: f.recordId, name: f.name, status: f.status });
            continue;
          }
          const c = compareProject(f, toa);
          if (c.differences) mismatches.push({ recordId: f.recordId, name: f.name, differences: c.differences, quickbase: { address: f.address, systemSizeKw: f.systemSizeKw }, toa: { name: toa.name, address: toaAddrString(toa.property?.address), systemSizeKw: toa.systemSize } });
        }

        // TOA projects with no Quickbase flag / no Quickbase record
        const flaggedSet = new Set(flagged.map((f) => String(f.recordId)));
        const notFlagged = toaItems.filter((p) => p.externalId && /^\d+$/.test(String(p.externalId)) && !flaggedSet.has(String(p.externalId)));
        const orphans = [];
        const unflagged = [];
        for (let i = 0; i < notFlagged.length; i += 40) {
          const chunk = notFlagged.slice(i, i + 40);
          const where = chunk.map((p) => `{${PF.recordId}.EX.${q(p.externalId)}}`).join('OR');
          const r = await runQuery(projectsTableId(), { select: [PF.recordId], where, options: { skip: 0, top: 100 } });
          const found = new Set((r.data || []).map((row) => String(plain(row[String(PF.recordId)]?.value))));
          for (const p of chunk) {
            if (found.has(String(p.externalId))) unflagged.push({ recordId: p.externalId, name: p.name });
            else orphans.push({ toaId: p.id, externalId: p.externalId, name: p.name });
          }
        }

        return {
          quickbaseFlaggedForToa: flagged.length,
          toaProjectsScanned: toaItems.length,
          flaggedButMissingInToa: { count: missing.length, projects: missing.slice(0, 50) },
          toaProjectsWithNoQuickbaseRecord: { count: orphans.length, projects: orphans.slice(0, 50) },
          inToaButNotFlaggedInQuickbase: { count: unflagged.length, projects: unflagged.slice(0, 50) },
          differences: { count: mismatches.length, projects: mismatches.slice(0, 50) },
          notes: [
            unverified.length ? `${unverified.length} flagged projects were not found in the scanned TOA window and were not individually verified (raise maxLookups or scanPages).` : undefined,
            truncated ? 'TOA has more projects than were scanned; "in TOA but not flagged" and "no Quickbase record" lists cover only the newest ones.' : undefined
          ].filter(Boolean)
        };
      })
  );
}
