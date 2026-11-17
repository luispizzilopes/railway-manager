// Tipos dos DTOs da API do Railway Manager (espelham o JSON do backend).

export type Uuid = string
export type Iso = string

export type ObservedState =
  | 'running'
  | 'stopped'
  | 'sleeping'
  | 'transitioning'
  | 'failed'
  | 'awaiting_approval'
  | 'unknown'

export type Freshness = 'fresh' | 'stale' | 'unavailable'
export type SyncStatus = 'never' | 'ok' | 'failed' | 'not_found'
export type PowerKind = 'start' | 'stop'
export type OperationScope = 'instance' | 'project' | 'batch'
export type OperationStatus = 'pending' | 'running' | 'succeeded' | 'partially_failed' | 'failed'
export type ItemResult =
  | 'pending'
  | 'running'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'timed_out'
  | 'interrupted'

export type DeploymentStatus =
  | 'BUILDING'
  | 'CRASHED'
  | 'DEPLOYING'
  | 'FAILED'
  | 'INITIALIZING'
  | 'NEEDS_APPROVAL'
  | 'QUEUED'
  | 'REMOVED'
  | 'REMOVING'
  | 'SKIPPED'
  | 'SLEEPING'
  | 'SUCCESS'
  | 'WAITING'

export interface ApiErrorBody {
  code: string
  message: string
  details?: Record<string, unknown>
}

export type CredentialKind = 'account' | 'workspace'
export type CredentialStatus = 'valid' | 'invalid' | 'undecipherable'

export interface Credential {
  id: Uuid
  kind: CredentialKind
  workspace_id: Uuid | null
  label: string
  masked_suffix: string
  status: CredentialStatus
  validated_at: Iso | null
  created_at: Iso
}

export interface Project {
  id: Uuid
  credential_id: Uuid | null
  railway_project_id: Uuid
  name: string
  display_name: string | null
  description: string | null
  created_at: Iso
  last_synced_at: Iso | null
  sync_status: SyncStatus
}

export interface Environment {
  id: Uuid
  project_id: Uuid
  railway_environment_id: Uuid
  name: string
  is_ephemeral: boolean
}

export interface Service {
  id: Uuid
  project_id: Uuid
  railway_service_id: Uuid
  name: string
}

export interface ServiceInstance {
  id: Uuid
  service_id: Uuid
  environment_id: Uuid
  observed_state: ObservedState
  not_found: boolean
  latest_deployment_id: Uuid | null
  latest_deployment_status: DeploymentStatus | null
  last_observed_at: Iso | null
  last_sync_error: string | null
}

export interface InstanceView {
  instance: ServiceInstance
  project: Project
  service: Service
  environment: Environment
}

export interface RailwayProject {
  id: Uuid
  name: string
  description: string | null
  workspace_id: Uuid | null
}

export interface Workspace {
  id: Uuid
  name: string
}

export interface DiscoveredWorkspace {
  workspace: Workspace | null
  projects: { project: RailwayProject; managed: boolean }[]
}

export interface DiscoveredEnvironment {
  environment: { id: Uuid; name: string; is_ephemeral: boolean }
  instances: { service_id: Uuid; service_name: string; state: ObservedState; managed: boolean }[]
}

export interface ImportFailure {
  id: string
  reason: string
}

export interface ProjectImportReport {
  imported: Project[]
  already_managed: string[]
  failed: ImportFailure[]
}

export interface InstanceImportReport {
  imported: Uuid[]
  already_managed: string[]
  failed: ImportFailure[]
}

export interface RefreshReport {
  refreshed: number
  not_found: number
  failed: number
}

export interface InstanceCard {
  id: Uuid
  service_name: string
  state: ObservedState
  freshness: Freshness
  not_found: boolean
  last_observed_at: Iso | null
  last_sync_error: string | null
  latest_deployment_status: DeploymentStatus | null
  busy: boolean
}

export interface Operation {
  id: Uuid
  kind: PowerKind
  scope: OperationScope
  trigger: OperationTrigger
  schedule_name?: string | null
  scheduled_action_label?: string | null
  requested_by: string
  plan_id: Uuid
  status: OperationStatus
  created_at: Iso
  started_at: Iso | null
  finished_at: Iso | null
}

export interface InstanceLabel {
  project_id: Uuid
  project_name: string
  railway_project_id: Uuid
  service_name: string
  railway_service_id: Uuid
  environment_name: string
  railway_environment_id: Uuid
}

export interface OperationItem {
  id: Uuid
  operation_id: Uuid
  service_instance_id: Uuid | null
  label: InstanceLabel
  previous_state: ObservedState
  desired_state: ObservedState
  final_state: ObservedState | null
  deployment_id: Uuid | null
  result: ItemResult
  error_message: string | null
  started_at: Iso | null
  finished_at: Iso | null
  duration_ms: number | null
}

export interface OperationSummary {
  operation: Operation
  total: number
  succeeded: number
  failed: number
  skipped: number
  active: number
  projects: string[]
}

export type AlertCode =
  | 'no_credential'
  | 'credential_invalid'
  | 'credential_undecipherable'
  | 'rate_limited'
  | 'project_not_found'

export interface NextAction {
  action: PowerKind
  at: Iso
  schedule_id: Uuid
  schedule_name: string
}

export interface Dashboard {
  generated_at: Iso
  integration_ready: boolean
  credential: Credential | null
  indicators: {
    projects: number
    instances: number
    running: number
    sleeping: number
    stopped: number
    failed: number
    other: number
  }
  projects: {
    project: Project
    environments: { environment: Environment; instances: InstanceCard[] }[]
    next_action: NextAction | null
  }[]
  recent_operations: OperationSummary[]
  alerts: { code: AlertCode; message: string }[]
  rate_limit: { paused_until: Iso | null; remaining: number | null; limit: number | null }
}

export type PowerTarget =
  | { type: 'instance'; instance_id: Uuid }
  | { type: 'project'; project_id: Uuid; environment_id?: Uuid | null; instance_ids?: Uuid[] | null }
  | { type: 'batch'; project_ids: Uuid[]; environment_name?: string | null }
  | { type: 'instances'; instance_ids: Uuid[] }

export interface PlanEntry {
  instance_id: Uuid
  project_id: Uuid
  project_name: string
  service_name: string
  environment_name: string
  current_state: ObservedState
  action: 'will_stop' | 'will_start' | 'will_skip'
  deployments: number
  reason_code: string | null
  reason: string | null
  fails: boolean
}

export interface Plan {
  plan_id: Uuid
  kind: PowerKind
  scope: OperationScope
  created_at: Iso
  expires_at: Iso
  entries: PlanEntry[]
  estimate: { mutations: number; reads_per_poll: number }
}

export interface OperationDetail {
  operation: Operation
  items: OperationItem[]
  done: boolean
}

export type OperationTrigger = 'manual' | 'schedule' | 'scheduled_action'

export interface HistoryEntry {
  item: OperationItem
  kind: PowerKind
  scope: OperationScope
  requested_by: string
  trigger: OperationTrigger
  schedule_name: string | null
  scheduled_action_label: string | null
  operation_status: OperationStatus
  created_at: Iso
}

export interface Page<T> {
  items: T[]
  total: number
  page: number
  per_page: number
}

export interface HistoryFilters {
  project?: string
  service?: string
  environment?: string
  kind?: string
  result?: string
  trigger?: string
  from?: string
  to?: string
  page?: number
}

export interface ScheduleWindow {
  start: string
  end: string
}

export type ScheduleTarget =
  | { type: 'project'; environment_id: Uuid | null }
  | { type: 'instances'; instance_ids: Uuid[] }

export interface Schedule {
  id: Uuid
  project_id: Uuid
  name: string
  enabled: boolean
  timezone: string
  /** 0 = segunda … 6 = domingo */
  days: number[]
  windows: ScheduleWindow[]
  target: ScheduleTarget
  paused_reason: string | null
  created_at: Iso
  updated_at: Iso
}

export interface Occurrence {
  at: Iso
  action: PowerKind
  window: number
}

export interface ScheduleView {
  schedule: Schedule
  next_runs: Occurrence[]
  warnings: string[]
}

export type RunStatus = 'pending' | 'executed' | 'late' | 'skipped' | 'missed' | 'failed'

export interface ScheduleRun {
  id: Uuid
  schedule_id: Uuid
  schedule_name: string
  action: PowerKind
  scheduled_for: Iso
  processed_at: Iso
  status: RunStatus
  operation_id: Uuid | null
  message: string | null
}

export interface ScheduleInput {
  project_id?: Uuid
  name: string
  timezone: string
  days: number[]
  windows: ScheduleWindow[]
  target: ScheduleTarget
}

export type ActionTarget =
  | { type: 'all'; environment_name?: string | null }
  | { type: 'projects'; project_ids: Uuid[]; environment_name?: string | null }
  | { type: 'instances'; instance_ids: Uuid[] }

export type ScheduledActionStatus =
  | 'pending'
  | 'processing'
  | 'executed'
  | 'late'
  | 'skipped'
  | 'missed'
  | 'failed'
  | 'cancelled'

export interface ScheduledAction {
  id: Uuid
  kind: PowerKind
  run_at: Iso
  target: ActionTarget
  note: string | null
  label: string
  status: ScheduledActionStatus
  message: string | null
  operation_id: Uuid | null
  created_at: Iso
  processed_at: Iso | null
}

export interface ScheduledActionInput {
  kind: PowerKind
  run_at: Iso
  target: ActionTarget
  note?: string | null
}
