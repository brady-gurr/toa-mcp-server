import { z } from 'zod';
import { toaRequest } from './toaClient.js';

// --- helpers --------------------------------------------------------------

function textResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

async function safe(fn) {
  try {
    return textResult(await fn());
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { error: err.message, status: err.status, details: err.body },
            null,
            2
          )
        }
      ],
      isError: true
    };
  }
}

const pageShape = {
  limit: z.number().int().min(1).max(100).optional().describe('Max results per page (default 100, max 100).'),
  page: z.number().int().min(1).optional().describe('Page number, 1-based.')
};

/** Registers a "list" (GET collection) tool. */
function registerList(server, { name, description, path, shape = {} }) {
  server.registerTool(
    name,
    {
      title: name,
      description,
      inputSchema: z.object({ ...shape, ...pageShape })
    },
    async (args) => safe(async () => (await toaRequest(path, { query: args })).data)
  );
}

/** Registers a "get one by id" (GET /resource/:id) tool. */
function registerGet(server, { name, description, path, idDescription }) {
  server.registerTool(
    name,
    {
      title: name,
      description,
      inputSchema: z.object({ id: z.string().describe(idDescription || 'TOA id (or supported short code / externalId).') })
    },
    async ({ id }) => safe(async () => (await toaRequest(`${path}/${encodeURIComponent(id)}`)).data)
  );
}

// --- registration -----------------------------------------------------------

export function registerAllTools(server) {
  // Projects
  registerList(server, {
    name: 'toa_list_projects',
    description: 'List TOA projects (newest first). Filter by status or your externalId.',
    path: '/projects',
    shape: {
      status: z.string().optional().describe('Filter by project status.'),
      externalId: z.string().optional().describe('Filter by your imported id.')
    }
  });
  registerGet(server, {
    name: 'toa_get_project',
    description: 'Get one TOA project by its TOA id or your externalId.',
    path: '/projects'
  });

  // Customers
  registerList(server, {
    name: 'toa_list_customers',
    description: 'List TOA customers (homeowners / accounts).',
    path: '/customers',
    shape: { externalId: z.string().optional().describe('Filter by your imported id.') }
  });
  registerGet(server, {
    name: 'toa_get_customer',
    description: 'Get one TOA customer by TOA id or short code (CUS-xxxxx).',
    path: '/customers',
    idDescription: 'TOA customer id or short code, e.g. CUS-7Q2M9.'
  });

  // Sites (properties)
  registerList(server, {
    name: 'toa_list_sites',
    description: 'List TOA sites (physical properties work happens at).',
    path: '/properties',
    shape: { externalId: z.string().optional().describe('Filter by your imported id.') }
  });
  registerGet(server, {
    name: 'toa_get_site',
    description: 'Get one TOA site by TOA id or short code (SIT-xxxxx).',
    path: '/properties',
    idDescription: 'TOA property id or short code, e.g. SIT-6K3PW.'
  });

  // Tracks
  registerList(server, {
    name: 'toa_list_tracks',
    description: 'List work tracks (phases/lanes under a project, e.g. Install, Permitting).',
    path: '/tracks',
    shape: {
      projectId: z.string().optional().describe('Filter to one project.'),
      status: z.enum(['active', 'archived']).optional(),
      externalId: z.string().optional().describe('Filter by your imported id.')
    }
  });
  registerGet(server, {
    name: 'toa_get_track',
    description: 'Get one work track by its TOA id.',
    path: '/tracks'
  });

  // Work types
  server.registerTool(
    'toa_list_work_types',
    {
      title: 'toa_list_work_types',
      description:
        'List this installer\'s work types (needed to resolve the `workType` id/name before creating work). Only active types can be used to create work.',
      inputSchema: z.object({ status: z.enum(['active', 'archived']).optional() })
    },
    async (args) => safe(async () => (await toaRequest('/work-types', { query: args })).data)
  );

  // Work
  registerList(server, {
    name: 'toa_list_work',
    description: 'List work (payable units under a job). Can also list task/subtask rows directly via `kind`.',
    path: '/work',
    shape: {
      jobId: z.string().optional().describe('Filter by job (TOA id or your importedId).'),
      workType: z.string().optional().describe('Filter by work type id.'),
      externalId: z.string().optional().describe('Filter by your external id.'),
      kind: z.enum(['work', 'task', 'subtask']).optional().describe('Defaults to work.'),
      include: z.enum(['tasks']).optional().describe('Set to "tasks" to nest each work\'s tasks/subtasks.')
    }
  });
  server.registerTool(
    'toa_get_work',
    {
      title: 'toa_get_work',
      description: 'Get one work row by its TOA id or your externalId. Pass include="tasks" to nest its tasks/subtasks.',
      inputSchema: z.object({
        id: z.string().describe('TOA work id or your externalId.'),
        include: z.enum(['tasks']).optional()
      })
    },
    async ({ id, include }) =>
      safe(async () => (await toaRequest(`/work/${encodeURIComponent(id)}`, { query: { include } })).data)
  );
  // NOTE: this wrapper is intentionally read-only for now — no create/update
  // tools are registered (TOA's POST /work and PATCH /work/:id are documented
  // but deliberately left out). Add them back here if/when write access is wanted.

  // Forms
  registerList(server, {
    name: 'toa_list_form_submissions',
    description: 'List form submissions (metadata only, no answers), most recently updated first.',
    path: '/form-submissions',
    shape: {
      workId: z.string().optional().describe('The task-work the form was captured against.'),
      jobId: z.string().optional().describe('Filter by project (TOA id or importedId).'),
      templateId: z.string().optional().describe('Filter by form template.'),
      status: z.string().optional().describe('Filter by submission status.')
    }
  });
  registerGet(server, {
    name: 'toa_get_form_submission',
    description: 'Get one form submission with its captured answers (fields/sections/categories/issues/PDFs).',
    path: '/form-submissions'
  });

  // Events
  registerList(server, {
    name: 'toa_list_events',
    description: 'List scheduled events (calendar occurrences), most recent first.',
    path: '/events',
    shape: {
      workId: z.string().optional().describe('Filter by the work the event schedules.'),
      jobId: z.string().optional().describe('Filter by project (TOA id or importedId).'),
      status: z.string().optional(),
      eventType: z.string().optional().describe('Custom event type id.'),
      eventKind: z.string().optional().describe('Built-in kind, e.g. work, timeoff, blockout.'),
      from: z.string().optional().describe('ISO timestamp — lower bound on event start.'),
      to: z.string().optional().describe('ISO timestamp — upper bound on event start.')
    }
  });
  registerGet(server, {
    name: 'toa_get_event',
    description: 'Get one event by its TOA id.',
    path: '/events'
  });

  // Assignments
  registerList(server, {
    name: 'toa_list_assignments',
    description: 'List assignments (who is on a scheduled event) — one row per event.',
    path: '/assignments',
    shape: {
      workId: z.string().optional().describe('Filter by the work whose events you want.'),
      jobId: z.string().optional().describe('Filter by project (TOA id or importedId).'),
      userId: z.string().optional().describe('Only events where this user is an assigned member.')
    }
  });

  // Teams & Users
  registerList(server, {
    name: 'toa_list_teams',
    description: 'List crews/teams, by name.',
    path: '/teams',
    shape: {
      status: z.string().optional(),
      teamMarket: z.string().optional().describe('Filter by market id.')
    }
  });
  registerGet(server, {
    name: 'toa_get_team',
    description: 'Get one team by its TOA id.',
    path: '/teams'
  });
  registerList(server, {
    name: 'toa_list_users',
    description: 'List this installer\'s users (team members).',
    path: '/users',
    shape: {
      role: z.string().optional(),
      jobFunction: z.string().optional().describe('e.g. foreman, electrician, crew_member.')
    }
  });
  registerGet(server, {
    name: 'toa_get_user',
    description: 'Get one user by their TOA id.',
    path: '/users'
  });

  // Changes feed (sync)
  server.registerTool(
    'toa_get_changes',
    {
      title: 'toa_get_changes',
      description:
        'Get just the changed record IDs (grouped by type) since a given time — the cheap way to check what changed without re-paging every list. Lookback capped at 31 days.',
      inputSchema: z.object({
        since: z.string().describe('ISO 8601 timestamp to check changes since. Max 31 days in the past.'),
        types: z
          .string()
          .optional()
          .describe('Comma-separated subset to limit, e.g. "events,work". Omit for all types.'),
        scope: z.enum(['all']).optional().describe('Set to "all" to include historical projects.')
      })
    },
    async (args) => safe(async () => (await toaRequest('/changes', { query: args })).data)
  );
}
