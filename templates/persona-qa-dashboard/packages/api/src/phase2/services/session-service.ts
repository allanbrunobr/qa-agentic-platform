import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  Session,
  SessionArtifact,
  SessionEvent,
  SessionEventType,
  SessionFinding,
  SessionStatus,
} from '../types/session-types.js'
import type {
  AdaptationType,
  FailureCategory,
  StepExecutionStatus,
} from '../types/scenario-types.js'
import { diagnoseFailureMessage } from './failure-diagnosis-service.js'
import { applyMigrations, baselineMigration } from '../../db/migrations.js'

const DEFAULT_PHASE2_ARTIFACT_DIR = process.env['PHASE2_ARTIFACT_DIR'] ?? path.resolve(process.cwd(), 'artifacts')

export function resolvePhase2ArtifactPath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(DEFAULT_PHASE2_ARTIFACT_DIR, filePath)
}

type SessionRow = {
  session_id: string
  run_id: number | null
  scenario_id: string
  status: SessionStatus
  created_at: string
  started_at: string | null
  completed_at: string | null
}

type EventRow = {
  id: number
  session_id: string
  sequence: number
  type: SessionEventType
  timestamp: string
  agent_role: string | null
  data: string | null
}

type ArtifactRow = {
  id: number
  session_id: string
  artifact_key: string
  artifact_type: string | null
  agent_role: string | null
  description: string | null
  file_path: string | null
  content: string | null
  metadata: string | null
  payload: string | null
  created_at: string
}

type FindingRow = {
  id: number
  session_id: string
  severity: string | null
  title: string | null
  description: string | null
  evidence: string | null
  agent_id: string | null
  step_id: string | null
  created_at: string
}

type CheckpointRow = {
  last_completed_step: number
  cursor: number
}

export interface StepPerformanceInput {
  sessionId: string
  scenarioId: string
  stepId: string
  agentId: string
  status: StepExecutionStatus
  success: boolean
  attempt: number
  durationMs: number
  errorCategory?: FailureCategory
  errorMessage?: string
  startedAt?: string
  completedAt?: string
  metadata?: Record<string, unknown>
}

export interface StepPerformanceRecord extends StepPerformanceInput {
  id: number
  createdAt: string
}

export interface StepHistoryStats {
  scenarioId: string
  stepId: string
  totalExecutions: number
  successRate: number
  averageDurationMs: number
  p95DurationMs: number
  retryRecoveryRate: number
  failureBreakdown: Record<string, number>
  recentExecutions: StepPerformanceRecord[]
}

export interface AdaptationEventInput {
  sessionId?: string
  scenarioId: string
  stepId?: string
  type: AdaptationType
  previousValue?: unknown
  newValue?: unknown
  reason: string
  confidence: number
  outcome?: string
  metadata?: Record<string, unknown>
}

export interface AdaptationEvent extends AdaptationEventInput {
  id: number
  timestamp: string
}

export type LearningProposalStatus = 'proposed' | 'approved' | 'applied' | 'rejected'
export type LearningProposalPatchKind = 'none' | 'prompt_overlay' | 'capability_patch' | 'environment_check'
export type ScenarioDraftStatus = 'pending' | 'approved' | 'rejected' | 'revised' | 'promoted'
export type HealingActionStatus = 'proposed' | 'applied' | 'blocked' | 'rolled_back'
export type GovernanceSubjectType = 'learning_proposal' | 'scenario_draft' | 'healing_action'
export type GovernanceAction = 'generate' | 'approve' | 'apply' | 'reject' | 'evaluate' | 'rollback' | 'promote'
export type GovernanceVerdict = 'allowed' | 'blocked'
export type SyntheticToolClosureReason = 'timeout' | 'interruption'
export type L5MaterializationSubjectType = 'learning_proposal' | 'scenario_draft' | 'healing_action'
export type L5MaterializationStatus = 'active' | 'rolled_back'
export type L5ClosedLoopStatus = 'completed' | 'needs_review' | 'blocked' | 'failed'
export type L5ClosedLoopMode = 'observe' | 'apply_approved'
export type KnowledgePromotionEventAction = 'approve' | 'apply' | 'promote'
export type KnowledgePromotionEventStatus = 'completed' | 'blocked' | 'failed'
export type L5LearningSignalSourceType = 'independent_audit_review' | 'knowledge_promotion' | 'closed_loop_replay'
export type L5LearningSignalType = 'audit_reviewed' | 'promotion_verified' | 'replay_verified'
export type L5LearningSignalStatus = 'retained' | 'superseded'

export interface LearningProposalInput {
  recommendationId: string
  scenarioId: string
  stepId: string
  agentId?: string
  type: string
  severity: string
  recommendation: Record<string, unknown>
  patchKind: LearningProposalPatchKind
  target?: string
  patchContent?: string
  metadata?: Record<string, unknown>
}

export interface LearningProposal extends LearningProposalInput {
  id: string
  status: LearningProposalStatus
  createdAt: string
  approvedAt?: string
  appliedAt?: string
  rejectedAt?: string
}

export interface ScenarioDraftInput {
  id?: string
  scenarioId: string
  name: string
  description?: string
  contract: Record<string, unknown>
  gapType: string
  gapEvidence?: unknown[]
}

export interface ScenarioDraft extends ScenarioDraftInput {
  id: string
  status: ScenarioDraftStatus
  reviewedBy?: string
  reviewedAt?: string
  createdAt: string
  updatedAt: string
}

export interface HealingActionInput {
  type: string
  target: string
  reason: string
  automatic: boolean
  status: HealingActionStatus
  metadata?: Record<string, unknown>
}

export interface HealingAction extends HealingActionInput {
  id: string
  createdAt: string
}

export interface GovernanceDecisionInput {
  subjectType: GovernanceSubjectType
  subjectId: string
  action: GovernanceAction
  verdict: GovernanceVerdict
  reason: string
  actor?: string
  requirements?: string[]
  metadata?: Record<string, unknown>
}

export interface GovernanceDecision extends GovernanceDecisionInput {
  id: string
  createdAt: string
}

export interface L5MaterializationInput {
  subjectType: L5MaterializationSubjectType
  subjectId: string
  kind: string
  filePath: string
  checksum: string
  metadata?: Record<string, unknown>
}

export interface L5Materialization extends L5MaterializationInput {
  id: string
  status: L5MaterializationStatus
  createdAt: string
  rolledBackAt?: string
}

export interface RuntimeLearningOverlay {
  proposalId: string
  materializationId: string
  scenarioId: string
  stepId: string
  agentId?: string
  target?: string
  patchContent: string
  checksum: string
  filePath: string
  createdAt: string
}

export interface L5ClosedLoopRunInput {
  status: L5ClosedLoopStatus
  mode: L5ClosedLoopMode
  scenarioId?: string
  queuedScenarios: string[]
  actions: Record<string, unknown>[]
  verification: Record<string, unknown>
  summary: Record<string, unknown>
  metadata?: Record<string, unknown>
  startedAt?: string
  completedAt?: string
}

export interface L5ClosedLoopRun extends L5ClosedLoopRunInput {
  id: string
  startedAt: string
  completedAt: string
}

export type L5IndependentAuditReviewStatus = 'reviewed'

export interface L5IndependentAuditReviewInput {
  runId: string
  status: L5IndependentAuditReviewStatus
  actor?: string
  reason?: string
  metadata?: Record<string, unknown>
}

export interface L5IndependentAuditReview extends L5IndependentAuditReviewInput {
  id: string
  createdAt: string
}

export interface L5IndependentAuditReviewQueueItem {
  runId: string
  status: L5ClosedLoopStatus
  scenarioId?: string
  verdict: 'failed' | 'warning'
  checkedAt?: string
  findingCount: number
  auditedSessions: number
  statusReason?: string
  completedAt: string
}

export interface KnowledgePromotionEventInput {
  sourceRunId: string
  candidateId: string
  candidateVersion: string
  subjectType: GovernanceSubjectType
  subjectId: string
  promotionType: string
  action: KnowledgePromotionEventAction
  status: KnowledgePromotionEventStatus
  actor?: string
  reason?: string
  target?: string
  result?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface KnowledgePromotionEvent extends KnowledgePromotionEventInput {
  id: string
  createdAt: string
}

export interface L5LearningSignalInput {
  sourceType: L5LearningSignalSourceType
  sourceId: string
  signalType: L5LearningSignalType
  sourceRunId?: string
  subjectType?: GovernanceSubjectType
  subjectId?: string
  scenarioId?: string
  stepId?: string
  agentId?: string
  version: string
  confidence: number
  summary: string
  evidence?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface L5LearningSignal extends L5LearningSignalInput {
  id: string
  status: L5LearningSignalStatus
  createdAt: string
}

export interface L5LearningSignalSummary {
  total: number
  retained: number
  superseded: number
  bySignalType: Record<string, number>
  bySourceType: Record<string, number>
  latestSignals: L5LearningSignal[]
}

type StepPerformanceRow = {
  id: number
  session_id: string
  scenario_id: string
  step_id: string
  agent_id: string
  status: StepExecutionStatus
  success: number
  attempt: number
  duration_ms: number
  error_category: FailureCategory | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  metadata: string | null
  created_at: string
}

type AdaptationEventRow = {
  id: number
  session_id: string | null
  scenario_id: string
  step_id: string | null
  adaptation_type: AdaptationType
  previous_value: string | null
  new_value: string | null
  reason: string
  confidence: number
  outcome: string | null
  metadata: string | null
  timestamp: string
}

type LearningProposalRow = {
  proposal_id: string
  recommendation_id: string
  scenario_id: string
  step_id: string
  agent_id: string | null
  proposal_type: string
  severity: string
  status: LearningProposalStatus
  recommendation: string
  patch_kind: LearningProposalPatchKind
  target: string | null
  patch_content: string | null
  metadata: string | null
  created_at: string
  approved_at: string | null
  applied_at: string | null
  rejected_at: string | null
}

type ScenarioDraftRow = {
  draft_id: string
  scenario_id: string
  name: string
  description: string | null
  contract_json: string
  gap_type: string
  gap_evidence: string | null
  status: ScenarioDraftStatus
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
  updated_at: string
}

type HealingActionRow = {
  action_id: string
  action_type: string
  target: string
  reason: string
  automatic: number
  status: HealingActionStatus
  metadata: string | null
  created_at: string
}

type GovernanceDecisionRow = {
  decision_id: string
  subject_type: GovernanceSubjectType
  subject_id: string
  action: GovernanceAction
  verdict: GovernanceVerdict
  reason: string
  actor: string | null
  requirements: string | null
  metadata: string | null
  created_at: string
}

type L5MaterializationRow = {
  materialization_id: string
  subject_type: L5MaterializationSubjectType
  subject_id: string
  kind: string
  status: L5MaterializationStatus
  file_path: string
  checksum: string
  metadata: string | null
  created_at: string
  rolled_back_at: string | null
}

type RuntimeLearningOverlayRow = {
  proposal_id: string
  scenario_id: string
  step_id: string
  agent_id: string | null
  target: string | null
  patch_content: string
  materialization_id: string
  file_path: string
  checksum: string
  metadata: string | null
  created_at: string
}

type L5ClosedLoopRunRow = {
  loop_id: string
  status: L5ClosedLoopStatus
  mode: L5ClosedLoopMode
  scenario_id: string | null
  queued_scenarios: string
  actions_json: string
  verification_json: string
  summary_json: string
  metadata: string | null
  started_at: string
  completed_at: string
}

type L5IndependentAuditReviewRow = {
  review_id: string
  run_id: string
  status: L5IndependentAuditReviewStatus
  actor: string | null
  reason: string | null
  metadata: string | null
  created_at: string
}

type KnowledgePromotionEventRow = {
  event_id: string
  source_run_id: string
  candidate_id: string
  candidate_version: string
  subject_type: GovernanceSubjectType
  subject_id: string
  promotion_type: string
  action: KnowledgePromotionEventAction
  status: KnowledgePromotionEventStatus
  actor: string | null
  reason: string | null
  target: string | null
  result_json: string | null
  metadata: string | null
  created_at: string
}

type L5LearningSignalRow = {
  signal_id: string
  source_type: L5LearningSignalSourceType
  source_id: string
  signal_type: L5LearningSignalType
  source_run_id: string | null
  subject_type: GovernanceSubjectType | null
  subject_id: string | null
  scenario_id: string | null
  step_id: string | null
  agent_id: string | null
  version: string
  confidence: number
  status: L5LearningSignalStatus
  summary: string
  evidence: string | null
  metadata: string | null
  created_at: string
}

type ToolClosureRow = {
  session_id: string
  tool_call_id: string
  tool_name: string
  reason: SyntheticToolClosureReason
  closed_at: string
  original_started_at: string
}

function getDefaultDbPath(): string {
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
    return ':memory:'
  }
  return process.env['DATABASE_URL'] ?? './persona-qa.db'
}

export class SessionService {
  private readonly sqlite: Database.Database

  constructor(databasePath = getDefaultDbPath()) {
    this.sqlite = new Database(databasePath)
    this.sqlite.pragma('journal_mode = WAL')
    this.sqlite.pragma('foreign_keys = ON')
    this.ensureTables()
  }

  createSession(scenarioId: string, runId?: number): Session {
    const id = randomUUID()
    const now = new Date().toISOString()

    this.sqlite
      .prepare(
        `INSERT INTO p2_sessions (session_id, run_id, scenario_id, status, created_at, started_at, completed_at)
         VALUES (?, ?, ?, 'pending', ?, ?, NULL)`,
      )
      .run(id, runId ?? null, scenarioId, now, now)

    return this.getSession(id)!
  }

  private ensureSession(sessionId: string): void {
    const existing = this.sqlite
      .prepare(`SELECT session_id FROM p2_sessions WHERE session_id = ?`)
      .get(sessionId) as { session_id: string } | undefined

    if (existing) return

    const now = new Date().toISOString()
    this.sqlite
      .prepare(
        `INSERT INTO p2_sessions (session_id, run_id, scenario_id, status, created_at, started_at, completed_at)
         VALUES (?, NULL, 'stub', 'pending', ?, ?, NULL)`,
      )
      .run(sessionId, now, now)
  }

  getSession(sessionId: string): Session | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT session_id, run_id, scenario_id, status, created_at, started_at, completed_at
         FROM p2_sessions
         WHERE session_id = ?`,
      )
      .get(sessionId) as SessionRow | undefined

    if (!row) return undefined

    const events = this.sqlite
      .prepare(
        `SELECT id, session_id, sequence, type, timestamp, agent_role, data
         FROM p2_session_events
         WHERE session_id = ?
         ORDER BY sequence ASC`,
      )
      .all(sessionId) as EventRow[]

    const artifactRows = this.sqlite
      .prepare(
        `SELECT id, session_id, artifact_key, artifact_type, agent_role, description, file_path, content, metadata, payload, created_at
         FROM p2_session_artifacts
         WHERE session_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId) as ArtifactRow[]

    const findingRows = this.sqlite
      .prepare(
        `SELECT id, session_id, severity, title, description, evidence, agent_id, step_id, created_at
         FROM p2_session_findings
         WHERE session_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId) as FindingRow[]

    const checkpoint = this.sqlite
      .prepare(
        `SELECT last_completed_step, cursor
         FROM p2_session_checkpoints
         WHERE session_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(sessionId) as CheckpointRow | undefined

    const artifacts = Object.fromEntries(
      artifactRows.map((artifact) => {
        const payload = artifact.payload ? parseStoredJson(artifact.payload) : {
          artifactId: String(artifact.id),
          type: artifact.artifact_type,
          description: artifact.description,
          filePath: artifact.file_path,
          content: artifact.content,
          metadata: artifact.metadata ? parseStoredJson(artifact.metadata) : undefined,
        }
        return [artifact.artifact_key, payload]
      }),
    )

    return {
      id: row.session_id,
      runId: row.run_id ?? undefined,
      scenarioId: row.scenario_id,
      status: row.status,
      startedAt: row.started_at ?? row.created_at,
      completedAt: row.completed_at ?? undefined,
      events: events.map((event) => {
        const data = event.data ? parseStoredJson(event.data) as Record<string, unknown> : undefined
        return {
          id: String(event.id),
          sessionId: event.session_id,
          type: event.type,
          agentRole: event.agent_role ?? undefined,
          timestamp: event.timestamp,
          payload: data,
          data,
        }
      }),
      artifacts,
      findings: findingRows.map((finding) => ({
        id: String(finding.id),
        sessionId: finding.session_id,
        agentId: finding.agent_id ?? undefined,
        agentRole: finding.agent_id ?? undefined,
        stepId: finding.step_id ?? undefined,
        severity: (finding.severity ?? 'info') as SessionFinding['severity'],
        title: finding.title ?? 'Untitled',
        description: finding.description ?? undefined,
        evidence: finding.evidence ? parseStoredJson(finding.evidence) : null,
        createdAt: finding.created_at,
        timestamp: finding.created_at,
      })),
      checkpoint: {
        lastCompletedStep: checkpoint?.last_completed_step ?? -1,
        cursor: checkpoint?.cursor ?? 0,
      },
    }
  }

  /**
   * Closes every session still pending or running as failed, with an interruption_recorded event
   * (B-07). Called when the API starts (sessions left by a process that died or was killed) and on
   * graceful shutdown (sessions this process is abandoning). Without it they stayed "running"
   * forever, their verdict stayed contract_evaluating, and the quality gate never counted them.
   * Returns the ids it closed.
   */
  failInterruptedSessions(reason: string): string[] {
    const rows = this.sqlite
      .prepare("SELECT session_id FROM p2_sessions WHERE status IN ('pending', 'running') ORDER BY created_at")
      .all() as Array<{ session_id: string }>
    for (const { session_id: sessionId } of rows) {
      this.addEvent(sessionId, 'interruption_recorded', {
        reason,
        message: `Session interrupted (${reason}) before it finished; it is recorded as failed.`,
      })
      this.updateStatus(sessionId, 'failed')
    }
    return rows.map((row) => row.session_id)
  }

  /**
   * Records an operator reset of a scenario's quality gate (B-01). The gate then ignores sessions
   * that started before the reset, so a restricted scenario can run again to requalify. The reason
   * is kept for audit and never deleted.
   */
  recordQualityGateReset(scenarioId: string, reason: string, previousStatus: string): QualityGateReset {
    const reset: QualityGateReset = {
      id: randomUUID(),
      scenarioId,
      reason,
      previousStatus,
      createdAt: new Date().toISOString(),
    }
    this.sqlite
      .prepare('INSERT INTO p2_quality_gate_resets (id, scenario_id, reason, previous_status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(reset.id, reset.scenarioId, reset.reason, reset.previousStatus, reset.createdAt)
    return reset
  }

  getLatestQualityGateReset(scenarioId: string): QualityGateReset | null {
    const row = this.sqlite
      .prepare('SELECT id, scenario_id, reason, previous_status, created_at FROM p2_quality_gate_resets WHERE scenario_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(scenarioId) as { id: string; scenario_id: string; reason: string; previous_status: string; created_at: string } | undefined
    if (!row) return null
    return { id: row.id, scenarioId: row.scenario_id, reason: row.reason, previousStatus: row.previous_status, createdAt: row.created_at }
  }

  getAllSessions(): Session[] {
    const rows = this.sqlite
      .prepare(`SELECT session_id FROM p2_sessions ORDER BY rowid ASC`)
      .all() as Array<{ session_id: string }>

    return rows
      .map((row) => this.getSession(row.session_id))
      .filter((session): session is Session => session !== undefined)
  }

  /** The sessions of one scenario, through the scenario index; the quality gate needs no others (B-09). */
  getSessionsForScenario(scenarioId: string): Session[] {
    const rows = this.sqlite
      .prepare(`SELECT session_id FROM p2_sessions WHERE scenario_id = ? ORDER BY rowid ASC`)
      .all(scenarioId) as Array<{ session_id: string }>

    return rows
      .map((row) => this.getSession(row.session_id))
      .filter((session): session is Session => session !== undefined)
  }

  updateStatus(sessionId: string, status: SessionStatus): void {
    const session = this.getSession(sessionId)
    if (!session) return

    const now = new Date().toISOString()
    const startedAt = status === 'running' ? session.startedAt ?? now : session.startedAt ?? null
    const completedAt = status === 'complete' || status === 'failed'
      ? (session.completedAt ?? now)
      : null

    this.sqlite
      .prepare(
        `UPDATE p2_sessions
         SET status = ?, started_at = ?, completed_at = ?
         WHERE session_id = ?`,
      )
      .run(status, startedAt, completedAt, sessionId)
  }

  addEvent(sessionId: string, type: SessionEventType, data?: Record<string, unknown>): SessionEvent {
    // ensureSession guarantees the row exists. Reloading the whole session here (every event,
    // artifact and finding) made each append slower as the session grew (B-09).
    this.ensureSession(sessionId)

    const nextSequenceRow = this.sqlite
      .prepare(`SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence FROM p2_session_events WHERE session_id = ?`)
      .get(sessionId) as { next_sequence: number }

    const timestamp = new Date().toISOString()
    const agentRole = typeof data?.['agentRole'] === 'string' ? String(data['agentRole']) : null
    const result = this.sqlite
      .prepare(
        `INSERT INTO p2_session_events (session_id, sequence, type, timestamp, agent_role, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, nextSequenceRow.next_sequence, type, timestamp, agentRole, data ? JSON.stringify(data) : null)

    if (type === 'finding_recorded') {
      this.insertFindingRow(sessionId, {
        severity: typeof data?.['severity'] === 'string' ? String(data['severity']) : 'info',
        title: typeof data?.['title'] === 'string' ? String(data['title']) : 'Untitled',
        description: typeof data?.['description'] === 'string' ? String(data['description']) : null,
        evidence: data?.['evidence'] ?? null,
        agentId: typeof data?.['agentId'] === 'string' ? String(data['agentId']) : agentRole,
        stepId: typeof data?.['stepId'] === 'string' ? String(data['stepId']) : null,
        createdAt: timestamp,
      })
    }

    return {
      id: String(result.lastInsertRowid),
      sessionId,
      type,
      agentRole: agentRole ?? undefined,
      timestamp,
      payload: data,
      data,
    }
  }

  appendEvent(
    sessionId: string,
    event: Omit<SessionEvent, 'id' | 'sessionId' | 'timestamp'>,
  ): SessionEvent {
    const payload = event.payload ?? event.data ?? {}
    let eventType: SessionEventType = event.type

    if (event.type === 'finding') {
      eventType = 'finding_recorded'
    }

    const mergedPayload = {
      ...(payload as Record<string, unknown>),
      ...(event.agentRole ? { agentRole: event.agentRole } : {}),
    }

    return this.addEvent(sessionId, eventType, mergedPayload)
  }

  recordToolClosure(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    reason: SyntheticToolClosureReason,
    originalStartedAt?: string,
  ): boolean {
    this.ensureSession(sessionId)
    const closedAt = new Date().toISOString()
    const startedAt = originalStartedAt ?? closedAt
    const result = this.sqlite
      .prepare(
        `INSERT OR IGNORE INTO p2_tool_ledger_closures (
           session_id, tool_call_id, tool_name, reason, closed_at, original_started_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, toolCallId, toolName, reason, closedAt, startedAt)

    if (result.changes === 0) return false

    this.addEvent(sessionId, 'info', {
      event: 'tool_synthetic_closure',
      toolCallId,
      toolName,
      reason,
      closedAt,
      originalStartedAt: startedAt,
    })

    return true
  }

  isToolCallClosed(sessionId: string, toolCallId: string): boolean {
    const row = this.sqlite
      .prepare(
        `SELECT tool_call_id
         FROM p2_tool_ledger_closures
         WHERE session_id = ? AND tool_call_id = ?
         LIMIT 1`,
      )
      .get(sessionId, toolCallId) as Pick<ToolClosureRow, 'tool_call_id'> | undefined

    return Boolean(row)
  }

  setArtifact(sessionId: string, key: string, value: unknown): void {
    this.ensureSession(sessionId)
    const now = new Date().toISOString()
    this.sqlite
      .prepare(
        `INSERT INTO p2_session_artifacts (session_id, artifact_key, artifact_type, payload, created_at)
         VALUES (?, ?, 'domain_artifact', ?, ?)
         ON CONFLICT(session_id, artifact_key)
         DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
      )
      .run(sessionId, key, JSON.stringify(value), now)
  }

  storeArtifact(
    sessionId: string,
    artifact: Omit<SessionArtifact, 'id' | 'sessionId' | 'timestamp'>,
  ): SessionArtifact {
    this.ensureSession(sessionId)
    const artifactKey = randomUUID()
    const timestamp = new Date().toISOString()
    const payload = JSON.stringify({
      filePath: artifact.filePath,
      content: artifact.content,
      metadata: artifact.metadata,
      description: artifact.description,
    })

    const result = this.sqlite
      .prepare(
        `INSERT INTO p2_session_artifacts (
           session_id, artifact_key, artifact_type, agent_role, description, file_path, content, metadata, payload, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        artifactKey,
        artifact.type,
        artifact.agentRole,
        artifact.description,
        artifact.filePath ?? null,
        artifact.content ?? null,
        artifact.metadata ? JSON.stringify(artifact.metadata) : null,
        payload,
        timestamp,
      )

    return {
      id: String(result.lastInsertRowid),
      sessionId,
      ...artifact,
      timestamp,
    }
  }

  listArtifacts(sessionId: string): SessionArtifact[] {
    const artifactRows = this.sqlite
      .prepare(
        `SELECT id, session_id, artifact_key, artifact_type, agent_role, description, file_path, content, metadata, payload, created_at
         FROM p2_session_artifacts
         WHERE session_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId) as ArtifactRow[]

    return artifactRows.map((artifact) => ({
      id: String(artifact.id),
      sessionId: artifact.session_id,
      type: (artifact.artifact_type ?? 'domain_artifact') as SessionArtifact['type'],
      agentRole: artifact.agent_role ?? 'unknown',
      description: artifact.description ?? '',
      filePath: artifact.file_path ?? undefined,
      content: artifact.content ?? undefined,
      metadata: artifact.metadata ? JSON.parse(artifact.metadata) : undefined,
      timestamp: artifact.created_at,
    }))
  }

  getArtifactById(artifactId: string): SessionArtifact | undefined {
    const artifact = this.sqlite
      .prepare(
        `SELECT id, session_id, artifact_key, artifact_type, agent_role, description, file_path, content, metadata, payload, created_at
         FROM p2_session_artifacts
         WHERE id = ?`,
      )
      .get(Number(artifactId)) as ArtifactRow | undefined

    if (!artifact) return undefined

    return {
      id: String(artifact.id),
      sessionId: artifact.session_id,
      type: (artifact.artifact_type ?? 'domain_artifact') as SessionArtifact['type'],
      agentRole: artifact.agent_role ?? 'unknown',
      description: artifact.description ?? '',
      filePath: artifact.file_path ?? undefined,
      content: artifact.content ?? undefined,
      metadata: artifact.metadata ? JSON.parse(artifact.metadata) : undefined,
      timestamp: artifact.created_at,
    }
  }

  classifyFailure(error?: string, status?: StepExecutionStatus): FailureCategory {
    return diagnoseFailureMessage(error, status).failureCategory
  }

  recordStepPerformance(input: StepPerformanceInput): StepPerformanceRecord {
    this.ensureSession(input.sessionId)
    const createdAt = new Date().toISOString()
    const errorCategory = input.errorCategory ?? this.classifyFailure(input.errorMessage, input.status)
    const result = this.sqlite
      .prepare(
        `INSERT INTO p2_step_performance (
           session_id, scenario_id, step_id, agent_id, status, success, attempt,
           duration_ms, error_category, error_message, started_at, completed_at, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.scenarioId,
        input.stepId,
        input.agentId,
        input.status,
        input.success ? 1 : 0,
        input.attempt,
        input.durationMs,
        errorCategory,
        input.errorMessage ?? null,
        input.startedAt ?? null,
        input.completedAt ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt,
      )

    return {
      ...input,
      id: Number(result.lastInsertRowid),
      errorCategory,
      createdAt,
    }
  }

  listStepPerformance(filter: {
    scenarioId?: string
    stepId?: string
    agentId?: string
    limit?: number
  } = {}): StepPerformanceRecord[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.scenarioId) {
      where.push('scenario_id = ?')
      params.push(filter.scenarioId)
    }
    if (filter.stepId) {
      where.push('step_id = ?')
      params.push(filter.stepId)
    }
    if (filter.agentId) {
      where.push('agent_id = ?')
      params.push(filter.agentId)
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 50, 500))
    const rows = this.sqlite
      .prepare(
        `SELECT id, session_id, scenario_id, step_id, agent_id, status, success, attempt,
                duration_ms, error_category, error_message, started_at, completed_at, metadata, created_at
         FROM p2_step_performance
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit) as StepPerformanceRow[]

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      scenarioId: row.scenario_id,
      stepId: row.step_id,
      agentId: row.agent_id,
      status: row.status,
      success: row.success === 1,
      attempt: row.attempt,
      durationMs: row.duration_ms,
      errorCategory: row.error_category ?? undefined,
      errorMessage: row.error_message ?? undefined,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
    }))
  }

  getStepHistoryStats(scenarioId: string, stepId: string, limit = 50): StepHistoryStats {
    const recentExecutions = this.listStepPerformance({ scenarioId, stepId, limit })
    const totalExecutions = recentExecutions.length
    const successes = recentExecutions.filter((record) => record.success).length
    const durations = recentExecutions.map((record) => record.durationMs).sort((a, b) => a - b)
    const p95Index = durations.length ? Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1) : 0
    const retryAttempts = recentExecutions.filter((record) => record.attempt > 1)
    const retrySuccesses = retryAttempts.filter((record) => record.success)
    const failureBreakdown: Record<string, number> = {}

    for (const record of recentExecutions) {
      if (!record.success) {
        const category = record.errorCategory ?? 'unknown'
        failureBreakdown[category] = (failureBreakdown[category] ?? 0) + 1
      }
    }

    return {
      scenarioId,
      stepId,
      totalExecutions,
      successRate: totalExecutions ? successes / totalExecutions : 0,
      averageDurationMs: totalExecutions
        ? Math.round(recentExecutions.reduce((sum, record) => sum + record.durationMs, 0) / totalExecutions)
        : 0,
      p95DurationMs: durations[p95Index] ?? 0,
      retryRecoveryRate: retryAttempts.length ? retrySuccesses.length / retryAttempts.length : 0,
      failureBreakdown,
      recentExecutions,
    }
  }

  recordAdaptationEvent(input: AdaptationEventInput): AdaptationEvent {
    const timestamp = new Date().toISOString()
    const result = this.sqlite
      .prepare(
        `INSERT INTO p2_adaptation_events (
           session_id, scenario_id, step_id, adaptation_type, previous_value,
           new_value, reason, confidence, outcome, metadata, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId ?? null,
        input.scenarioId,
        input.stepId ?? null,
        input.type,
        input.previousValue === undefined ? null : JSON.stringify(input.previousValue),
        input.newValue === undefined ? null : JSON.stringify(input.newValue),
        input.reason,
        input.confidence,
        input.outcome ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        timestamp,
      )

    if (input.sessionId) {
      this.addEvent(input.sessionId, 'adaptation_decision', {
        type: input.type,
        stepId: input.stepId,
        previousValue: input.previousValue,
        newValue: input.newValue,
        reason: input.reason,
        confidence: input.confidence,
        outcome: input.outcome,
      })
    }

    return { ...input, id: Number(result.lastInsertRowid), timestamp }
  }

  listAdaptationEvents(filter: { scenarioId?: string; stepId?: string; limit?: number } = {}): AdaptationEvent[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.scenarioId) {
      where.push('scenario_id = ?')
      params.push(filter.scenarioId)
    }
    if (filter.stepId) {
      where.push('step_id = ?')
      params.push(filter.stepId)
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 50, 500))
    const rows = this.sqlite
      .prepare(
        `SELECT id, session_id, scenario_id, step_id, adaptation_type, previous_value,
                new_value, reason, confidence, outcome, metadata, timestamp
         FROM p2_adaptation_events
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit) as AdaptationEventRow[]

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id ?? undefined,
      scenarioId: row.scenario_id,
      stepId: row.step_id ?? undefined,
      type: row.adaptation_type,
      previousValue: row.previous_value ? JSON.parse(row.previous_value) : undefined,
      newValue: row.new_value ? JSON.parse(row.new_value) : undefined,
      reason: row.reason,
      confidence: row.confidence,
      outcome: row.outcome ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      timestamp: row.timestamp,
    }))
  }

  createLearningProposal(input: LearningProposalInput): LearningProposal {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.sqlite
      .prepare(
        `INSERT INTO p2_learning_proposals (
           proposal_id, recommendation_id, scenario_id, step_id, agent_id, proposal_type,
           severity, status, recommendation, patch_kind, target, patch_content, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(recommendation_id)
         DO UPDATE SET
           recommendation = excluded.recommendation,
           metadata = excluded.metadata`,
      )
      .run(
        id,
        input.recommendationId,
        input.scenarioId,
        input.stepId,
        input.agentId ?? null,
        input.type,
        input.severity,
        JSON.stringify(input.recommendation),
        input.patchKind,
        input.target ?? null,
        input.patchContent ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt,
      )

    return this.getLearningProposalByRecommendationId(input.recommendationId)!
  }

  getLearningProposal(id: string): LearningProposal | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT proposal_id, recommendation_id, scenario_id, step_id, agent_id, proposal_type,
                severity, status, recommendation, patch_kind, target, patch_content, metadata,
                created_at, approved_at, applied_at, rejected_at
         FROM p2_learning_proposals
         WHERE proposal_id = ?`,
      )
      .get(id) as LearningProposalRow | undefined

    return row ? this.mapLearningProposal(row) : undefined
  }

  getLearningProposalByRecommendationId(recommendationId: string): LearningProposal | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT proposal_id, recommendation_id, scenario_id, step_id, agent_id, proposal_type,
                severity, status, recommendation, patch_kind, target, patch_content, metadata,
                created_at, approved_at, applied_at, rejected_at
         FROM p2_learning_proposals
         WHERE recommendation_id = ?`,
      )
      .get(recommendationId) as LearningProposalRow | undefined

    return row ? this.mapLearningProposal(row) : undefined
  }

  listLearningProposals(filter: {
    scenarioId?: string
    status?: LearningProposalStatus
    limit?: number
  } = {}): LearningProposal[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.scenarioId) {
      where.push('scenario_id = ?')
      params.push(filter.scenarioId)
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500))
    const rows = this.sqlite
      .prepare(
        `SELECT proposal_id, recommendation_id, scenario_id, step_id, agent_id, proposal_type,
                severity, status, recommendation, patch_kind, target, patch_content, metadata,
                created_at, approved_at, applied_at, rejected_at
         FROM p2_learning_proposals
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params, limit) as LearningProposalRow[]

    return rows.map((row) => this.mapLearningProposal(row))
  }

  updateLearningProposalStatus(id: string, status: LearningProposalStatus): LearningProposal | undefined {
    const timestampColumn = status === 'approved'
      ? 'approved_at'
      : status === 'applied'
        ? 'applied_at'
        : status === 'rejected'
          ? 'rejected_at'
          : null
    const timestamp = new Date().toISOString()

    if (timestampColumn) {
      this.sqlite
        .prepare(`UPDATE p2_learning_proposals SET status = ?, ${timestampColumn} = ? WHERE proposal_id = ?`)
        .run(status, timestamp, id)
    } else {
      this.sqlite
        .prepare(`UPDATE p2_learning_proposals SET status = ? WHERE proposal_id = ?`)
        .run(status, id)
    }

    return this.getLearningProposal(id)
  }

  listAppliedPromptOverlays(agentId: string): LearningProposal[] {
    const rows = this.sqlite
      .prepare(
        `SELECT proposal_id, recommendation_id, scenario_id, step_id, agent_id, proposal_type,
                severity, status, recommendation, patch_kind, target, patch_content, metadata,
                created_at, approved_at, applied_at, rejected_at
         FROM p2_learning_proposals
         WHERE status = 'applied'
           AND patch_kind = 'prompt_overlay'
           AND (agent_id = ? OR target = 'agent:*')
         ORDER BY applied_at ASC, created_at ASC`,
      )
      .all(agentId) as LearningProposalRow[]

    return rows.map((row) => this.mapLearningProposal(row))
  }

  listRuntimeLearningOverlays(filter: {
    scenarioId?: string
    stepId?: string
    agentId: string
    limit?: number
  }): RuntimeLearningOverlay[] {
    const where = [
      `m.subject_type = 'learning_proposal'`,
      `m.kind = 'learning_prompt_overlay'`,
      `m.status = 'active'`,
      `p.status = 'applied'`,
      `p.patch_kind = 'prompt_overlay'`,
      `p.patch_content IS NOT NULL`,
      `(p.agent_id = ? OR p.target = ? OR p.target = 'agent:*')`,
    ]
    const params: unknown[] = [filter.agentId, `agent:${filter.agentId}`]

    if (filter.scenarioId) {
      where.push('p.scenario_id = ?')
      params.push(filter.scenarioId)
    }
    if (filter.stepId) {
      where.push('p.step_id = ?')
      params.push(filter.stepId)
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 5, 25))
    const rows = this.sqlite
      .prepare(
        `SELECT p.proposal_id, p.scenario_id, p.step_id, p.agent_id, p.target,
                p.patch_content, m.materialization_id, m.file_path, m.checksum,
                m.metadata, m.created_at
         FROM p2_l5_materializations m
         INNER JOIN p2_learning_proposals p ON p.proposal_id = m.subject_id
         WHERE ${where.join(' AND ')}
         ORDER BY m.created_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as RuntimeLearningOverlayRow[]

    return rows
      .filter((row) => this.hasVerifiedRuntimeLearningMetadata(row.metadata))
      .reverse()
      .map((row) => ({
        proposalId: row.proposal_id,
        materializationId: row.materialization_id,
        scenarioId: row.scenario_id,
        stepId: row.step_id,
        agentId: row.agent_id ?? undefined,
        target: row.target ?? undefined,
        patchContent: row.patch_content,
        checksum: row.checksum,
        filePath: row.file_path,
        createdAt: row.created_at,
      }))
  }

  createScenarioDraft(input: ScenarioDraftInput): ScenarioDraft {
    const id = input.id ?? randomUUID()
    const now = new Date().toISOString()
    this.sqlite
      .prepare(
        `INSERT INTO p2_scenario_drafts (
           draft_id, scenario_id, name, description, contract_json, gap_type,
           gap_evidence, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(scenario_id)
         DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           contract_json = excluded.contract_json,
           gap_type = excluded.gap_type,
           gap_evidence = excluded.gap_evidence,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.scenarioId,
        input.name,
        input.description ?? null,
        JSON.stringify(input.contract),
        input.gapType,
        input.gapEvidence ? JSON.stringify(input.gapEvidence) : null,
        now,
        now,
      )

    return this.getScenarioDraftByScenarioId(input.scenarioId)!
  }

  listScenarioDrafts(filter: { status?: ScenarioDraftStatus; limit?: number } = {}): ScenarioDraft[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500))
    const rows = this.sqlite
      .prepare(
        `SELECT draft_id, scenario_id, name, description, contract_json, gap_type,
                gap_evidence, status, reviewed_by, reviewed_at, created_at, updated_at
         FROM p2_scenario_drafts
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params, limit) as ScenarioDraftRow[]

    return rows.map((row) => this.mapScenarioDraft(row))
  }

  updateScenarioDraftStatus(id: string, status: ScenarioDraftStatus, reviewedBy?: string): ScenarioDraft | undefined {
    const now = new Date().toISOString()
    this.sqlite
      .prepare(
        `UPDATE p2_scenario_drafts
         SET status = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
         WHERE draft_id = ?`,
      )
      .run(status, reviewedBy ?? null, now, now, id)

    return this.getScenarioDraft(id)
  }

  updateScenarioDraftContract(id: string, contract: Record<string, unknown>): ScenarioDraft | undefined {
    const now = new Date().toISOString()
    this.sqlite
      .prepare(
        `UPDATE p2_scenario_drafts
         SET contract_json = ?, updated_at = ?
         WHERE draft_id = ?`,
      )
      .run(JSON.stringify(contract), now, id)

    return this.getScenarioDraft(id)
  }

  getScenarioDraft(id: string): ScenarioDraft | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT draft_id, scenario_id, name, description, contract_json, gap_type,
                gap_evidence, status, reviewed_by, reviewed_at, created_at, updated_at
         FROM p2_scenario_drafts
         WHERE draft_id = ?`,
      )
      .get(id) as ScenarioDraftRow | undefined

    return row ? this.mapScenarioDraft(row) : undefined
  }

  private getScenarioDraftByScenarioId(scenarioId: string): ScenarioDraft | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT draft_id, scenario_id, name, description, contract_json, gap_type,
                gap_evidence, status, reviewed_by, reviewed_at, created_at, updated_at
         FROM p2_scenario_drafts
         WHERE scenario_id = ?`,
      )
      .get(scenarioId) as ScenarioDraftRow | undefined

    return row ? this.mapScenarioDraft(row) : undefined
  }

  recordHealingAction(input: HealingActionInput): HealingAction {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.sqlite
      .prepare(
        `INSERT INTO p2_healing_actions (
           action_id, action_type, target, reason, automatic, status, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.target,
        input.reason,
        input.automatic ? 1 : 0,
        input.status,
        input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt,
      )

    return { ...input, id, createdAt }
  }

  updateHealingActionStatus(
    id: string,
    status: HealingActionStatus,
    metadata?: Record<string, unknown>,
  ): HealingAction | undefined {
    if (metadata) {
      this.sqlite
        .prepare(
          `UPDATE p2_healing_actions
           SET status = ?, metadata = ?
           WHERE action_id = ?`,
        )
        .run(status, JSON.stringify(metadata), id)
    } else {
      this.sqlite
        .prepare(
          `UPDATE p2_healing_actions
           SET status = ?
           WHERE action_id = ?`,
        )
        .run(status, id)
    }

    return this.getHealingAction(id)
  }

  getHealingAction(id: string): HealingAction | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT action_id, action_type, target, reason, automatic, status, metadata, created_at
         FROM p2_healing_actions
         WHERE action_id = ?`,
      )
      .get(id) as HealingActionRow | undefined

    return row ? this.mapHealingAction(row) : undefined
  }

  listHealingActions(filter: { limit?: number } = {}): HealingAction[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500))
    const rows = this.sqlite
      .prepare(
        `SELECT action_id, action_type, target, reason, automatic, status, metadata, created_at
         FROM p2_healing_actions
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(limit) as HealingActionRow[]

    return rows.map((row) => this.mapHealingAction(row))
  }

  countAutomaticHealingActionsSince(isoTimestamp: string): number {
    const row = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS total
         FROM p2_healing_actions
         WHERE automatic = 1
           AND status = 'applied'
           AND created_at >= ?`,
      )
      .get(isoTimestamp) as { total: number }

    return row.total
  }

  recordGovernanceDecision(input: GovernanceDecisionInput): GovernanceDecision {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.sqlite
      .prepare(
        `INSERT INTO p2_governance_decisions (
           decision_id, subject_type, subject_id, action, verdict, reason,
           actor, requirements, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.subjectType,
        input.subjectId,
        input.action,
        input.verdict,
        input.reason,
        input.actor ?? null,
        input.requirements ? JSON.stringify(input.requirements) : null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt,
      )

    return { ...input, id, createdAt }
  }

  listGovernanceDecisions(filter: {
    subjectType?: GovernanceSubjectType
    subjectId?: string
    limit?: number
  } = {}): GovernanceDecision[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.subjectType) {
      where.push('subject_type = ?')
      params.push(filter.subjectType)
    }
    if (filter.subjectId) {
      where.push('subject_id = ?')
      params.push(filter.subjectId)
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500))
    const rows = this.sqlite
      .prepare(
        `SELECT decision_id, subject_type, subject_id, action, verdict, reason,
                actor, requirements, metadata, created_at
         FROM p2_governance_decisions
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params, limit) as GovernanceDecisionRow[]

    return rows.map((row) => this.mapGovernanceDecision(row))
  }

  recordKnowledgePromotionEvent(input: KnowledgePromotionEventInput): KnowledgePromotionEvent {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.sqlite
      .prepare(
        `INSERT INTO p2_knowledge_promotion_events (
           event_id, source_run_id, candidate_id, candidate_version, subject_type,
           subject_id, promotion_type, action, status, actor, reason, target,
           result_json, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sourceRunId,
        input.candidateId,
        input.candidateVersion,
        input.subjectType,
        input.subjectId,
        input.promotionType,
        input.action,
        input.status,
        input.actor ?? null,
        input.reason ?? null,
        input.target ?? null,
        input.result ? JSON.stringify(input.result) : null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt,
      )

    const event = { ...input, id, createdAt }
    this.recordLearningSignalForKnowledgePromotion(event)
    return event
  }

  listKnowledgePromotionEvents(filter: {
    sourceRunId?: string
    subjectType?: GovernanceSubjectType
    subjectId?: string
    limit?: number
  } = {}): KnowledgePromotionEvent[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.sourceRunId) {
      where.push('source_run_id = ?')
      params.push(filter.sourceRunId)
    }
    if (filter.subjectType) {
      where.push('subject_type = ?')
      params.push(filter.subjectType)
    }
    if (filter.subjectId) {
      where.push('subject_id = ?')
      params.push(filter.subjectId)
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500))
    const rows = this.sqlite
      .prepare(
        `SELECT event_id, source_run_id, candidate_id, candidate_version,
                subject_type, subject_id, promotion_type, action, status, actor,
                reason, target, result_json, metadata, created_at
         FROM p2_knowledge_promotion_events
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params, limit) as KnowledgePromotionEventRow[]

    return rows.map((row) => this.mapKnowledgePromotionEvent(row))
  }

  recordL5LearningSignal(input: L5LearningSignalInput): L5LearningSignal {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const confidence = clampNumber(input.confidence, 0, 1)
    const supersededByConflict = this.resolveConflictingLearningSignals({
      ...input,
      confidence,
    })
    const metadata = supersededByConflict.length > 0
      ? {
        ...(input.metadata ?? {}),
        conflictResolution: {
          policy: 'opposite_polarity_same_scope',
          supersededSignalIds: supersededByConflict,
        },
      }
      : input.metadata

    this.supersedeRetainedLearningSignals(input)
    this.sqlite
      .prepare(
        `INSERT INTO p2_l5_learning_signals (
           signal_id, source_type, source_id, signal_type, source_run_id,
           subject_type, subject_id, scenario_id, step_id, agent_id, version,
           confidence, status, summary, evidence, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'retained', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sourceType,
        input.sourceId,
        input.signalType,
        input.sourceRunId ?? null,
        input.subjectType ?? null,
        input.subjectId ?? null,
        input.scenarioId ?? null,
        input.stepId ?? null,
        input.agentId ?? null,
        input.version,
        confidence,
        input.summary,
        input.evidence ? JSON.stringify(input.evidence) : null,
        metadata ? JSON.stringify(metadata) : null,
        createdAt,
      )

    return {
      ...input,
      confidence,
      metadata,
      id,
      status: 'retained',
      createdAt,
    }
  }

  listL5LearningSignals(filter: {
    sourceRunId?: string
    subjectType?: GovernanceSubjectType
    subjectId?: string
    scenarioId?: string
    stepId?: string
    agentId?: string
    signalType?: L5LearningSignalType
    status?: L5LearningSignalStatus
    limit?: number
  } = {}): L5LearningSignal[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.sourceRunId) {
      where.push('source_run_id = ?')
      params.push(filter.sourceRunId)
    }
    if (filter.subjectType) {
      where.push('subject_type = ?')
      params.push(filter.subjectType)
    }
    if (filter.subjectId) {
      where.push('subject_id = ?')
      params.push(filter.subjectId)
    }
    if (filter.scenarioId) {
      where.push('scenario_id = ?')
      params.push(filter.scenarioId)
    }
    if (filter.stepId) {
      where.push('(step_id = ? OR step_id IS NULL)')
      params.push(filter.stepId)
    }
    if (filter.agentId) {
      where.push('(agent_id = ? OR agent_id IS NULL)')
      params.push(filter.agentId)
    }
    if (filter.signalType) {
      where.push('signal_type = ?')
      params.push(filter.signalType)
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500))
    const rows = this.sqlite
      .prepare(
        `SELECT signal_id, source_type, source_id, signal_type, source_run_id,
                subject_type, subject_id, scenario_id, step_id, agent_id, version,
                confidence, status, summary, evidence, metadata, created_at
         FROM p2_l5_learning_signals
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params, limit) as L5LearningSignalRow[]

    return rows.map((row) => this.mapL5LearningSignal(row))
  }

  summarizeL5LearningSignals(filter: {
    scenarioId?: string
    limit?: number
  } = {}): L5LearningSignalSummary {
    const signals = this.listL5LearningSignals({
      scenarioId: filter.scenarioId,
      limit: filter.limit ?? 500,
    })

    return {
      total: signals.length,
      retained: signals.filter((signal) => signal.status === 'retained').length,
      superseded: signals.filter((signal) => signal.status === 'superseded').length,
      bySignalType: countBy(signals, (signal) => signal.signalType),
      bySourceType: countBy(signals, (signal) => signal.sourceType),
      latestSignals: signals.slice(0, 8),
    }
  }

  recordL5Materialization(input: L5MaterializationInput): L5Materialization {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.sqlite
      .prepare(
        `INSERT INTO p2_l5_materializations (
           materialization_id, subject_type, subject_id, kind, status,
           file_path, checksum, metadata, created_at, rolled_back_at
         ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.subjectType,
        input.subjectId,
        input.kind,
        input.filePath,
        input.checksum,
        input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt,
      )

    return {
      ...input,
      id,
      status: 'active',
      createdAt,
    }
  }

  listL5Materializations(filter: {
    subjectType?: L5MaterializationSubjectType
    subjectId?: string
    status?: L5MaterializationStatus
    limit?: number
  } = {}): L5Materialization[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.subjectType) {
      where.push('subject_type = ?')
      params.push(filter.subjectType)
    }
    if (filter.subjectId) {
      where.push('subject_id = ?')
      params.push(filter.subjectId)
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500))
    const rows = this.sqlite
      .prepare(
        `SELECT materialization_id, subject_type, subject_id, kind, status,
                file_path, checksum, metadata, created_at, rolled_back_at
         FROM p2_l5_materializations
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params, limit) as L5MaterializationRow[]

    return rows.map((row) => this.mapL5Materialization(row))
  }

  markL5MaterializationRolledBack(id: string): L5Materialization | undefined {
    const timestamp = new Date().toISOString()
    this.sqlite
      .prepare(
        `UPDATE p2_l5_materializations
         SET status = 'rolled_back', rolled_back_at = ?
         WHERE materialization_id = ?`,
      )
      .run(timestamp, id)

    const row = this.sqlite
      .prepare(
        `SELECT materialization_id, subject_type, subject_id, kind, status,
                file_path, checksum, metadata, created_at, rolled_back_at
         FROM p2_l5_materializations
         WHERE materialization_id = ?`,
      )
      .get(id) as L5MaterializationRow | undefined

    return row ? this.mapL5Materialization(row) : undefined
  }

  recordL5ClosedLoopRun(input: L5ClosedLoopRunInput): L5ClosedLoopRun {
    const id = randomUUID()
    const startedAt = input.startedAt ?? new Date().toISOString()
    const completedAt = input.completedAt ?? new Date().toISOString()

    this.sqlite
      .prepare(
        `INSERT INTO p2_l5_closed_loop_runs (
           loop_id, status, mode, scenario_id, queued_scenarios, actions_json,
           verification_json, summary_json, metadata, started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.status,
        input.mode,
        input.scenarioId ?? null,
        JSON.stringify(input.queuedScenarios),
        JSON.stringify(input.actions),
        JSON.stringify(input.verification),
        JSON.stringify(input.summary),
        input.metadata ? JSON.stringify(input.metadata) : null,
        startedAt,
        completedAt,
      )

    return {
      ...input,
      id,
      startedAt,
      completedAt,
    }
  }

  getL5ClosedLoopRun(id: string): L5ClosedLoopRun | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT loop_id, status, mode, scenario_id, queued_scenarios, actions_json,
                verification_json, summary_json, metadata, started_at, completed_at
         FROM p2_l5_closed_loop_runs
         WHERE loop_id = ?`,
      )
      .get(id) as L5ClosedLoopRunRow | undefined

    return row ? this.mapL5ClosedLoopRun(row) : undefined
  }

  listL5ClosedLoopRuns(filter: {
    scenarioId?: string
    status?: L5ClosedLoopStatus
    limit?: number
  } = {}): L5ClosedLoopRun[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.scenarioId) {
      where.push('scenario_id = ?')
      params.push(filter.scenarioId)
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 25, 100))
    const rows = this.sqlite
      .prepare(
        `SELECT loop_id, status, mode, scenario_id, queued_scenarios, actions_json,
                verification_json, summary_json, metadata, started_at, completed_at
         FROM p2_l5_closed_loop_runs
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY completed_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params, limit) as L5ClosedLoopRunRow[]

    return rows.map((row) => this.mapL5ClosedLoopRun(row))
  }

  recordL5IndependentAuditReview(input: L5IndependentAuditReviewInput): L5IndependentAuditReview {
    const id = randomUUID()
    const createdAt = new Date().toISOString()

    this.sqlite
      .prepare(
        `INSERT INTO p2_l5_independent_audit_reviews (
           review_id, run_id, status, actor, reason, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.status,
        input.actor ?? null,
        input.reason ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt,
      )

    const review = { ...input, id, createdAt }
    this.recordLearningSignalForIndependentAuditReview(review)
    return review
  }

  listL5IndependentAuditReviews(filter: {
    runId?: string
    limit?: number
  } = {}): L5IndependentAuditReview[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.runId) {
      where.push('run_id = ?')
      params.push(filter.runId)
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500))
    const rows = this.sqlite
      .prepare(
        `SELECT review_id, run_id, status, actor, reason, metadata, created_at
         FROM p2_l5_independent_audit_reviews
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params, limit) as L5IndependentAuditReviewRow[]

    return rows.map((row) => this.mapL5IndependentAuditReview(row))
  }

  getLatestL5IndependentAuditReview(runId: string): L5IndependentAuditReview | undefined {
    return this.listL5IndependentAuditReviews({ runId, limit: 1 })[0]
  }

  listL5IndependentAuditReviewQueue(filter: {
    limit?: number
  } = {}): L5IndependentAuditReviewQueueItem[] {
    const reviewedRunIds = new Set(
      this.listL5IndependentAuditReviews({ limit: 500 })
        .filter((review) => review.status === 'reviewed')
        .map((review) => review.runId),
    )

    const limit = Math.max(1, Math.min(filter.limit ?? 25, 100))
    return this.listL5ClosedLoopRuns({ limit: 500 })
      .filter((run) => !reviewedRunIds.has(run.id))
      .map((run): L5IndependentAuditReviewQueueItem | null => {
        const audit = getIndependentAuditReviewSignal(run)
        if (!audit) return null
        const item: L5IndependentAuditReviewQueueItem = {
          runId: run.id,
          status: run.status,
          verdict: audit.verdict,
          findingCount: audit.findingCount,
          auditedSessions: audit.auditedSessions,
          completedAt: run.completedAt,
        }
        if (run.scenarioId) item.scenarioId = run.scenarioId
        if (audit.checkedAt) item.checkedAt = audit.checkedAt
        if (typeof run.summary['statusReason'] === 'string') item.statusReason = run.summary['statusReason']
        return item
      })
      .filter((item): item is L5IndependentAuditReviewQueueItem => item !== null)
      .slice(0, limit)
  }

  private supersedeRetainedLearningSignals(input: L5LearningSignalInput): void {
    this.sqlite
      .prepare(
        `UPDATE p2_l5_learning_signals
         SET status = 'superseded'
         WHERE status = 'retained'
           AND signal_type = ?
           AND COALESCE(source_run_id, '') = ?
           AND COALESCE(subject_type, '') = ?
           AND COALESCE(subject_id, '') = ?
           AND COALESCE(scenario_id, '') = ?
           AND COALESCE(step_id, '') = ?
           AND COALESCE(agent_id, '') = ?`,
      )
      .run(
        input.signalType,
        input.sourceRunId ?? '',
        input.subjectType ?? '',
        input.subjectId ?? '',
        input.scenarioId ?? '',
        input.stepId ?? '',
        input.agentId ?? '',
      )
  }

  private resolveConflictingLearningSignals(input: L5LearningSignalInput): string[] {
    if (!input.scenarioId) return []
    const incomingPolarity = signalPolarity(input)
    if (incomingPolarity === 'neutral') return []
    if (incomingPolarity === 'stability' && input.signalType !== 'replay_verified') return []
    if (incomingPolarity === 'stability' && input.confidence < 0.7) return []
    if (incomingPolarity === 'risk' && input.confidence < 0.6) return []

    const conflicting = this.listL5LearningSignals({
      scenarioId: input.scenarioId,
      status: 'retained',
      limit: 500,
    }).filter((signal) => (
      sameLearningScope(input, signal)
      && signalPolarity(signal) === oppositeSignalPolarity(incomingPolarity)
    ))

    for (const signal of conflicting) {
      this.sqlite
        .prepare(
          `UPDATE p2_l5_learning_signals
           SET status = 'superseded'
           WHERE signal_id = ?`,
        )
        .run(signal.id)
    }

    return conflicting.map((signal) => signal.id)
  }

  private recordLearningSignalForIndependentAuditReview(review: L5IndependentAuditReview): void {
    const run = this.getL5ClosedLoopRun(review.runId)
    const audit = recordValue(run?.verification['independentAudit'])
    const auditSummary = recordValue(audit['summary'])
    const metadata = review.metadata ?? {}
    const auditVerdict = stringValue(metadata['auditVerdict'] ?? audit['verdict'], 'unknown')
    const findingCount = numberValue(metadata['findingCount'])
      || (Array.isArray(audit['findings']) ? audit['findings'].length : numberValue(auditSummary['findings']))

    this.recordL5LearningSignal({
      sourceType: 'independent_audit_review',
      sourceId: review.id,
      signalType: 'audit_reviewed',
      sourceRunId: review.runId,
      scenarioId: run?.scenarioId,
      version: `review:${review.id}`,
      confidence: auditVerdict === 'failed' ? 0.65 : auditVerdict === 'warning' ? 0.8 : 0.7,
      summary: review.reason ?? `Independent audit ${auditVerdict} reviewed.`,
      evidence: {
        auditVerdict,
        auditCheckedAt: metadata['auditCheckedAt'] ?? audit['checkedAt'],
        findingCount,
        reviewActor: review.actor,
        runStatus: run?.status,
      },
      metadata: {
        reviewStatus: review.status,
        runStatus: run?.status,
      },
    })
  }

  private recordLearningSignalForKnowledgePromotion(event: KnowledgePromotionEvent): void {
    const verification = recordValue(recordValue(event.result)['postPromotionVerification'])
    const verificationStatus = stringValue(verification['status'], 'unknown')
    if (event.status !== 'completed' || verificationStatus === 'failed' || verificationStatus === 'unknown') {
      return
    }

    const scope = this.resolveLearningSignalScope(event.subjectType, event.subjectId, event.target)
    this.recordL5LearningSignal({
      sourceType: 'knowledge_promotion',
      sourceId: event.id,
      signalType: 'promotion_verified',
      sourceRunId: event.sourceRunId,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      scenarioId: scope.scenarioId,
      stepId: scope.stepId,
      agentId: scope.agentId,
      version: event.candidateVersion,
      confidence: verificationStatus === 'passed' ? 1 : 0.75,
      summary: `${event.action} ${event.promotionType} completed with ${verificationStatus} verification.`,
      evidence: {
        action: event.action,
        promotionType: event.promotionType,
        candidateId: event.candidateId,
        verificationStatus,
        target: event.target,
        checkCount: Array.isArray(verification['checks']) ? verification['checks'].length : 0,
      },
      metadata: {
        promotionEventId: event.id,
        candidateStatus: event.metadata?.['candidateStatus'],
        approvalRequired: event.metadata?.['approvalRequired'],
        materializationReady: event.metadata?.['materializationReady'],
      },
    })
  }

  private resolveLearningSignalScope(
    subjectType: GovernanceSubjectType,
    subjectId: string,
    target?: string,
  ): {
    scenarioId?: string
    stepId?: string
    agentId?: string
  } {
    if (subjectType === 'learning_proposal') {
      const proposal = this.getLearningProposal(subjectId)
      return {
        scenarioId: proposal?.scenarioId,
        stepId: proposal?.stepId,
        agentId: proposal?.agentId ?? agentIdFromTarget(target ?? proposal?.target),
      }
    }

    if (subjectType === 'scenario_draft') {
      const draft = this.getScenarioDraft(subjectId)
      return {
        scenarioId: draft?.scenarioId,
      }
    }

    const action = this.getHealingAction(subjectId)
    const parsedTarget = parseHealingTarget(action?.target)
    return {
      scenarioId: parsedTarget.scenarioId,
      stepId: parsedTarget.stepId,
      agentId: agentIdFromTarget(target),
    }
  }

  private mapLearningProposal(row: LearningProposalRow): LearningProposal {
    return {
      id: row.proposal_id,
      recommendationId: row.recommendation_id,
      scenarioId: row.scenario_id,
      stepId: row.step_id,
      agentId: row.agent_id ?? undefined,
      type: row.proposal_type,
      severity: row.severity,
      status: row.status,
      recommendation: JSON.parse(row.recommendation),
      patchKind: row.patch_kind,
      target: row.target ?? undefined,
      patchContent: row.patch_content ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      approvedAt: row.approved_at ?? undefined,
      appliedAt: row.applied_at ?? undefined,
      rejectedAt: row.rejected_at ?? undefined,
    }
  }

  private mapScenarioDraft(row: ScenarioDraftRow): ScenarioDraft {
    return {
      id: row.draft_id,
      scenarioId: row.scenario_id,
      name: row.name,
      description: row.description ?? undefined,
      contract: JSON.parse(row.contract_json),
      gapType: row.gap_type,
      gapEvidence: row.gap_evidence ? JSON.parse(row.gap_evidence) : undefined,
      status: row.status,
      reviewedBy: row.reviewed_by ?? undefined,
      reviewedAt: row.reviewed_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private mapHealingAction(row: HealingActionRow): HealingAction {
    return {
      id: row.action_id,
      type: row.action_type,
      target: row.target,
      reason: row.reason,
      automatic: row.automatic === 1,
      status: row.status,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
    }
  }

  private mapGovernanceDecision(row: GovernanceDecisionRow): GovernanceDecision {
    return {
      id: row.decision_id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      action: row.action,
      verdict: row.verdict,
      reason: row.reason,
      actor: row.actor ?? undefined,
      requirements: row.requirements ? JSON.parse(row.requirements) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
    }
  }

  private mapL5Materialization(row: L5MaterializationRow): L5Materialization {
    return {
      id: row.materialization_id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      kind: row.kind,
      status: row.status,
      filePath: row.file_path,
      checksum: row.checksum,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      rolledBackAt: row.rolled_back_at ?? undefined,
    }
  }

  private hasVerifiedRuntimeLearningMetadata(metadataJson: string | null): boolean {
    if (!metadataJson) return false

    try {
      const metadata = JSON.parse(metadataJson) as {
        independentAudit?: { verdict?: unknown }
        postWriteVerification?: { checksumMatches?: unknown }
      }
      return metadata.independentAudit?.verdict === 'passed'
        && metadata.postWriteVerification?.checksumMatches === true
    } catch {
      return false
    }
  }

  private mapL5ClosedLoopRun(row: L5ClosedLoopRunRow): L5ClosedLoopRun {
    return {
      id: row.loop_id,
      status: row.status,
      mode: row.mode,
      scenarioId: row.scenario_id ?? undefined,
      queuedScenarios: JSON.parse(row.queued_scenarios),
      actions: JSON.parse(row.actions_json),
      verification: JSON.parse(row.verification_json),
      summary: JSON.parse(row.summary_json),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }
  }

  private mapL5IndependentAuditReview(row: L5IndependentAuditReviewRow): L5IndependentAuditReview {
    return {
      id: row.review_id,
      runId: row.run_id,
      status: row.status,
      actor: row.actor ?? undefined,
      reason: row.reason ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
    }
  }

  private mapKnowledgePromotionEvent(row: KnowledgePromotionEventRow): KnowledgePromotionEvent {
    return {
      id: row.event_id,
      sourceRunId: row.source_run_id,
      candidateId: row.candidate_id,
      candidateVersion: row.candidate_version,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      promotionType: row.promotion_type,
      action: row.action,
      status: row.status,
      actor: row.actor ?? undefined,
      reason: row.reason ?? undefined,
      target: row.target ?? undefined,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
    }
  }

  private mapL5LearningSignal(row: L5LearningSignalRow): L5LearningSignal {
    return {
      id: row.signal_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      signalType: row.signal_type,
      sourceRunId: row.source_run_id ?? undefined,
      subjectType: row.subject_type ?? undefined,
      subjectId: row.subject_id ?? undefined,
      scenarioId: row.scenario_id ?? undefined,
      stepId: row.step_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      version: row.version,
      confidence: row.confidence,
      status: row.status,
      summary: row.summary,
      evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
    }
  }

  storeFinding(
    sessionId: string,
    finding: Omit<SessionFinding, 'id' | 'sessionId' | 'timestamp' | 'createdAt'>,
  ): SessionFinding {
    this.ensureSession(sessionId)
    const timestamp = new Date().toISOString()
    const id = this.insertFindingRow(sessionId, {
      severity: finding.severity,
      title: finding.title,
      description: finding.description ?? null,
      evidence: finding.evidence ?? null,
      agentId: finding.agentId ?? finding.agentRole ?? null,
      stepId: finding.stepId ?? null,
      createdAt: timestamp,
    })

    return {
      id: String(id),
      sessionId,
      ...finding,
      timestamp,
      createdAt: timestamp,
    }
  }

  saveCheckpoint(sessionId: string, lastCompletedStep: number): void {
    const session = this.getSession(sessionId)
    if (!session) return

    const checkpointId = randomUUID()
    const now = new Date().toISOString()
    const cursor = session.events.length

    this.sqlite
      .prepare(
        `INSERT INTO p2_session_checkpoints (checkpoint_id, session_id, created_at, last_completed_step, cursor)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(checkpointId, sessionId, now, lastCompletedStep, cursor)

    this.addEvent(sessionId, 'checkpoint_saved', { lastCompletedStep, cursor })
  }

  private insertFindingRow(
    sessionId: string,
    finding: {
      severity: unknown
      title: unknown
      description: unknown
      evidence: unknown
      agentId: unknown
      stepId: unknown
      createdAt: string
    },
  ): number {
    const result = this.sqlite
      .prepare(
        `INSERT INTO p2_session_findings (
           session_id, severity, title, description, evidence, agent_id, step_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        typeof finding.severity === 'string' ? finding.severity : 'info',
        typeof finding.title === 'string' ? finding.title : 'Untitled',
        typeof finding.description === 'string' ? finding.description : null,
        finding.evidence ? JSON.stringify(finding.evidence) : null,
        typeof finding.agentId === 'string' ? finding.agentId : null,
        typeof finding.stepId === 'string' ? finding.stepId : null,
        finding.createdAt,
      )

    return Number(result.lastInsertRowid)
  }

  private ensureTables(): void {
    applyMigrations(this.sqlite, 'phase2-sessions', [
      baselineMigration(SESSION_SCHEMA_SQL, () => new Database(':memory:')),
    ])
  }
}

// Migration 1 (baseline) of the phase2 session tables. It never changes: a later schema change is a
// new numbered migration in ensureTables (A-03).
const SESSION_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS p2_sessions (
        session_id TEXT PRIMARY KEY,
        run_id INTEGER,
        scenario_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS p2_session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES p2_sessions(session_id),
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        agent_role TEXT,
        data TEXT,
        UNIQUE(session_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS p2_session_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES p2_sessions(session_id),
        created_at TEXT NOT NULL,
        last_completed_step INTEGER NOT NULL,
        cursor INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_session_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES p2_sessions(session_id),
        artifact_key TEXT NOT NULL,
        artifact_type TEXT,
        agent_role TEXT,
        description TEXT,
        file_path TEXT,
        content TEXT,
        metadata TEXT,
        payload TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, artifact_key)
      );

      CREATE TABLE IF NOT EXISTS p2_session_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES p2_sessions(session_id),
        severity TEXT,
        title TEXT,
        description TEXT,
        evidence TEXT,
        agent_id TEXT,
        step_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_step_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES p2_sessions(session_id),
        scenario_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        success INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        error_category TEXT,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_adaptation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT REFERENCES p2_sessions(session_id),
        scenario_id TEXT NOT NULL,
        step_id TEXT,
        adaptation_type TEXT NOT NULL,
        previous_value TEXT,
        new_value TEXT,
        reason TEXT NOT NULL,
        confidence REAL NOT NULL,
        outcome TEXT,
        metadata TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_learning_proposals (
        proposal_id TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL UNIQUE,
        scenario_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        agent_id TEXT,
        proposal_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        patch_kind TEXT NOT NULL,
        target TEXT,
        patch_content TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        applied_at TEXT,
        rejected_at TEXT
      );

      CREATE TABLE IF NOT EXISTS p2_scenario_drafts (
        draft_id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        contract_json TEXT NOT NULL,
        gap_type TEXT NOT NULL,
        gap_evidence TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        reviewed_by TEXT,
        reviewed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_healing_actions (
        action_id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        target TEXT NOT NULL,
        reason TEXT NOT NULL,
        automatic INTEGER NOT NULL,
        status TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_governance_decisions (
        decision_id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        action TEXT NOT NULL,
        verdict TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor TEXT,
        requirements TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_l5_materializations (
        materialization_id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        file_path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        rolled_back_at TEXT,
        UNIQUE(subject_type, subject_id, kind, file_path)
      );

      CREATE TABLE IF NOT EXISTS p2_l5_closed_loop_runs (
        loop_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        scenario_id TEXT,
        queued_scenarios TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        verification_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        metadata TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_l5_independent_audit_reviews (
        review_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        actor TEXT,
        reason TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_knowledge_promotion_events (
        event_id TEXT PRIMARY KEY,
        source_run_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        candidate_version TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        promotion_type TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        actor TEXT,
        reason TEXT,
        target TEXT,
        result_json TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_l5_learning_signals (
        signal_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        source_run_id TEXT,
        subject_type TEXT,
        subject_id TEXT,
        scenario_id TEXT,
        step_id TEXT,
        agent_id TEXT,
        version TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_tool_ledger_closures (
        session_id TEXT NOT NULL REFERENCES p2_sessions(session_id),
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        closed_at TEXT NOT NULL,
        original_started_at TEXT NOT NULL,
        PRIMARY KEY(session_id, tool_call_id)
      );

      CREATE TABLE IF NOT EXISTS p2_quality_gate_resets (
        id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        previous_status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_p2_quality_gate_resets_scenario ON p2_quality_gate_resets(scenario_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_sessions_scenario ON p2_sessions(scenario_id);
      CREATE INDEX IF NOT EXISTS idx_p2_events_session_sequence ON p2_session_events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_p2_findings_session_created ON p2_session_findings(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_step_perf_step ON p2_step_performance(scenario_id, step_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_adaptations_step ON p2_adaptation_events(scenario_id, step_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_p2_learning_proposals_status ON p2_learning_proposals(status, scenario_id);
      CREATE INDEX IF NOT EXISTS idx_p2_scenario_drafts_status ON p2_scenario_drafts(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_healing_actions_created ON p2_healing_actions(created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_governance_subject ON p2_governance_decisions(subject_type, subject_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_l5_materializations_subject ON p2_l5_materializations(subject_type, subject_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_l5_closed_loop_status ON p2_l5_closed_loop_runs(status, scenario_id, completed_at);
      CREATE INDEX IF NOT EXISTS idx_p2_l5_independent_audit_reviews_run ON p2_l5_independent_audit_reviews(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_knowledge_promotion_events_run ON p2_knowledge_promotion_events(source_run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_knowledge_promotion_events_subject ON p2_knowledge_promotion_events(subject_type, subject_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_l5_learning_signals_scope ON p2_l5_learning_signals(status, signal_type, scenario_id, step_id, agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_l5_learning_signals_source ON p2_l5_learning_signals(source_type, source_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_l5_learning_signals_subject ON p2_l5_learning_signals(subject_type, subject_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_tool_ledger_closures_session ON p2_tool_ledger_closures(session_id, closed_at);
`

export interface QualityGateReset {
  id: string
  scenarioId: string
  reason: string
  previousStatus: string
  createdAt: string
}

/**
 * B-09: one stored row with invalid JSON used to make every read of its session throw, and with it
 * getAllSessions, the runner and the stats (HTTP 500). The bad value is now reported in place.
 */
function parseStoredJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { unreadable: true, reason: 'stored JSON could not be parsed', length: text.length }
  }
}

export function createSessionServiceStub(): SessionService {
  return new SessionService(':memory:')
}

function getIndependentAuditReviewSignal(run: L5ClosedLoopRun): {
  verdict: 'failed' | 'warning'
  checkedAt?: string
  findingCount: number
  auditedSessions: number
} | null {
  const independentAudit = recordValue(run.verification['independentAudit'])
  const verdict = independentAudit['verdict']
  if (verdict !== 'failed' && verdict !== 'warning') return null

  const summary = recordValue(independentAudit['summary'])
  return {
    verdict,
    checkedAt: typeof independentAudit['checkedAt'] === 'string' ? independentAudit['checkedAt'] : undefined,
    findingCount: Array.isArray(independentAudit['findings'])
      ? independentAudit['findings'].length
      : numberValue(summary['findings']),
    auditedSessions: numberValue(summary['auditedSessions']),
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(value, max))
}

type L5SignalPolarity = 'risk' | 'stability' | 'neutral'

function signalPolarity(signal: Pick<L5LearningSignalInput, 'signalType' | 'evidence'>): L5SignalPolarity {
  if (signal.signalType === 'audit_reviewed') {
    const verdict = stringValue(signal.evidence?.['auditVerdict'], 'unknown')
    if (verdict === 'failed' || verdict === 'warning') return 'risk'
    if (verdict === 'passed') return 'stability'
    return 'neutral'
  }

  if (signal.signalType === 'promotion_verified') {
    const status = stringValue(signal.evidence?.['verificationStatus'], 'unknown')
    if (status === 'warning' || status === 'failed') return 'risk'
    if (status === 'passed') return 'stability'
    return 'neutral'
  }

  if (signal.signalType === 'replay_verified') {
    const status = stringValue(
      signal.evidence?.['replayStatus'] ?? signal.evidence?.['verificationStatus'],
      'unknown',
    )
    if (status === 'failed' || status === 'warning') return 'risk'
    if (status === 'passed') return 'stability'
  }

  return 'neutral'
}

function oppositeSignalPolarity(polarity: L5SignalPolarity): L5SignalPolarity {
  if (polarity === 'risk') return 'stability'
  if (polarity === 'stability') return 'risk'
  return 'neutral'
}

function sameLearningScope(input: L5LearningSignalInput, existing: L5LearningSignal): boolean {
  return (input.scenarioId ?? '') === (existing.scenarioId ?? '')
    && (input.stepId ?? '') === (existing.stepId ?? '')
    && (input.agentId ?? '') === (existing.agentId ?? '')
}

function countBy<T>(items: T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const key = keyOf(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function agentIdFromTarget(target: string | undefined): string | undefined {
  if (!target?.startsWith('agent:')) return undefined
  const agentId = target.slice('agent:'.length).trim()
  return agentId && agentId !== '*' ? agentId : undefined
}

function parseHealingTarget(target: string | undefined): { scenarioId?: string; stepId?: string } {
  if (!target) return {}
  const [scenarioId, stepId] = target.split(':')
  return {
    scenarioId: scenarioId || undefined,
    stepId: stepId || undefined,
  }
}
