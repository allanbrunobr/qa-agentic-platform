import { buildContractEvaluation } from './contract-evaluation.js'
import { CoverageAnalysisService } from './coverage-analysis-service.js'
import type { Phase2ExecutionContext } from './execution-context.js'
import { summarizeExecutionContext } from './execution-context.js'
import { L5LoopGuardService, type L5LoopGuard, type L5LoopId } from './l5-loop-guard-service.js'
import { L5MaterializationService } from './l5-materialization-service.js'
import { LearningControlService } from './learning-control-service.js'
import { MetaOrchestrator, type MetaOrchestrationQueueItem } from './meta-orchestrator.js'
import { IndependentAuditorService, type AuditorEvaluation, type AuditorFinding, type AuditorVerdict } from './independent-auditor-service.js'
import { buildScenarioQualityGateForScenario } from './scenario-quality-gates.js'
import { SelfHealingService } from './self-healing-service.js'
import type {
  L5ClosedLoopRun,
  L5LearningSignalSummary,
  LearningProposal,
  SessionService,
} from './session-service.js'
import type { Session } from '../types/session-types.js'

export interface L5ClosedLoopRunOptions {
  scenarioId?: string
  maxScenarios?: number
  applyApprovedChanges?: boolean
  generateScenarioDrafts?: boolean
  actor?: string
  maxApprovedApplies?: number
  executionContext?: Phase2ExecutionContext
}

export interface L5ClosedLoopStatus {
  generatedAt: string
  guards: L5LoopGuard[]
  queue: MetaOrchestrationQueueItem[]
  learningSignals: L5LearningSignalSummary
  latestRun: L5ClosedLoopRun | null
  recentRuns: L5ClosedLoopRun[]
}

interface ScenarioSnapshot {
  scenarioId: string
  finalSessions: number
  completeSessions: number
  failedSessions: number
  stepExecutions: number
  failedStepExecutions: number
  activeMaterializations: number
  retainedLearningSignals: number
  pendingLearningProposals: number
  approvedLearningProposals: number
  qualityGateStatus: string
}

interface SessionComparison {
  scenarioId: string
  verdict: 'improved' | 'regressed' | 'unchanged' | 'insufficient_history'
  previousSessionId?: string
  latestSessionId?: string
  previousScore?: number
  latestScore?: number
  scoreDelta?: number
  reason: string
}

type L5PolicyReplayStatus = 'passed' | 'warning' | 'failed' | 'skipped'

interface L5PolicyReplayVerification {
  scenarioId: string
  status: L5PolicyReplayStatus
  reason: string
  sourceSessionId?: string
  signalId?: string
  checkedAt: string
  policySignalIds: string[]
  auditVerdict?: AuditorVerdict
  hardViolations?: number
  driftSignals?: number
}

interface L5IndependentLoopVerification {
  agentRole: 'auditor'
  verdict: AuditorVerdict
  checkedAt: string
  sessionAudits: AuditorEvaluation[]
  findings: AuditorFinding[]
  summary: {
    auditedSessions: number
    failedSessionAudits: number
    warningSessionAudits: number
    lifecycleFindings: number
    findings: number
    actionCount: number
    pendingReviews: number
    materializedChanges: number
  }
}

type L5LifecycleLoopId = L5LoopId | 'verification' | 'replay'

type L5LifecycleEventType =
  | 'closed_loop_started'
  | 'closed_loop_completed'
  | 'loop_started'
  | 'loop_completed'
  | 'loop_blocked'
  | 'scenario_started'
  | 'scenario_completed'
  | 'independent_audit_started'
  | 'independent_audit_completed'

type L5LifecycleEvent = {
  type: L5LifecycleEventType
  timestamp: string
  loop?: L5LifecycleLoopId
  scenarioId?: string
  status?: string
  reason?: string
  details?: Record<string, unknown>
}

export class L5ClosedLoopService {
  constructor(private readonly sessionService: SessionService) {}

  getStatus(limit = 10): L5ClosedLoopStatus {
    const recentRuns = this.sessionService.listL5ClosedLoopRuns({ limit })
    return {
      generatedAt: new Date().toISOString(),
      guards: new L5LoopGuardService(this.sessionService).summarize(),
      queue: new MetaOrchestrator(this.sessionService).buildGovernedRunQueue(10),
      learningSignals: this.sessionService.summarizeL5LearningSignals({ limit: 500 }),
      latestRun: recentRuns[0] ?? null,
      recentRuns,
    }
  }

  async runOnce(options: L5ClosedLoopRunOptions = {}): Promise<L5ClosedLoopRun> {
    const startedAt = new Date().toISOString()
    const actor = options.actor ?? 'l5_closed_loop'
    const learningSignals = this.sessionService.summarizeL5LearningSignals({
      scenarioId: options.scenarioId,
      limit: 500,
    })
    const lifecycle: L5LifecycleEvent[] = []
    appendLifecycle(lifecycle, 'closed_loop_started', {
      details: {
        actor,
        scenarioId: options.scenarioId,
        applyApprovedChanges: options.applyApprovedChanges === true,
        generateScenarioDrafts: options.generateScenarioDrafts === true,
        retainedLearningSignals: learningSignals.retained,
        executionContext: summarizeExecutionContext(options.executionContext),
      },
    })
    const maxScenarios = clamp(options.maxScenarios ?? 3, 1, 10)
    const maxApprovedApplies = clamp(options.maxApprovedApplies ?? 3, 0, 10)
    const guards = new L5LoopGuardService(this.sessionService).summarize()
    const blockedGuard = guards.find((guard) => (
      guard.status === 'blocked'
      && (guard.loop === 'meta_orchestration' || guard.loop === 'learning' || guard.loop === 'materialization')
    ))

    if (blockedGuard) {
      appendLifecycle(lifecycle, 'loop_blocked', {
        loop: blockedGuard.loop,
        status: 'blocked',
        reason: blockedGuard.reason,
        details: {
          current: blockedGuard.current,
          limit: blockedGuard.limit,
        },
      })
      appendLifecycle(lifecycle, 'closed_loop_completed', {
        status: 'blocked',
        reason: blockedGuard.reason,
      })

      return this.record({
        status: 'blocked',
        mode: options.applyApprovedChanges ? 'apply_approved' : 'observe',
        scenarioId: options.scenarioId,
        queuedScenarios: [],
        actions: [{
          type: 'loop_blocked',
          loop: blockedGuard.loop,
          reason: blockedGuard.reason,
        }],
        verification: { comparisons: [], rerunRequired: false },
        summary: {
          statusReason: 'Closed loop blocked by L5 circuit breaker.',
          blockedLoop: blockedGuard.loop,
          generatedProposals: 0,
          appliedMaterializations: 0,
          pendingReviews: 0,
          retainedLearningSignals: learningSignals.retained,
        },
        metadata: {
          guards,
          lifecycle,
          learningSignals,
          executionContext: summarizeExecutionContext(options.executionContext),
        },
        startedAt,
      })
    }

    appendLifecycle(lifecycle, 'loop_started', { loop: 'meta_orchestration' })
    const queue = this.selectQueue(options.scenarioId, maxScenarios)
    const scenarios = queue.map((item) => item.scenarioId)
    appendLifecycle(lifecycle, 'loop_completed', {
      loop: 'meta_orchestration',
      status: scenarios.length > 0 ? 'queued' : 'empty',
      details: {
        queuedScenarios: scenarios.length,
        consideredScenarios: queue.length,
        l5SignalPolicies: queue.map((item) => ({
          scenarioId: item.scenarioId,
          retainedSignals: item.l5SignalPolicy.retainedSignals,
          decayedSignals: item.l5SignalPolicy.decayedSignals,
          averageEffectiveConfidence: item.l5SignalPolicy.averageEffectiveConfidence,
          riskModifier: item.l5SignalPolicy.riskModifier,
          requiresReplay: item.l5SignalPolicy.requiresReplay,
          requiresIndependentAudit: item.l5SignalPolicy.requiresIndependentAudit,
        })),
      },
    })

    const actions: Record<string, unknown>[] = []
    const before = Object.fromEntries(
      scenarios.map((scenarioId) => [scenarioId, this.buildScenarioSnapshot(scenarioId)]),
    )
    let generatedProposals = 0
    let pendingReviews = 0
    let appliedMaterializations = 0
    let automaticHealingActions = 0
    let scenarioDrafts = 0
    let replayVerifications: L5PolicyReplayVerification[] = []

    const replayQueue = queue.filter((item) => item.l5SignalPolicy.requiresReplay)
    if (replayQueue.length > 0) {
      appendLifecycle(lifecycle, 'loop_started', { loop: 'replay' })
      replayVerifications = replayQueue.map((item) => this.verifyL5PolicyReplay(item, actor))
      const replayReviews = replayVerifications.filter((verification) => verification.status !== 'passed').length
      pendingReviews += replayReviews
      actions.push(...replayVerifications.map((verification) => ({
        type: 'l5_policy_replay_verified',
        scenarioId: verification.scenarioId,
        status: verification.status,
        sourceSessionId: verification.sourceSessionId,
        signalId: verification.signalId,
        reason: verification.reason,
      })))
      appendLifecycle(lifecycle, 'loop_completed', {
        loop: 'replay',
        status: replayReviews > 0 ? 'needs_review' : 'completed',
        details: {
          requiredReplays: replayQueue.length,
          passed: replayVerifications.filter((verification) => verification.status === 'passed').length,
          warning: replayVerifications.filter((verification) => verification.status === 'warning').length,
          failed: replayVerifications.filter((verification) => verification.status === 'failed').length,
          skipped: replayVerifications.filter((verification) => verification.status === 'skipped').length,
        },
      })
    }

    for (const scenarioId of scenarios) {
      appendLifecycle(lifecycle, 'scenario_started', { scenarioId })
      appendLifecycle(lifecycle, 'loop_started', { loop: 'learning', scenarioId })
      const generated = new LearningControlService(this.sessionService).generateProposals({
        scenarioId,
        limit: 50,
      })
      generatedProposals += generated.length
      pendingReviews += generated.filter((proposal) => proposal.status === 'proposed').length
      appendLifecycle(lifecycle, 'loop_completed', {
        loop: 'learning',
        scenarioId,
        status: generated.length > 0 ? 'generated' : 'unchanged',
        details: {
          generatedProposals: generated.length,
          pendingReviews: generated.filter((proposal) => proposal.status === 'proposed').length,
        },
      })
      actions.push(...generated.map((proposal) => ({
        type: 'learning_proposal_generated',
        scenarioId,
        proposalId: proposal.id,
        status: proposal.status,
        patchKind: proposal.patchKind,
        severity: proposal.severity,
      })))

      if (options.applyApprovedChanges && maxApprovedApplies > 0) {
        appendLifecycle(lifecycle, 'loop_started', { loop: 'materialization', scenarioId })
        const approved = this.sessionService.listLearningProposals({
          scenarioId,
          status: 'approved',
          limit: maxApprovedApplies,
        }).filter(isAutoMaterializableProposal)

        let materializationFailures = 0
        for (const proposal of approved) {
          try {
            const applied = new LearningControlService(this.sessionService).applyProposal(proposal.id)
            const materialization = await new L5MaterializationService(this.sessionService)
              .materializeLearningProposal(applied)
            appliedMaterializations += 1
            actions.push({
              type: 'approved_learning_materialized',
              scenarioId,
              proposalId: proposal.id,
              materializationId: materialization.id,
              kind: materialization.kind,
              actor,
            })
          } catch (error) {
            pendingReviews += 1
            actions.push({
              type: 'approved_learning_materialization_failed',
              scenarioId,
              proposalId: proposal.id,
              error: error instanceof Error ? error.message : String(error),
              actor,
            })
            materializationFailures += 1
          }
        }
        appendLifecycle(lifecycle, 'loop_completed', {
          loop: 'materialization',
          scenarioId,
          status: materializationFailures > 0 ? 'needs_review' : 'completed',
          details: {
            consideredApprovedProposals: approved.length,
            appliedMaterializations,
            materializationFailures,
          },
        })
      }
      appendLifecycle(lifecycle, 'scenario_completed', { scenarioId })
    }

    appendLifecycle(lifecycle, 'loop_started', { loop: 'self_healing' })
    const healingActions = new SelfHealingService(this.sessionService).evaluateRecentFailures()
      .filter((action) => scenarios.length === 0 || scenarios.some((scenarioId) => action.target.startsWith(`${scenarioId}:`)))
    automaticHealingActions = healingActions.filter((action) => action.automatic && action.status === 'applied').length
    pendingReviews += healingActions.filter((action) => action.status === 'proposed' || action.status === 'blocked').length
    appendLifecycle(lifecycle, 'loop_completed', {
      loop: 'self_healing',
      status: healingActions.length > 0 ? 'evaluated' : 'unchanged',
      details: {
        evaluatedActions: healingActions.length,
        automaticHealingActions,
        pendingHealingReviews: healingActions.filter((action) => action.status === 'proposed' || action.status === 'blocked').length,
      },
    })
    actions.push(...healingActions.map((action) => ({
      type: 'self_healing_evaluated',
      actionId: action.id,
      healingType: action.type,
      target: action.target,
      status: action.status,
      automatic: action.automatic,
    })))

    if (options.generateScenarioDrafts) {
      appendLifecycle(lifecycle, 'loop_started', { loop: 'scenario_generation' })
      const coverage = new CoverageAnalysisService(this.sessionService)
      const gap = coverage.analyzeGaps()[0]
      if (gap) {
        const draft = coverage.createDraftFromGap(gap)
        scenarioDrafts += 1
        pendingReviews += draft.status === 'pending' ? 1 : 0
        actions.push({
          type: 'scenario_draft_generated',
          draftId: draft.id,
          scenarioId: draft.scenarioId,
          status: draft.status,
          gapType: draft.gapType,
        })
      }
      appendLifecycle(lifecycle, 'loop_completed', {
        loop: 'scenario_generation',
        status: scenarioDrafts > 0 ? 'generated' : 'unchanged',
        details: {
          generatedDrafts: scenarioDrafts,
        },
      })
    }

    appendLifecycle(lifecycle, 'loop_started', { loop: 'verification' })
    const after = Object.fromEntries(
      scenarios.map((scenarioId) => [scenarioId, this.buildScenarioSnapshot(scenarioId)]),
    )
    const comparisons = scenarios.map((scenarioId) => this.compareLatestSessions(scenarioId))
    const replayNeedsAttention = replayVerifications.some((verification) => verification.status !== 'passed')
    const rerunRequired = appliedMaterializations > 0 || automaticHealingActions > 0 || replayNeedsAttention
    appendLifecycle(lifecycle, 'independent_audit_started', {
      loop: 'verification',
      details: {
        queuedScenarios: scenarios.length,
        actions: actions.length,
      },
    })
    const independentAudit = this.verifyClosedLoopIndependently({
      lifecycle,
      scenarios,
      actions,
      pendingReviews,
      appliedMaterializations,
      automaticHealingActions,
      scenarioDrafts,
    })
    appendLifecycle(lifecycle, 'independent_audit_completed', {
      loop: 'verification',
      status: independentAudit.verdict,
      details: {
        auditedSessions: independentAudit.summary.auditedSessions,
        findings: independentAudit.summary.findings,
      },
    })
    const status = pendingReviews > 0 || independentAudit.verdict === 'failed' ? 'needs_review' : 'completed'
    appendLifecycle(lifecycle, 'loop_completed', {
      loop: 'verification',
      status,
      details: {
        comparisons: comparisons.length,
        rerunRequired,
        improvedScenarios: comparisons.filter((comparison) => comparison.verdict === 'improved').length,
        regressedScenarios: comparisons.filter((comparison) => comparison.verdict === 'regressed').length,
        independentAudit: independentAudit.verdict,
        independentFindings: independentAudit.summary.findings,
      },
    })
    appendLifecycle(lifecycle, 'closed_loop_completed', {
      status,
      details: {
        actionCount: actions.length,
        pendingReviews,
        rerunRequired,
      },
    })

    return this.record({
      status,
      mode: options.applyApprovedChanges ? 'apply_approved' : 'observe',
      scenarioId: options.scenarioId,
      queuedScenarios: scenarios,
      actions,
      verification: {
        comparisons,
        replayVerifications,
        rerunRequired,
        independentAudit,
        recommendation: buildClosedLoopRecommendation({ rerunRequired, independentAudit }),
      },
      summary: {
        statusReason: status === 'needs_review'
          ? 'Closed loop produced items or independent audit findings that require review before further automatic change.'
          : 'Closed loop completed without pending review items.',
        generatedProposals,
        appliedMaterializations,
        automaticHealingActions,
        scenarioDrafts,
        pendingReviews,
        retainedLearningSignals: this.sessionService.summarizeL5LearningSignals({
          scenarioId: options.scenarioId,
          limit: 500,
        }).retained,
        l5PolicyReplayVerifications: replayVerifications.length,
        l5PolicyReplayPassed: replayVerifications.filter((verification) => verification.status === 'passed').length,
        l5PolicyReplayNeedsReview: replayVerifications.filter((verification) => verification.status !== 'passed').length,
        l5PolicyReplayRequired: queue.some((item) => item.l5SignalPolicy.requiresReplay),
        l5PolicyIndependentAuditRequired: queue.some((item) => item.l5SignalPolicy.requiresIndependentAudit),
        l5PolicyMaxRiskModifier: Math.max(0, ...queue.map((item) => item.l5SignalPolicy.riskModifier)),
        independentAuditVerdict: independentAudit.verdict,
        independentAuditFindings: independentAudit.summary.findings,
        independentAuditedSessions: independentAudit.summary.auditedSessions,
        improvedScenarios: comparisons.filter((comparison) => comparison.verdict === 'improved').length,
        regressedScenarios: comparisons.filter((comparison) => comparison.verdict === 'regressed').length,
      },
      metadata: {
        actor,
        guards,
        queue,
        learningSignals,
        before,
        after,
        lifecycle,
        executionContext: summarizeExecutionContext(options.executionContext),
      },
      startedAt,
    })
  }

  private verifyClosedLoopIndependently(input: {
    lifecycle: L5LifecycleEvent[]
    scenarios: string[]
    actions: Record<string, unknown>[]
    pendingReviews: number
    appliedMaterializations: number
    automaticHealingActions: number
    scenarioDrafts: number
  }): L5IndependentLoopVerification {
    const auditor = new IndependentAuditorService()
    const findings: AuditorFinding[] = []
    const sessionAudits: AuditorEvaluation[] = []

    for (const scenarioId of input.scenarios) {
      const latest = this.findLatestFinalSession(scenarioId)
      if (!latest) {
        findings.push(warningFinding('closed_loop_terminal_session_missing', 'No terminal session is available for independent scenario audit.', {
          scenarioId,
        }))
        continue
      }
      sessionAudits.push(auditor.evaluateSession(latest))
    }

    const lifecycleFindings = auditClosedLoopLifecycle(input.lifecycle, input.scenarios)
    const sessionFindings = sessionAudits.flatMap((audit) => audit.findings.map((finding) => ({
      ...finding,
      evidence: {
        ...finding.evidence,
        sessionId: audit.sessionId,
      },
    })))
    const allFindings = [...findings, ...lifecycleFindings, ...sessionFindings]
    const failedSessionAudits = sessionAudits.filter((audit) => audit.verdict === 'failed').length
    const warningSessionAudits = sessionAudits.filter((audit) => audit.verdict === 'warning').length
    const hasErrors = allFindings.some((finding) => finding.severity === 'error') || failedSessionAudits > 0
    const hasWarnings = allFindings.length > 0 || warningSessionAudits > 0

    return {
      agentRole: 'auditor',
      verdict: hasErrors ? 'failed' : hasWarnings ? 'warning' : 'passed',
      checkedAt: new Date().toISOString(),
      sessionAudits,
      findings: allFindings,
      summary: {
        auditedSessions: sessionAudits.length,
        failedSessionAudits,
        warningSessionAudits,
        lifecycleFindings: lifecycleFindings.length,
        findings: allFindings.length,
        actionCount: input.actions.length,
        pendingReviews: input.pendingReviews,
        materializedChanges: input.appliedMaterializations + input.automaticHealingActions + input.scenarioDrafts,
      },
    }
  }

  private findLatestFinalSession(scenarioId: string): Session | undefined {
    return this.sessionService.getAllSessions()
      .filter((session) => session.scenarioId === scenarioId && (session.status === 'complete' || session.status === 'failed'))
      .sort((a, b) => new Date(b.completedAt ?? b.startedAt).getTime() - new Date(a.completedAt ?? a.startedAt).getTime())[0]
  }

  private selectQueue(scenarioId: string | undefined, maxScenarios: number): MetaOrchestrationQueueItem[] {
    const queue = new MetaOrchestrator(this.sessionService).buildGovernedRunQueue(scenarioId ? 50 : maxScenarios)
    if (!scenarioId) return queue.filter((item) => item.status === 'queued')
    return queue.filter((item) => item.status === 'queued' && item.scenarioId === scenarioId)
  }

  private buildScenarioSnapshot(scenarioId: string): ScenarioSnapshot {
    const sessions = this.sessionService.getAllSessions().filter((session) => session.scenarioId === scenarioId)
    const finalSessions = sessions.filter((session) => session.status === 'complete' || session.status === 'failed')
    const stepRecords = this.sessionService.listStepPerformance({ scenarioId, limit: 500 })
    const qualityGate = buildScenarioQualityGateForScenario(this.sessionService, scenarioId)

    return {
      scenarioId,
      finalSessions: finalSessions.length,
      completeSessions: finalSessions.filter((session) => session.status === 'complete').length,
      failedSessions: finalSessions.filter((session) => session.status === 'failed').length,
      stepExecutions: stepRecords.length,
      failedStepExecutions: stepRecords.filter((record) => !record.success).length,
      activeMaterializations: this.sessionService.listL5Materializations({ status: 'active', limit: 500 })
        .filter((materialization) => materialization.metadata?.['scenarioId'] === scenarioId)
        .length,
      retainedLearningSignals: this.sessionService.listL5LearningSignals({
        scenarioId,
        status: 'retained',
        limit: 500,
      }).length,
      pendingLearningProposals: this.sessionService.listLearningProposals({ scenarioId, status: 'proposed', limit: 500 }).length,
      approvedLearningProposals: this.sessionService.listLearningProposals({ scenarioId, status: 'approved', limit: 500 }).length,
      qualityGateStatus: qualityGate.status,
    }
  }

  private compareLatestSessions(scenarioId: string): SessionComparison {
    const finalSessions = this.sessionService.getAllSessions()
      .filter((session) => session.scenarioId === scenarioId && (session.status === 'complete' || session.status === 'failed'))
      .sort((a, b) => new Date(b.completedAt ?? b.startedAt).getTime() - new Date(a.completedAt ?? a.startedAt).getTime())

    const [latest, previous] = finalSessions
    if (!latest || !previous) {
      return {
        scenarioId,
        verdict: 'insufficient_history',
        latestSessionId: latest?.id,
        reason: 'At least two final sessions are required to compare improvement.',
      }
    }

    const latestScore = scoreSession(latest)
    const previousScore = scoreSession(previous)
    const scoreDelta = latestScore - previousScore
    const verdict = scoreDelta > 0 ? 'improved' : scoreDelta < 0 ? 'regressed' : 'unchanged'

    return {
      scenarioId,
      verdict,
      previousSessionId: previous.id,
      latestSessionId: latest.id,
      previousScore,
      latestScore,
      scoreDelta,
      reason: buildComparisonReason(verdict, scoreDelta),
    }
  }

  private record(input: Parameters<SessionService['recordL5ClosedLoopRun']>[0]): L5ClosedLoopRun {
    return this.sessionService.recordL5ClosedLoopRun({
      ...input,
      completedAt: new Date().toISOString(),
    })
  }

  private verifyL5PolicyReplay(item: MetaOrchestrationQueueItem, actor: string): L5PolicyReplayVerification {
    const checkedAt = new Date().toISOString()
    const latest = this.findLatestFinalSession(item.scenarioId)
    if (!latest) {
      return {
        scenarioId: item.scenarioId,
        status: 'skipped',
        checkedAt,
        policySignalIds: item.l5SignalPolicy.signalIds,
        reason: 'Replay required by L5 signal policy, but no terminal session is available to verify.',
      }
    }

    const audit = new IndependentAuditorService().evaluateSession(latest)
    const contractEvaluation = safeContractEvaluation(latest)
    const hardViolations = numberValue(contractEvaluation?.hardViolations)
    const driftSignals = numberValue(contractEvaluation?.driftSignals)
    const status: L5PolicyReplayStatus = latest.status !== 'complete' || audit.verdict === 'failed' || hardViolations > 0
      ? 'failed'
      : audit.verdict === 'warning' || driftSignals > 0
        ? 'warning'
        : 'passed'
    const signal = this.sessionService.recordL5LearningSignal({
      sourceType: 'closed_loop_replay',
      sourceId: `replay:${item.queueId}:${latest.id}`,
      signalType: 'replay_verified',
      scenarioId: item.scenarioId,
      version: `replay:${latest.id}:${latest.completedAt ?? latest.startedAt}:${status}`,
      confidence: status === 'passed' ? 0.9 : status === 'warning' ? 0.75 : 0.85,
      summary: buildReplaySignalSummary(status, latest.id),
      evidence: {
        replayStatus: status,
        sourceSessionId: latest.id,
        sessionStatus: latest.status,
        auditVerdict: audit.verdict,
        hardViolations,
        driftSignals,
        policySignalIds: item.l5SignalPolicy.signalIds,
        policyRiskModifier: item.l5SignalPolicy.riskModifier,
        checkedAt: audit.checkedAt,
      },
      metadata: {
        actor,
        queueId: item.queueId,
        policyRequiresReplay: item.l5SignalPolicy.requiresReplay,
      },
    })

    return {
      scenarioId: item.scenarioId,
      status,
      checkedAt,
      sourceSessionId: latest.id,
      signalId: signal.id,
      policySignalIds: item.l5SignalPolicy.signalIds,
      auditVerdict: audit.verdict,
      hardViolations,
      driftSignals,
      reason: buildReplayVerificationReason(status, latest.id, audit.verdict, hardViolations, driftSignals),
    }
  }
}

function isAutoMaterializableProposal(proposal: LearningProposal): boolean {
  return proposal.patchKind === 'prompt_overlay' || proposal.patchKind === 'none'
}

function scoreSession(session: Session): number {
  const evaluation = safeContractEvaluation(session)
  const contractPenalty = evaluation
    ? (evaluation.hardViolations * 10) + (evaluation.driftSignals * 5)
    : 0
  const statusScore = session.status === 'complete' ? 100 : 0
  return statusScore - contractPenalty - session.findings.length * 2
}

function safeContractEvaluation(session: Session): ReturnType<typeof buildContractEvaluation>['contractEvaluation'] {
  try {
    return buildContractEvaluation(session).contractEvaluation
  } catch {
    return null
  }
}

function buildComparisonReason(verdict: SessionComparison['verdict'], scoreDelta: number): string {
  if (verdict === 'improved') return `Latest run improved by ${scoreDelta} point(s).`
  if (verdict === 'regressed') return `Latest run regressed by ${Math.abs(scoreDelta)} point(s).`
  return 'Latest run score is unchanged.'
}

function buildClosedLoopRecommendation(input: {
  rerunRequired: boolean
  independentAudit: L5IndependentLoopVerification
}): string {
  if (input.independentAudit.verdict === 'failed') {
    return 'Review independent auditor findings before relying on this closed-loop iteration.'
  }

  if (input.rerunRequired) {
    return 'Reexecute affected scenarios to verify the materialized change.'
  }

  if (input.independentAudit.verdict === 'warning') {
    return 'Closed-loop iteration completed with non-blocking independent audit warnings.'
  }

  return 'No materialized change requires rerun in this iteration.'
}

function buildReplaySignalSummary(status: L5PolicyReplayStatus, sessionId: string): string {
  if (status === 'passed') return `Autonomous L5 replay verified session ${sessionId} as stable.`
  if (status === 'warning') return `Autonomous L5 replay found warnings in session ${sessionId}.`
  if (status === 'failed') return `Autonomous L5 replay found blocking evidence in session ${sessionId}.`
  return `Autonomous L5 replay skipped because no terminal session was available for ${sessionId}.`
}

function buildReplayVerificationReason(
  status: L5PolicyReplayStatus,
  sessionId: string,
  auditVerdict: AuditorVerdict,
  hardViolations: number,
  driftSignals: number,
): string {
  if (status === 'passed') {
    return `Latest terminal session ${sessionId} passed independent audit and contract replay checks.`
  }
  return [
    `Latest terminal session ${sessionId} replay status is ${status}.`,
    `audit=${auditVerdict}`,
    `hardViolations=${hardViolations}`,
    `driftSignals=${driftSignals}`,
  ].join(' ')
}

function auditClosedLoopLifecycle(lifecycle: L5LifecycleEvent[], scenarios: string[]): AuditorFinding[] {
  const findings: AuditorFinding[] = []
  const openLoops = new Map<string, number>()

  if (!lifecycle.some((event) => event.type === 'closed_loop_started')) {
    findings.push(errorFinding('closed_loop_started_missing', 'Closed-loop lifecycle is missing the start event.', {}))
  }

  for (const event of lifecycle) {
    if (event.loop === 'verification') continue
    if (event.type === 'loop_started') {
      const key = lifecycleLoopKey(event)
      openLoops.set(key, (openLoops.get(key) ?? 0) + 1)
      continue
    }

    if (event.type === 'loop_completed') {
      const key = lifecycleLoopKey(event)
      const count = openLoops.get(key) ?? 0
      if (count === 0) {
        findings.push(errorFinding('loop_completed_without_start', 'Closed-loop lifecycle has a completed loop without a matching start.', {
          loop: event.loop,
          scenarioId: event.scenarioId,
        }))
        continue
      }
      if (count === 1) {
        openLoops.delete(key)
      } else {
        openLoops.set(key, count - 1)
      }
    }
  }

  for (const [key, count] of openLoops) {
    findings.push(errorFinding('loop_started_without_completion', 'Closed-loop lifecycle has an unclosed loop.', {
      key,
      count,
    }))
  }

  for (const scenarioId of scenarios) {
    const started = lifecycle.some((event) => event.type === 'scenario_started' && event.scenarioId === scenarioId)
    const completed = lifecycle.some((event) => event.type === 'scenario_completed' && event.scenarioId === scenarioId)
    if (!started || !completed) {
      findings.push(errorFinding('scenario_lifecycle_unbalanced', 'Queued scenario lifecycle must include start and completion events.', {
        scenarioId,
        started,
        completed,
      }))
    }
  }

  return findings
}

function lifecycleLoopKey(event: L5LifecycleEvent): string {
  return `${event.loop ?? 'unknown_loop'}:${event.scenarioId ?? 'all'}`
}

function errorFinding(code: string, message: string, evidence: Record<string, unknown>): AuditorFinding {
  return { severity: 'error', code, message, evidence }
}

function warningFinding(code: string, message: string, evidence: Record<string, unknown>): AuditorFinding {
  return { severity: 'warning', code, message, evidence }
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function appendLifecycle(
  lifecycle: L5LifecycleEvent[],
  type: L5LifecycleEventType,
  event: Omit<L5LifecycleEvent, 'type' | 'timestamp'> = {},
): void {
  lifecycle.push({
    type,
    timestamp: new Date().toISOString(),
    ...event,
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
