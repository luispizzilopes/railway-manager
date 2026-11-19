// Cliente HTTP tipado. Mutações sempre com JSON (exigido pelo backend contra CSRF);
// o cookie de sessão é HttpOnly e vai automaticamente.

import type {
  ApiErrorBody,
  AssignableRole,
  Credential,
  CredentialKind,
  Dashboard,
  DiscoveredEnvironment,
  DiscoveredWorkspace,
  Environment,
  HistoryEntry,
  HistoryFilters,
  InstanceImportReport,
  DeploymentSummary,
  InstanceView,
  ManagedUser,
  LogsFilters,
  LogsResponse,
  OperationDetail,
  Page,
  Plan,
  PowerKind,
  PowerTarget,
  Project,
  ProjectImportReport,
  RefreshReport,
  Session,
  ScheduleInput,
  ScheduleRun,
  ScheduleView,
  ScheduledAction,
  ScheduledActionInput,
  ScheduledActionStatus,
  Uuid,
} from './types'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.status = status
    this.code = body.code
    this.details = body.details
  }
}

/** Disparado quando a sessão expira, para o app voltar ao login. */
export const UNAUTHORIZED_EVENT = 'rm:unauthorized'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} }
  if (method !== 'GET') {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = body === undefined ? undefined : JSON.stringify(body)
  }
  const response = await fetch(path, init)
  if (response.status === 204) return undefined as T
  const text = await response.text()
  const json = text ? JSON.parse(text) : undefined
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/session') {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
    }
    throw new ApiError(response.status, json ?? { code: 'http_error', message: response.statusText })
  }
  return json as T
}

const get = <T>(path: string) => request<T>('GET', path)
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body)

export function historyQuery(filters: HistoryFilters | Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '' && value !== null) params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

/** Querystring dos logs: `severity` vira lista separada por vírgula. */
export function logsQuery(filters: LogsFilters): string {
  const { severity, ...rest } = filters
  return historyQuery({ ...rest, severity: severity?.length ? severity.join(',') : undefined })
}

export const api = {
  session: () => get<Session>('/api/session'),
  login: (username: string, password: string) => post<void>('/api/session', { username, password }),
  logout: () => request<void>('DELETE', '/api/session'),

  users: () => get<{ users: ManagedUser[] }>('/api/users'),
  createUser: (input: { username: string; password: string; role: AssignableRole }) =>
    post<ManagedUser>('/api/users', input),
  updateUser: (id: Uuid, input: { role?: AssignableRole; is_active?: boolean }) =>
    request<ManagedUser>('PATCH', `/api/users/${id}`, input),
  setUserPassword: (id: Uuid, password: string) => post<void>(`/api/users/${id}/password`, { password }),
  removeUser: (id: Uuid) => request<void>('DELETE', `/api/users/${id}`),

  credential: () => get<{ credential: Credential | null }>('/api/credential'),
  saveCredential: (input: { kind: CredentialKind; token: string; workspace_id?: string }) =>
    request<{ credential: Credential }>('PUT', '/api/credential', input),
  removeCredential: () => request<void>('DELETE', '/api/credential'),

  dashboard: () => get<Dashboard>('/api/dashboard'),
  refresh: () => post<{ report: RefreshReport }>('/api/dashboard/refresh'),

  discoverProjects: () => get<{ workspaces: DiscoveredWorkspace[] }>('/api/railway/projects'),
  projects: () => get<{ projects: Project[] }>('/api/projects'),
  project: (id: Uuid) => get<{ project: Project }>(`/api/projects/${id}`),
  createProject: (railway_project_id: string, display_name?: string) =>
    post<{ project: Project }>('/api/projects', { railway_project_id, display_name: display_name || null }),
  importProjects: (railway_project_ids: string[]) =>
    post<ProjectImportReport>('/api/projects/import', { railway_project_ids }),
  editProject: (id: Uuid, input: { display_name: string | null; description: string | null }) =>
    request<{ project: Project }>('PATCH', `/api/projects/${id}`, input),
  removeProject: (id: Uuid) => request<void>('DELETE', `/api/projects/${id}`),
  syncProject: (id: Uuid) => post<{ project: Project; report: RefreshReport }>(`/api/projects/${id}/sync`),

  environments: (project: Uuid) => get<{ environments: Environment[] }>(`/api/projects/${project}/environments`),
  instances: (project: Uuid) => get<{ instances: InstanceView[] }>(`/api/projects/${project}/instances`),
  discoverInstances: (project: Uuid) =>
    get<{ environments: DiscoveredEnvironment[] }>(`/api/projects/${project}/railway-instances`),
  importInstances: (project: Uuid, instances: { environment_id: string; service_id: string }[]) =>
    post<InstanceImportReport>(`/api/projects/${project}/instances/import`, { instances }),
  associateInstance: (project: Uuid, input: { environment_id: string; service_id: string }) =>
    post<{ instance: InstanceView }>(`/api/projects/${project}/instances`, input),
  instanceLogs: (instance: Uuid, filters: LogsFilters = {}) =>
    get<LogsResponse>(`/api/instances/${instance}/logs${logsQuery(filters)}`),
  instanceDeployments: (instance: Uuid) =>
    get<{ deployments: DeploymentSummary[] }>(`/api/instances/${instance}/deployments`),
  removeInstance: (id: Uuid) => request<void>('DELETE', `/api/instances/${id}`),
  removeService: (id: Uuid) => request<void>('DELETE', `/api/services/${id}`),

  plan: (kind: PowerKind, target: PowerTarget) => post<Plan>('/api/operations/plan', { kind, target }),
  execute: (plan_id: Uuid) => post<{ operation_id: Uuid }>('/api/operations', { plan_id }),
  operation: (id: Uuid) => get<OperationDetail>(`/api/operations/${id}`),

  history: (filters: HistoryFilters) => get<Page<HistoryEntry>>(`/api/history${historyQuery(filters)}`),

  schedules: (projectId?: Uuid) =>
    get<{ schedules: ScheduleView[]; default_timezone: string }>(
      `/api/schedules${projectId ? `?project_id=${projectId}` : ''}`,
    ),
  schedule: (id: Uuid) => get<ScheduleView>(`/api/schedules/${id}`),
  createSchedule: (input: ScheduleInput) => post<ScheduleView>('/api/schedules', input),
  updateSchedule: (id: Uuid, input: ScheduleInput) => request<ScheduleView>('PUT', `/api/schedules/${id}`, input),
  deleteSchedule: (id: Uuid) => request<void>('DELETE', `/api/schedules/${id}`),
  pauseSchedule: (id: Uuid) => post<ScheduleView>(`/api/schedules/${id}/pause`),
  resumeSchedule: (id: Uuid) => post<ScheduleView>(`/api/schedules/${id}/resume`),
  scheduleRuns: (id: Uuid, page = 1) => get<Page<ScheduleRun>>(`/api/schedules/${id}/runs?page=${page}&per_page=20`),

  scheduledActions: (status?: ScheduledActionStatus, page = 1, perPage = 50) =>
    get<Page<ScheduledAction> & { default_timezone: string }>(
      `/api/scheduled-actions${historyQuery({ status, page, per_page: perPage })}`,
    ),
  scheduledAction: (id: Uuid) => get<ScheduledAction>(`/api/scheduled-actions/${id}`),
  createScheduledAction: (input: ScheduledActionInput) => post<ScheduledAction>('/api/scheduled-actions', input),
  cancelScheduledAction: (id: Uuid) => post<ScheduledAction>(`/api/scheduled-actions/${id}/cancel`),
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim())
}
