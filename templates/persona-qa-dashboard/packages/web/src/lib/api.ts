import { API_BASE, wsBase } from '@/lib/api-base'

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    ...init,
  })
  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new Error(`API error ${response.status}: ${detail ?? response.statusText}`)
  }
  return response.json() as Promise<T>
}

async function readErrorDetail(response: Response): Promise<string | null> {
  try {
    const body = await response.json() as {
      message?: unknown
      error?: unknown
      details?: { message?: unknown }
    }
    const parts = [body.message, body.details?.message]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
    if (parts.length > 0) return parts.join(' ')
    return typeof body.error === 'string' ? body.error : null
  } catch {
    return null
  }
}

export interface CreatePersonaPayload {
  name: string
  role: string
  description: string
  modules: string[]
  color: string
  context: string
}

export interface Phase2SessionSummary {
  id: string
  runId: number | null
  scenarioId: string
  status: 'pending' | 'running' | 'complete' | 'failed'
  startedAt: string
  completedAt: string | null
  eventCount: number
  artifactCount: number
  findingCount: number
  lastError?: string | null
  contractVerdict?: 'contract_compliant' | 'contract_drift' | 'contract_violated' | 'contract_evaluating' | null
  contractHardViolations?: number
  contractDriftSignals?: number
}

export interface Phase2ScenarioSummary {
  id: string
  name: string
  description: string | null
  roles: string[]
  step_count: number
  quality_gate: {
    scenarioId: string
    status: 'open' | 'review_required' | 'restricted'
    reason: string
    recentFinalSessions: number
    recentViolated: number
    recentDrift: number
    consecutiveViolated: number
    consecutiveFailures: number
  }
}

export interface Phase2WorkflowContractResponse {
  scenario_id: string
  scenario_name: string
  workflow_contract: Record<string, unknown>
  workflow_contract_yaml: string
}

export interface Phase2SessionEvent {
  id: string
  sessionId: string
  type: string
  agentRole?: string
  timestamp: string
  payload?: Record<string, unknown>
  data?: Record<string, unknown>
}

export interface Phase2SessionFinding {
  id: string
  timestamp: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  title: string
  evidence?: unknown
  agentId?: string | null
  stepId?: string | null
}

export interface Phase2SessionArtifact {
  id: string
  sessionId: string
  type: 'screenshot' | 'dom_snippet' | 'domain_artifact'
  agentRole: string
  description: string
  filePath?: string
  content?: string
  metadata?: Record<string, unknown>
  timestamp: string
}

export interface Phase2SessionDetail {
  id: string
  runId?: number
  scenarioId: string
  status: 'pending' | 'running' | 'complete' | 'failed'
  startedAt: string
  completedAt?: string
  events: Phase2SessionEvent[]
  artifacts: Record<string, unknown>
  findings: Array<{
    id: string
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
    title: string
    description?: string
    evidence?: unknown
    agentId?: string
    stepId?: string
    createdAt?: string
  }>
  checkpoint: {
    lastCompletedStep: number
    cursor: number
  }
  workflowContract?: Record<string, unknown> | null
  workflowContractYaml?: string | null
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
      agentId: string
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
}

export interface DashboardStats {
  total_runs: number
  complete_runs: number
  failed_runs: number
  pass_rate: number
  avg_duration_ms: number | null
  total_findings: number
  critical_high_findings: number
  total_scenarios: number
  findings_trend: Array<Record<string, unknown>>
  agentic: {
    total_sessions: number
    complete_sessions: number
    failed_sessions: number
    running_sessions: number
    multi_agent_sessions: number
    total_findings: number
    last_activity_at: string | null
    contract_adherence: {
      violated: number
      drift: number
      compliant: number
      no_contract: number
      hard_violations: number
      drift_signals: number
    }
    scenario_quality_gates: {
      open: number
      review_required: number
      restricted: number
    }
  }
}

export interface DashboardStatus {
  api: 'up' | string
  db: 'ok' | 'error' | string
  last_sync: string | null
  last_sync_source: string | null
  latest_activity_at: string | null
  latest_activity_source: 'runs' | 'p2_sessions' | null
  runtime_config?: {
    provider: 'anthropic' | 'openai'
    supported_providers: Array<{
      id: 'anthropic' | 'openai'
      label: string
      description: string
    }>
    anthropic_key: 'configured' | 'default' | 'missing'
    openai_key: 'configured' | 'default' | 'missing'
    test_user: 'configured' | 'default' | 'missing'
    test_password: 'configured' | 'default' | 'missing'
    secondary_user: 'configured' | 'default' | 'missing'
    playwright_base_url: 'configured' | 'default' | 'missing'
    target_app_url: string
    secret_values: 'masked'
  }
  active_run: {
    id: number | string
    status: string
    started_at: string
    source: 'runs' | 'p2_sessions'
  } | null
}

export interface RuntimeSettingsResponse {
  provider: 'anthropic' | 'openai'
  supportedProviders: Array<{
    id: 'anthropic' | 'openai'
    label: string
    description: string
  }>
  appliesTo: 'next_run'
}

export type Phase2LearningProposalStatus = 'proposed' | 'approved' | 'applied' | 'rejected'
export type Phase2LearningProposalPatchKind = 'none' | 'prompt_overlay' | 'capability_patch' | 'environment_check'
export type Phase2HealingActionStatus = 'proposed' | 'applied' | 'blocked' | 'rolled_back'
export type Phase2GovernanceSubjectType = 'learning_proposal' | 'scenario_draft' | 'healing_action'
export type Phase2GovernanceAction = 'generate' | 'approve' | 'apply' | 'reject' | 'evaluate' | 'rollback' | 'promote'
export type Phase2GovernanceVerdict = 'allowed' | 'blocked'
export type Phase2ScenarioDraftStatus = 'pending' | 'approved' | 'rejected' | 'revised' | 'promoted'
export type Phase2MaturityCapabilityState = 'complete' | 'guarded' | 'beta'
export type Phase2MaturitySignalTone = 'success' | 'warning' | 'danger' | 'neutral'
export type Phase2ClosedLoopRunStatus = 'completed' | 'needs_review' | 'blocked' | 'failed'
export type Phase2ClosedLoopMode = 'observe' | 'apply_approved'
export type Phase2KnowledgePromotionType = 'learning_overlay' | 'scenario_contract' | 'healing_policy'
export type Phase2KnowledgePromotionStatus = 'requires_review' | 'approved' | 'materialized' | 'blocked' | 'rejected'
export type Phase2KnowledgePromotionNextAction = 'approve' | 'apply' | 'promote' | 'review' | 'none'
export type Phase2KnowledgePromotionPriority = 'critical' | 'high' | 'normal' | 'low'
export type Phase2KnowledgePromotionEventAction = 'approve' | 'apply' | 'promote'
export type Phase2KnowledgePromotionEventStatus = 'completed' | 'blocked' | 'failed'
export type Phase2KnowledgePromotionPostVerificationStatus = 'passed' | 'warning' | 'failed'
export type Phase2IndependentAuditReviewStatus = 'reviewed'
export type Phase2L5LearningSignalSourceType = 'independent_audit_review' | 'knowledge_promotion' | 'closed_loop_replay'
export type Phase2L5LearningSignalType = 'audit_reviewed' | 'promotion_verified' | 'replay_verified'
export type Phase2L5LearningSignalStatus = 'retained' | 'superseded'

export interface Phase2ClosedLoopLifecycleEvent {
  type: string
  timestamp: string
  loop?: string
  scenarioId?: string
  status?: string
  reason?: string
  details?: Record<string, unknown>
}

export interface Phase2ExecutionPreviewTarget {
  role?: string
  repo?: string
  ref?: string
  sha?: string
  url?: string
}

export interface Phase2ExecutionContext {
  source?: 'pr_preview' | 'branch_local' | 'staging' | 'production' | 'custom'
  branchName?: string
  prNumber?: number
  targetBaseUrl?: string
  targetRepoPath?: string
  previewTargets?: Phase2ExecutionPreviewTarget[]
  notes?: string[]
}

export interface Phase2ClosedLoopRunMetadata extends Record<string, unknown> {
  lifecycle?: Phase2ClosedLoopLifecycleEvent[]
  executionContext?: Phase2ExecutionContext
}

export interface Phase2MaturityCapability {
  id: string
  label: string
  state: Phase2MaturityCapabilityState
  evidence: string
}

export interface Phase2MaturitySignal {
  label: string
  value: number | string
  tone: Phase2MaturitySignalTone
}

export interface Phase2MaturityLevel {
  level: 'L4' | 'L5'
  status: 'ready' | 'stable' | 'attention' | 'controlled_beta' | 'operational'
  completion: number
  verdict: string
  summary: string
  capabilities: Phase2MaturityCapability[]
  signals: Phase2MaturitySignal[]
}

export interface Phase2MaturityStatus {
  generatedAt: string
  releaseGate: 'ready' | 'attention'
  levels: {
    l4: Phase2MaturityLevel
    l5: Phase2MaturityLevel
  }
}

export type Phase2DomainDiscoveryCandidateStatus = 'draft' | 'runnable_candidate' | 'restricted' | 'needs_human_mapping'

export interface Phase2DomainDiscoveryEvidenceRef {
  evidenceId: string
  kind?: string
}

export interface Phase2DomainDiscoveryBaseCandidate {
  confidence: number
  status: Phase2DomainDiscoveryCandidateStatus
  evidenceRefs: Phase2DomainDiscoveryEvidenceRef[]
  risks?: unknown[]
}

export interface Phase2DomainDiscoveryPersona extends Phase2DomainDiscoveryBaseCandidate {
  id: string
  title: string
  rationale: string
  goals: string[]
  allowedCapabilityIds: string[]
}

export interface Phase2DomainDiscoveryScenario extends Phase2DomainDiscoveryBaseCandidate {
  id: string
  title: string
  rationale: string
  participatingPersonaIds: string[]
  requiredCapabilityIds: string[]
  steps: unknown[]
}

export interface Phase2DomainDiscoveryCapability extends Phase2DomainDiscoveryBaseCandidate {
  id: string
  title: string
  purpose: string
  kind: string
  mappedSurfaceIds: string[]
  selectorHints: string[]
}

export interface Phase2DomainDiscoveryBundle {
  surfaceMap: {
    targetId: string
    routes: unknown[]
    components: unknown[]
    forms: unknown[]
    buttons: unknown[]
    texts: unknown[]
    navigation: unknown[]
    packages: unknown[]
    frameworks: unknown[]
    tests: unknown[]
  }
  domain: Phase2DomainDiscoveryBaseCandidate & {
    domain: string
    label?: string
    summary: string
    entities: unknown[]
  }
  personas: Phase2DomainDiscoveryPersona[]
  scenarios: Phase2DomainDiscoveryScenario[]
  capabilities: Phase2DomainDiscoveryCapability[]
  audit?: Phase2DomainDiscoveryBaseCandidate & {
    id: string
    summary: string
    findings: Array<{
      id: string
      severity: string
      message: string
      candidateIds: string[]
      evidenceRefs: Phase2DomainDiscoveryEvidenceRef[]
    }>
    downgradedCandidateIds: string[]
  }
}

export interface Phase2DomainDiscoveryResponse {
  available: boolean
  filePath: string | null
  summary: {
    domain: string
    label: string
    confidence: number
    status: Phase2DomainDiscoveryCandidateStatus
    targetId: string
    personas: number
    scenarios: number
    capabilities: number
    evidenceItems: number
    auditStatus: Phase2DomainDiscoveryCandidateStatus | null
    auditFindings: number
    mappingRequired: number
  } | null
  bundle: Phase2DomainDiscoveryBundle | null
}

export interface Phase2DomainDiscoveryScenarioDraftResponse {
  draft: Phase2ScenarioDraft
  source: {
    domain: string
    targetId: string
    scenarioId: string
    status: Phase2DomainDiscoveryCandidateStatus
    confidence: number
    mappingRequired: boolean
  }
  warnings: string[]
}

export interface Phase2CodeGraphNode {
  id: string
  type: string
  label: string
  status?: string
  confidence?: number
  source?: {
    filePath: string
    line?: number
    column?: number
    endLine?: number
  }
  metadata: Record<string, unknown>
}

export interface Phase2CodeGraphEdge {
  id: string
  from: string
  to: string
  type: string
  label?: string
  confidence?: number
  metadata: Record<string, unknown>
}

export interface Phase2CodeGraphResponse {
  available: boolean
  filePath: string | null
  summary: {
    targetId: string
    repositoryKind: string
    generatedAt: string
    nodeCount: number
    edgeCount: number
    evidenceNodeCount: number
    candidateNodeCount: number
    endpointCount: number
    httpCallCount: number
    linkedHttpCallCount: number
    capabilitySupportEdgeCount: number
    mappedCapabilityCount: number
    unmappedCapabilityCount: number
    fullyMappedScenarioCount: number
    partiallyMappedScenarioCount: number
    unmappedScenarioCount: number
    nodeTypes: Record<string, number>
    edgeTypes: Record<string, number>
    endpoints: Array<{
      id: string
      label: string
      source: Phase2CodeGraphNode['source'] | null
      method: string | null
      path: string | null
    }>
    httpCalls: Array<{
      id: string
      label: string
      source: Phase2CodeGraphNode['source'] | null
      method: string | null
      url: string | null
      normalizedPath: string | null
    }>
    capabilityMappings: Array<{
      id: string
      capabilityId: string
      label: string
      status: string | null
      mappingStatus: string
      confidence: number
      sourceCount: number
      sources: Array<{
        id: string
        type: string
        label: string
        source: Phase2CodeGraphNode['source'] | null
      }>
    }>
    scenarioReadiness: Array<{
      id: string
      type: string
      label: string
      status: string | null
      readinessStatus: string
      confidence: number
      requiredCapabilityCount: number
      mappedCapabilityCount: number
      missingCapabilityIds: string[]
      supportSourceTypes: string[]
    }>
  } | null
  graph: {
    schemaVersion: 'code-graph/v1'
    targetId: string
    repositoryKind: string
    generatedAt: string
    nodes: Phase2CodeGraphNode[]
    edges: Phase2CodeGraphEdge[]
    stats: {
      nodeCount: number
      edgeCount: number
      evidenceNodeCount: number
      candidateNodeCount: number
    }
  } | null
}

export interface Phase2LearningProposal {
  id: string
  recommendationId: string
  scenarioId: string
  stepId: string
  agentId?: string
  type: string
  severity: string
  status: Phase2LearningProposalStatus
  recommendation: Record<string, unknown>
  patchKind: Phase2LearningProposalPatchKind
  target?: string
  patchContent?: string
  metadata?: Record<string, unknown>
  createdAt: string
  approvedAt?: string
  appliedAt?: string
  rejectedAt?: string
}

export interface Phase2HealingAction {
  id: string
  type: string
  target: string
  reason: string
  automatic: boolean
  status: Phase2HealingActionStatus
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface Phase2GovernanceDecision {
  id: string
  subjectType: Phase2GovernanceSubjectType
  subjectId: string
  action: Phase2GovernanceAction
  verdict: Phase2GovernanceVerdict
  reason: string
  actor?: string
  requirements?: string[]
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface Phase2ScenarioDraft {
  id: string
  scenarioId: string
  name: string
  description?: string
  contract: Record<string, unknown>
  gapType: string
  gapEvidence?: unknown[]
  status: Phase2ScenarioDraftStatus
  reviewedBy?: string
  reviewedAt?: string
  createdAt: string
  updatedAt: string
}

export interface Phase2ScenarioDraftGraphReadiness {
  status: string
  confidence: number
  requiredCapabilityCount: number
  mappedCapabilityCount: number
  mappedCapabilityIds: string[]
  missingCapabilityIds: string[]
  supportSourceTypes: string[]
  supportEndpointCount: number
  supportHandlerCount: number
  supportHttpCallCount: number
  supportDataAccessCount: number
}

export interface Phase2ScenarioDraftMappingReview {
  selectorsMapped: boolean
  authMapped: boolean
  testDataMapped: boolean
  assertionsMapped: boolean
  reviewedBy: string | null
  reviewedAt: string | null
  notes: string | null
}

export interface Phase2ScenarioDraftMappingReviewResponse {
  draft: Phase2ScenarioDraft
  mappingReview: Phase2ScenarioDraftMappingReview
  complete: boolean
}

export interface Phase2ScenarioDraftPromotionResponse extends Phase2ScenarioDraft {
  materialization: Phase2L5Materialization
  runnableScenarioRegistry: Phase2L5Materialization
}

export type Phase2ScenarioDraftPromotionRequirementStatus = 'passed' | 'blocked' | 'warning' | 'not_applicable'

export interface Phase2ScenarioDraftPromotionRequirement {
  id: string
  label: string
  status: Phase2ScenarioDraftPromotionRequirementStatus
  blocking: boolean
  detail: string
  evidence?: Record<string, unknown>
}

export interface Phase2ScenarioDraftPromotionActionReadiness {
  action: 'approve' | 'promote'
  allowed: boolean
  verdict: Phase2GovernanceVerdict
  reason: string
  requirements: string[]
}

export type Phase2ScenarioDraftPromotionRecommendationAction = 'review' | 'approve' | 'promote' | 'none'
export type Phase2ScenarioDraftPromotionRecommendationPriority = 'critical' | 'high' | 'normal' | 'low'

export interface Phase2ScenarioDraftPromotionRecommendation {
  priority: Phase2ScenarioDraftPromotionRecommendationPriority
  action: Phase2ScenarioDraftPromotionRecommendationAction
  structurallyPromotable: boolean
  summary: string
}

export interface Phase2ScenarioDraftPromotionReadiness {
  draftId: string
  scenarioId: string
  status: Phase2ScenarioDraftStatus
  actor: string
  readyForApproval: boolean
  readyForPromotion: boolean
  graphReadiness: Phase2ScenarioDraftGraphReadiness | null
  mappingReview: Phase2ScenarioDraftMappingReview | null
  requirements: Phase2ScenarioDraftPromotionRequirement[]
  actions: {
    approve: Phase2ScenarioDraftPromotionActionReadiness
    promote: Phase2ScenarioDraftPromotionActionReadiness
  }
  recommendation: Phase2ScenarioDraftPromotionRecommendation
  nextSteps: string[]
}

export interface Phase2ClosedLoopRun {
  id: string
  status: Phase2ClosedLoopRunStatus
  mode: Phase2ClosedLoopMode
  scenarioId?: string
  queuedScenarios: string[]
  actions: Array<Record<string, unknown>>
  verification: Record<string, unknown>
  summary: Record<string, unknown>
  metadata?: Phase2ClosedLoopRunMetadata
  startedAt: string
  completedAt: string
}

export interface Phase2IndependentAuditReview {
  id: string
  runId: string
  status: Phase2IndependentAuditReviewStatus
  actor?: string
  reason?: string
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface Phase2IndependentAuditReviewQueueItem {
  runId: string
  status: Phase2ClosedLoopRunStatus
  scenarioId?: string
  verdict: 'failed' | 'warning'
  checkedAt?: string
  findingCount: number
  auditedSessions: number
  statusReason?: string
  completedAt: string
}

export interface Phase2IndependentAuditReviewResult {
  review: Phase2IndependentAuditReview
  run: Phase2ClosedLoopRun
  guards: Phase2ClosedLoopStatusResponse['guards']
}

export interface Phase2L5LearningSignal {
  id: string
  sourceType: Phase2L5LearningSignalSourceType
  sourceId: string
  signalType: Phase2L5LearningSignalType
  sourceRunId?: string
  subjectType?: Phase2GovernanceSubjectType
  subjectId?: string
  scenarioId?: string
  stepId?: string
  agentId?: string
  version: string
  confidence: number
  status: Phase2L5LearningSignalStatus
  summary: string
  evidence?: Record<string, unknown>
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface Phase2L5LearningSignalSummary {
  total: number
  retained: number
  superseded: number
  bySignalType: Record<string, number>
  bySourceType: Record<string, number>
  latestSignals: Phase2L5LearningSignal[]
}

export interface Phase2L5Materialization {
  id: string
  subjectType: Phase2GovernanceSubjectType
  subjectId: string
  kind: string
  status: 'active' | 'rolled_back'
  filePath: string
  checksum: string
  metadata?: Record<string, unknown>
  createdAt: string
  rolledBackAt?: string
}

export interface Phase2KnowledgePromotionCandidate {
  id: string
  sourceRunId: string
  subjectType: Phase2GovernanceSubjectType
  subjectId: string
  promotionType: Phase2KnowledgePromotionType
  status: Phase2KnowledgePromotionStatus
  version: string
  title: string
  target: string
  reason: string
  priority: Phase2KnowledgePromotionPriority
  approvalRequired: boolean
  materializationReady: boolean
  nextAction: Phase2KnowledgePromotionNextAction
  evidence: Record<string, unknown>
}

export interface Phase2KnowledgePromotionEvent {
  id: string
  sourceRunId: string
  candidateId: string
  candidateVersion: string
  subjectType: Phase2GovernanceSubjectType
  subjectId: string
  promotionType: string
  action: Phase2KnowledgePromotionEventAction
  status: Phase2KnowledgePromotionEventStatus
  actor?: string
  reason?: string
  target?: string
  result?: Record<string, unknown> & {
    postPromotionVerification?: Phase2KnowledgePromotionPostVerification
  }
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface Phase2KnowledgePromotionPostVerification {
  status: Phase2KnowledgePromotionPostVerificationStatus
  checkedAt: string
  subjectType: Phase2GovernanceSubjectType
  subjectId: string
  action: Phase2KnowledgePromotionEventAction
  checks: Array<{
    id: string
    status: Phase2KnowledgePromotionPostVerificationStatus
    detail: string
    evidence?: Record<string, unknown>
  }>
  recommendation: string
}

export interface Phase2KnowledgePromotionActionResult {
  candidate: Phase2KnowledgePromotionCandidate
  event: Phase2KnowledgePromotionEvent
  result: Record<string, unknown> & {
    postPromotionVerification?: Phase2KnowledgePromotionPostVerification
  }
}

export interface Phase2ClosedLoopStatusResponse {
  generatedAt: string
  guards: Array<{
    loop: string
    status: 'open' | 'blocked'
    reason: string
    current: number
    limit: number
  }>
  queue: Array<{
    scenarioId: string
    priority: 'critical' | 'high' | 'normal' | 'low'
    reason: string
    suggestedFrequency: 'every_commit' | 'daily' | 'weekly' | 'on_demand'
    lastRunAt: string | null
    riskScore: number
    baseRiskScore: number
    l5SignalPolicy: {
      retainedSignals: number
      decayedSignals: number
      averageEffectiveConfidence: number
      riskModifier: number
      requiresReplay: boolean
      requiresIndependentAudit: boolean
      signalIds: string[]
      signalImpacts: Array<{
        signalId: string
        signalType: Phase2L5LearningSignalType
        ageDays: number
        decayFactor: number
        confidence: number
        effectiveConfidence: number
        riskContribution: number
      }>
      reasons: string[]
    }
    queueId: string
    position: number
    status: 'queued' | 'blocked'
  }>
  learningSignals: Phase2L5LearningSignalSummary
  latestRun: Phase2ClosedLoopRun | null
  recentRuns: Phase2ClosedLoopRun[]
}

export interface Phase2ClosedLoopSchedulerStatus {
  enabled: boolean
  running: boolean
  intervalMs: number
  minIntervalMs: number
  maxConsecutiveFailures: number
  nextTickAt: string | null
  startedAt: string | null
  stoppedAt: string | null
  lastTickStartedAt: string | null
  lastTickCompletedAt: string | null
  tickCount: number
  failureCount: number
  consecutiveFailures: number
  lastRunId: string | null
  lastError: string | null
  options: {
    scenarioId?: string
    maxScenarios: number
    applyApprovedChanges: boolean
    generateScenarioDrafts: boolean
    maxApprovedApplies: number
    actor: string
    executionContext?: Phase2ExecutionContext
  }
}

export interface Phase2ClosedLoopSchedulerTickResult {
  status: 'executed' | 'skipped' | 'failed'
  reason?: string
  error?: string
  run?: Phase2ClosedLoopRun
  scheduler: Phase2ClosedLoopSchedulerStatus
}

export interface Phase2ClosedLoopAuditBundle {
  schemaVersion: 'persona-qa.l5.audit-bundle.v1'
  generatedAt: string
  run: Phase2ClosedLoopRun
  lifecycle: unknown[]
  guards: Phase2ClosedLoopStatusResponse['guards']
  snapshots: {
    before: Record<string, unknown>
    after: Record<string, unknown>
  }
  related: {
    learningProposals: Phase2LearningProposal[]
    healingActions: Phase2HealingAction[]
    scenarioDrafts: Phase2ScenarioDraft[]
    materializations: Phase2L5Materialization[]
    governanceDecisions: Phase2GovernanceDecision[]
  }
  replay: {
    endpoint: '/api/p2/closed-loop/run'
    method: 'POST'
    safeReplayPayload: {
      scenarioId?: string
      maxScenarios: number
      applyApprovedChanges: false
      generateScenarioDrafts: false
    }
    originalIntent: {
      mode: Phase2ClosedLoopMode
      scenarioId?: string
      maxScenarios: number
      applyApprovedChanges: boolean
      generateScenarioDrafts: boolean
    }
    notes: string[]
  }
  promotion: {
    candidates: Phase2KnowledgePromotionCandidate[]
    notes: string[]
  }
  integrity: {
    checksum: string
    counts: Record<string, number>
  }
}

export const api = {
  getRuns: () => fetchJSON(`${API_BASE}/api/runs`),
  getRun: (id: number) => fetchJSON(`${API_BASE}/api/runs/${id}`),
  triggerRun: (scenarioId?: string) =>
    fetchJSON(`${API_BASE}/api/runs`, {
      method: 'POST',
      body: JSON.stringify({ scenario_id: scenarioId }),
    }),
  getScenarios: () => fetchJSON(`${API_BASE}/api/scenarios`),
  getScenario: (id: string) => fetchJSON(`${API_BASE}/api/scenarios/${id}`),
  getFindings: (params?: Record<string, string>) =>
    fetchJSON(`${API_BASE}/api/findings?${new URLSearchParams(params)}`),
  getStatus: () => fetchJSON<DashboardStatus>(`${API_BASE}/api/status`),
  getStats: () => fetchJSON<DashboardStats>(`${API_BASE}/api/stats`),
  getPersonas: () => fetchJSON(`${API_BASE}/api/personas`),
  createPersona: (data: CreatePersonaPayload) =>
    fetchJSON(`${API_BASE}/api/personas`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getInsights: () => fetchJSON(`${API_BASE}/api/insights`),
  getFindingScreenshotUrl: (id: number) => `${API_BASE}/api/findings/${id}/screenshot`,
  getRuntimeSettings: () => fetchJSON<RuntimeSettingsResponse>(`${API_BASE}/api/settings/runtime`),
  updateRuntimeSettings: (data: { provider: 'anthropic' | 'openai' }) =>
    fetchJSON<RuntimeSettingsResponse>(`${API_BASE}/api/settings/runtime`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  getPhase2Sessions: () => fetchJSON<Phase2SessionSummary[]>(`${API_BASE}/api/p2/sessions`),
  getPhase2Scenarios: () => fetchJSON<Phase2ScenarioSummary[]>(`${API_BASE}/api/p2/scenarios`),
  getPhase2ScenarioWorkflowContract: (id: string) =>
    fetchJSON<Phase2WorkflowContractResponse>(`${API_BASE}/api/p2/scenarios/${id}/workflow-contract`),
  getPhase2Session: (id: string) => fetchJSON<Phase2SessionDetail>(`${API_BASE}/api/p2/sessions/${id}`),
  getPhase2SessionEvents: (id: string) => fetchJSON<Phase2SessionEvent[]>(`${API_BASE}/api/p2/sessions/${id}/events`),
  getPhase2SessionFindings: (id: string) => fetchJSON<Phase2SessionFinding[]>(`${API_BASE}/api/p2/sessions/${id}/findings`),
  getPhase2SessionArtifacts: (id: string) => fetchJSON<Phase2SessionArtifact[]>(`${API_BASE}/api/p2/sessions/${id}/artifacts`),
  getPhase2ArtifactContentUrl: (artifactId: string) => `${API_BASE}/api/p2/artifacts/${artifactId}/content`,
  getPhase2SessionWsUrl: (sessionId: string) => `${wsBase()}/ws/p2/sessions/${sessionId}`,
  getPhase2Maturity: () => fetchJSON<Phase2MaturityStatus>(`${API_BASE}/api/p2/maturity`),
  getPhase2DomainDiscovery: () =>
    fetchJSON<Phase2DomainDiscoveryResponse>(`${API_BASE}/api/p2/domain-discovery`),
  getPhase2CodeGraph: () =>
    fetchJSON<Phase2CodeGraphResponse>(`${API_BASE}/api/p2/code-graph`),
  createPhase2DomainDiscoveryScenarioDraft: (scenarioId: string) =>
    fetchJSON<Phase2DomainDiscoveryScenarioDraftResponse>(
      `${API_BASE}/api/p2/domain-discovery/scenarios/${encodeURIComponent(scenarioId)}/drafts`,
      { method: 'POST' },
    ),
  getPhase2ClosedLoopStatus: () =>
    fetchJSON<Phase2ClosedLoopStatusResponse>(`${API_BASE}/api/p2/closed-loop/status`),
  getPhase2ClosedLoopAuditBundleUrl: (runId: string) =>
    `${API_BASE}/api/p2/closed-loop/runs/${encodeURIComponent(runId)}/audit-bundle`,
  getPhase2ClosedLoopAuditBundle: (runId: string) =>
    fetchJSON<Phase2ClosedLoopAuditBundle>(`${API_BASE}/api/p2/closed-loop/runs/${encodeURIComponent(runId)}/audit-bundle`),
  getPhase2IndependentAuditReviews: (params?: {
    runId?: string
    limit?: number
  }) =>
    fetchJSON<Phase2IndependentAuditReview[]>(`${API_BASE}/api/p2/closed-loop/audit-reviews?${new URLSearchParams(compactParams({
      runId: params?.runId,
      limit: params?.limit ? String(params.limit) : undefined,
    }))}`),
  getPhase2IndependentAuditReviewQueue: (params?: { limit?: number }) =>
    fetchJSON<Phase2IndependentAuditReviewQueueItem[]>(`${API_BASE}/api/p2/closed-loop/audit-review-queue?${new URLSearchParams(compactParams({
      limit: params?.limit ? String(params.limit) : undefined,
    }))}`),
  getPhase2L5LearningSignals: (params?: {
    sourceRunId?: string
    subjectType?: Phase2GovernanceSubjectType
    subjectId?: string
    scenarioId?: string
    stepId?: string
    agentId?: string
    signalType?: Phase2L5LearningSignalType
    status?: Phase2L5LearningSignalStatus
    limit?: number
  }) =>
    fetchJSON<Phase2L5LearningSignal[]>(`${API_BASE}/api/p2/learning/signals?${new URLSearchParams(compactParams({
      sourceRunId: params?.sourceRunId,
      subjectType: params?.subjectType,
      subjectId: params?.subjectId,
      scenarioId: params?.scenarioId,
      stepId: params?.stepId,
      agentId: params?.agentId,
      signalType: params?.signalType,
      status: params?.status,
      limit: params?.limit ? String(params.limit) : undefined,
    }))}`),
  getPhase2L5LearningSignalSummary: (params?: { scenarioId?: string; limit?: number }) =>
    fetchJSON<Phase2L5LearningSignalSummary>(`${API_BASE}/api/p2/learning/signals/summary?${new URLSearchParams(compactParams({
      scenarioId: params?.scenarioId,
      limit: params?.limit ? String(params.limit) : undefined,
    }))}`),
  reviewPhase2IndependentAudit: (runId: string, payload?: { actor?: string; reason?: string }) =>
    fetchJSON<Phase2IndependentAuditReviewResult>(
      `${API_BASE}/api/p2/closed-loop/runs/${encodeURIComponent(runId)}/independent-audit/review`,
      {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
      },
    ),
  runPhase2ClosedLoop: (payload: {
    scenarioId?: string
    maxScenarios?: number
    applyApprovedChanges?: boolean
    generateScenarioDrafts?: boolean
    executionContext?: Phase2ExecutionContext
  }) =>
    fetchJSON<Phase2ClosedLoopRun>(`${API_BASE}/api/p2/closed-loop/run`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getPhase2ClosedLoopSchedulerStatus: () =>
    fetchJSON<Phase2ClosedLoopSchedulerStatus>(`${API_BASE}/api/p2/closed-loop/scheduler`),
  startPhase2ClosedLoopScheduler: (payload: {
    scenarioId?: string
    maxScenarios?: number
    applyApprovedChanges?: boolean
    generateScenarioDrafts?: boolean
    maxApprovedApplies?: number
    executionContext?: Phase2ExecutionContext
    intervalMs?: number
    runImmediately?: boolean
  }) =>
    fetchJSON<Phase2ClosedLoopSchedulerStatus>(`${API_BASE}/api/p2/closed-loop/scheduler/start`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  stopPhase2ClosedLoopScheduler: () =>
    fetchJSON<Phase2ClosedLoopSchedulerStatus>(`${API_BASE}/api/p2/closed-loop/scheduler/stop`, {
      method: 'POST',
    }),
  tickPhase2ClosedLoopScheduler: (payload: {
    scenarioId?: string
    maxScenarios?: number
    applyApprovedChanges?: boolean
    generateScenarioDrafts?: boolean
    executionContext?: Phase2ExecutionContext
  }) =>
    fetchJSON<Phase2ClosedLoopSchedulerTickResult>(`${API_BASE}/api/p2/closed-loop/scheduler/tick`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getPhase2HealingLog: (limit = 100) =>
    fetchJSON<Phase2HealingAction[]>(`${API_BASE}/api/p2/healing/log?${new URLSearchParams({ limit: String(limit) })}`),
  evaluatePhase2Healing: () =>
    fetchJSON<Phase2HealingAction[]>(`${API_BASE}/api/p2/healing/evaluate`, { method: 'POST' }),
  applyPhase2HealingAction: (id: string, payload?: { actor?: string }) =>
    fetchJSON<Phase2HealingAction>(`${API_BASE}/api/p2/healing/actions/${id}/apply`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }),
  rollbackPhase2HealingAction: (id: string, payload?: { actor?: string }) =>
    fetchJSON<Phase2HealingAction>(`${API_BASE}/api/p2/healing/actions/${id}/rollback`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }),
  getPhase2LearningProposals: (params?: {
    scenarioId?: string
    status?: Phase2LearningProposalStatus
    limit?: number
  }) =>
    fetchJSON<Phase2LearningProposal[]>(`${API_BASE}/api/p2/learning/proposals?${new URLSearchParams(compactParams({
      scenarioId: params?.scenarioId,
      status: params?.status,
      limit: params?.limit ? String(params.limit) : undefined,
    }))}`),
  getPhase2GovernanceDecisions: (params?: {
    subjectType?: Phase2GovernanceSubjectType
    subjectId?: string
    limit?: number
  }) =>
    fetchJSON<Phase2GovernanceDecision[]>(`${API_BASE}/api/p2/governance/decisions?${new URLSearchParams(compactParams({
      subjectType: params?.subjectType,
      subjectId: params?.subjectId,
      limit: params?.limit ? String(params.limit) : undefined,
    }))}`),
  getPhase2KnowledgePromotionEvents: (params?: {
    sourceRunId?: string
    subjectType?: Phase2GovernanceSubjectType
    subjectId?: string
    limit?: number
  }) =>
    fetchJSON<Phase2KnowledgePromotionEvent[]>(`${API_BASE}/api/p2/knowledge/promotions/events?${new URLSearchParams(compactParams({
      sourceRunId: params?.sourceRunId,
      subjectType: params?.subjectType,
      subjectId: params?.subjectId,
      limit: params?.limit ? String(params.limit) : undefined,
    }))}`),
  runPhase2KnowledgePromotionAction: (candidate: Phase2KnowledgePromotionCandidate, payload?: { actor?: string }) =>
    fetchJSON<Phase2KnowledgePromotionActionResult>(`${API_BASE}/api/p2/knowledge/promotions/actions`, {
      method: 'POST',
      body: JSON.stringify({
        candidate,
        actor: payload?.actor,
      }),
    }),
  getPhase2ScenarioDrafts: (params?: {
    status?: Phase2ScenarioDraftStatus
    limit?: number
  }) =>
    fetchJSON<Phase2ScenarioDraft[]>(`${API_BASE}/api/p2/scenarios/drafts?${new URLSearchParams(compactParams({
      status: params?.status,
      limit: params?.limit ? String(params.limit) : undefined,
    }))}`),
  getPhase2ScenarioDraftPromotionReadiness: (id: string, params?: { actor?: string }) =>
    fetchJSON<Phase2ScenarioDraftPromotionReadiness>(`${API_BASE}/api/p2/scenarios/drafts/${id}/promotion-readiness?${new URLSearchParams(compactParams({
      actor: params?.actor,
    }))}`),
  approvePhase2LearningProposal: (id: string) =>
    fetchJSON<Phase2LearningProposal>(`${API_BASE}/api/p2/learning/proposals/${id}/approve`, { method: 'POST' }),
  applyPhase2LearningProposal: (id: string) =>
    fetchJSON<Phase2LearningProposal>(`${API_BASE}/api/p2/learning/proposals/${id}/apply`, { method: 'POST' }),
  rejectPhase2LearningProposal: (id: string) =>
    fetchJSON<Phase2LearningProposal>(`${API_BASE}/api/p2/learning/proposals/${id}/reject`, { method: 'POST' }),
  updatePhase2ScenarioDraft: (id: string, payload: {
    status: Phase2ScenarioDraftStatus
    reviewedBy?: string
  }) =>
    fetchJSON<Phase2ScenarioDraft>(`${API_BASE}/api/p2/scenarios/drafts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  updatePhase2ScenarioDraftMappingReview: (id: string, payload: {
    selectorsMapped?: boolean
    authMapped?: boolean
    testDataMapped?: boolean
    assertionsMapped?: boolean
    reviewedBy: string
    notes?: string
  }) =>
    fetchJSON<Phase2ScenarioDraftMappingReviewResponse>(`${API_BASE}/api/p2/scenarios/drafts/${id}/mapping-review`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  promotePhase2ScenarioDraft: (id: string, payload?: { reviewedBy?: string }) =>
    fetchJSON<Phase2ScenarioDraftPromotionResponse>(`${API_BASE}/api/p2/scenarios/drafts/${id}/promote`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }),
  startPhase2Run: (payload: {
    scenario_id: string
    seed_artifacts?: Record<string, string>
    execution_context?: Phase2ExecutionContext
  }) =>
    fetchJSON<{
      session_id: string
      scenario_id: string
      status: string
      started_at: string
      execution_context?: Phase2ExecutionContext
    }>(`${API_BASE}/api/p2/runs`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
}

function compactParams(params: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}
