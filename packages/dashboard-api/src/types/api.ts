import type { AdapterExecutionDraft, AdapterExecutionInit, AdapterScenarioModel } from '../../../host-sdk/src/adapter-model.ts'
import type { Session } from '../../../core/src/index.ts'
import type { BootstrapDraft, DiscoveryReport } from '../../../host-sdk/src/contracts.ts'

export interface DiscoveryRequest {
  repoPath: string
  adapterHint?: string
}

export interface DiscoveryResponse {
  adapterId: string
  report: DiscoveryReport
}

export interface BootstrapRequest {
  repoPath: string
  adapterHint?: string
}

export interface BootstrapResponse {
  adapterId: string
  report: DiscoveryReport
  draft: BootstrapDraft
}

export interface MaterializeRequest {
  repoPath: string
  adapterHint?: string
  targetAdapterId?: string
}

export interface MaterializeResponse {
  adapterId: string
  targetAdapterId: string
  outputDir: string
  files: string[]
  report: DiscoveryReport
  draft: BootstrapDraft
}


export interface InstallLocalRequest {
  repoPath: string
}

export interface InstallLocalResponse {
  repoPath: string
  installedPath: string
  copiedRootFiles: string[]
  copiedRootDirs: string[]
  copiedExtraFiles: string[]
  createdDirs: string[]
  metadataPath: string
  launcherPath: string
  anthropicEnvWritten: boolean
  anthropicEnvValidated: boolean
  anthropicEnvSource:
    | 'ANTHROPIC_API_KEY_OVERRIDE'
    | 'agentic-platform/.env.local'
    | 'ANTHROPIC_API_KEY'
    | 'ANTHROPIC_API'
    | 'target/.agentic-qa/.env.local'
    | 'missing'
  anthropicEnvValidationMessage?: string
  envLocalPath: string
  envExamplePath: string
}

export interface DiscoverLocalRequest {
  repoPath: string
  adapterHint?: string
}

export interface DiscoverLocalResponse {
  adapterId: string
  report: DiscoveryReport
  draft: BootstrapDraft
  localPackagePath: string
  adapterRoot: string
  files: string[]
}

export interface GeneratedAdapterFilesResponse {
  adapterId: string
  files: string[]
}

export interface GeneratedAdapterFileResponse {
  adapterId: string
  filename: string
  filePath: string
  content: string
}

export interface UpdateGeneratedAdapterFileRequest {
  content: string
}

export interface UpdateGeneratedAdapterFileResponse {
  adapterId: string
  filename: string
  filePath: string
  saved: boolean
}

export interface AdapterListItem {
  id: string
  label: string
  framework: string
  status: 'draft' | 'certified'
  scenarioCount: number
  promotionState: 'generated' | 'reviewed' | 'certified_candidate' | 'certified'
  promotionReason: string
  promotionUpdatedAt?: string | null
}

export interface AdapterListResponse {
  adapters: AdapterListItem[]
}

export interface AdapterPromotionResponse {
  adapterId: string
  promotionState: 'generated' | 'reviewed' | 'certified_candidate' | 'certified'
  promotionReason: string
  promotionUpdatedAt: string | null
  signals: {
    hasRestrictedScenarios: boolean
    hasReviewRequiredScenarios: boolean
    openScenarioCount: number
    totalScenarioCount: number
  }
}

export interface UpdateAdapterPromotionRequest {
  targetState: 'reviewed' | 'certified'
}

export interface ScenarioListResponse {
  adapterId: string
  scenarios: Array<AdapterScenarioModel & {
    qualityGate: {
      adapterId: string
      scenarioId: string
      status: 'open' | 'review_required' | 'restricted'
      reason: string
      recentFinalSessions: number
      recentViolated: number
      recentDrift: number
      consecutiveViolated: number
      consecutiveFailures: number
    }
  }>
}

export interface ExecutionEventRecord {
  id: string
  executionId: string
  type:
    | 'execution_initialized'
    | 'execution_started'
    | 'step_started'
    | 'step_completed'
    | 'step_failed'
    | 'execution_completed'
    | 'execution_failed'
    | 'execution_cancelled'
  timestamp: string
  payload: Record<string, unknown>
}

export interface ExecutionRecord extends AdapterExecutionDraft {
  sessionId: string
  createdAt: string
  updatedAt: string
  events: ExecutionEventRecord[]
}

export type ExecutionInitRequest = AdapterExecutionInit
export interface ExecutionInitResponse {
  execution: ExecutionRecord
}

export interface ExecutionListResponse {
  executions: ExecutionRecord[]
}

export interface ExecutionDetailResponse {
  execution: ExecutionRecord
}

export interface SessionGovernancePayload {
  contractEvaluation?: {
    verdict: 'contract_compliant' | 'contract_drift' | 'contract_violated' | 'contract_evaluating'
    hardViolations: number
    driftSignals: number
    final: boolean
    expectedStepOrder: string[]
    observedStepOrder: string[]
    expectedArtifacts: string[]
    producedArtifacts: string[]
    missingArtifacts: string[]
    unexpectedArtifacts: string[]
    observedUnexpectedSteps: string[]
    stepChecks: Array<{
      stepId: string
      roleId: string
      expectedCapability: string
      observedTools: string[]
      expectedOrder: number
      observedOrder: number
      status: 'pending' | 'running' | 'complete' | 'failed'
      neverStarted: boolean
      incomplete: boolean
      outOfOrder: boolean
      capabilityMismatch: boolean
      expectedArtifacts: string[]
    }>
  } | null
  executionId?: string | null
  adapterId?: string | null
}

export interface SessionListResponse {
  sessions: Array<Session & SessionGovernancePayload>
}

export interface SessionDetailResponse {
  session: Session & SessionGovernancePayload
}
