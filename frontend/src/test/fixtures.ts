import type { Dashboard, InstanceCard, Plan, Project } from '../api/types'

export const PROJECT: Project = {
  id: 'p-1',
  credential_id: 'c-1',
  railway_project_id: '00000000-0000-4000-8000-000000000001',
  name: 'loja',
  display_name: null,
  description: null,
  created_at: new Date().toISOString(),
  last_synced_at: new Date().toISOString(),
  sync_status: 'ok',
}

export function card(overrides: Partial<InstanceCard>): InstanceCard {
  return {
    id: 'i-1',
    service_name: 'api',
    state: 'running',
    freshness: 'fresh',
    not_found: false,
    last_observed_at: new Date().toISOString(),
    last_sync_error: null,
    latest_deployment_status: 'SUCCESS',
    busy: false,
    ...overrides,
  }
}

export function dashboard(cards: InstanceCard[], overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    generated_at: new Date().toISOString(),
    integration_ready: true,
    credential: null,
    indicators: { projects: 1, instances: cards.length, running: 1, sleeping: 0, stopped: 1, failed: 1, other: 0 },
    projects: [
      {
        project: PROJECT,
        environments: [
          {
            environment: {
              id: 'e-1',
              project_id: 'p-1',
              railway_environment_id: '00000000-0000-4000-8000-000000000010',
              name: 'production',
              is_ephemeral: false,
            },
            instances: cards,
          },
        ],
        next_action: null,
      },
    ],
    recent_operations: [],
    alerts: [],
    rate_limit: { paused_until: null, remaining: null, limit: null },
    ...overrides,
  }
}

export const PLAN: Plan = {
  plan_id: 'plan-1',
  kind: 'stop',
  scope: 'project',
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 300_000).toISOString(),
  entries: [
    {
      instance_id: 'i-1',
      project_id: 'p-1',
      project_name: 'loja',
      service_name: 'api',
      environment_name: 'production',
      current_state: 'running',
      action: 'will_stop',
      deployments: 1,
      reason_code: null,
      reason: null,
      fails: false,
    },
    {
      instance_id: 'i-2',
      project_id: 'p-1',
      project_name: 'loja',
      service_name: 'worker',
      environment_name: 'production',
      current_state: 'stopped',
      action: 'will_skip',
      deployments: 0,
      reason_code: 'already_in_desired_state',
      reason: 'já está no estado desejado',
      fails: false,
    },
  ],
  estimate: { mutations: 1, reads_per_poll: 1 },
}
