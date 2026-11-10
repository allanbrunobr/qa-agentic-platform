import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Activity, AlertTriangle, ArrowRightLeft, Bot, Clock3, Play } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, StatCard } from '@/components/ui/Card'
import { MaturityStatusPanel } from '@/components/MaturityStatusPanel'
import { L5RunAuditPanel } from '@/components/L5RunAuditPanel'
import { DomainDiscoveryPanel } from '@/components/DomainDiscoveryPanel'
import {
  api,
  type Phase2ClosedLoopAuditBundle,
  type Phase2ClosedLoopRun,
  type Phase2ClosedLoopSchedulerStatus,
  type Phase2ClosedLoopStatusResponse,
  type Phase2DomainDiscoveryResponse,
  type Phase2ExecutionContext,
  type Phase2GovernanceDecision,
  type Phase2IndependentAuditReview,
  type Phase2IndependentAuditReviewQueueItem,
  type Phase2KnowledgePromotionCandidate,
  type Phase2KnowledgePromotionEvent,
  type Phase2L5LearningSignal,
  type Phase2MaturityStatus,
  type Phase2ScenarioSummary,
  type Phase2SessionSummary,
} from '@/lib/api'
import { formatDuration, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.06 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

function LoadingState() {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-[var(--text-muted)]">
      Loading...
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
      <p className="text-sm">No agentic sessions found.</p>
      <p className="text-xs">Run a live session to populate the dashboard.</p>
    </div>
  )
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: Array<{ value: number; name: string; color: string }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3 text-xs shadow-xl">
      <p className="mb-1.5 font-medium text-[var(--text-secondary)]">{label}</p>
      {payload.map(entry => (
        <div key={entry.name} className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: entry.color }} />
          <span className="text-[var(--text-muted)] capitalize">{entry.name}:</span>
          <span className="font-semibold text-[var(--text-primary)]">{entry.value}</span>
        </div>
      ))}
    </div>
  )
}

function scenarioLabel(session: Phase2SessionSummary) {
  return session.scenarioId.replace(/_/g, ' ')
}

function isMultiAgent(session: Phase2SessionSummary) {
  return session.scenarioId.includes('multi_role')
}

function parseOverviewHashScenario() {
  const hash = window.location.hash.replace(/^#/, '')
  const [page, query = ''] = hash.split('?')
  if (page !== 'overview') return null
  const params = new URLSearchParams(query)
  return params.get('scenario')
}

function writeOverviewHashScenario(selectedScenario: string) {
  const params = new URLSearchParams()
  if (selectedScenario) params.set('scenario', selectedScenario)
  const nextHash = params.toString() ? `#overview?${params.toString()}` : '#overview'
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, '', nextHash)
  }
}

export function Overview() {
  const initialScenarioFromHash = parseOverviewHashScenario()
  const [sessions, setSessions] = useState<Phase2SessionSummary[]>([])
  const [scenarios, setScenarios] = useState<Phase2ScenarioSummary[]>([])
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.getStats>> | null>(null)
  const [maturity, setMaturity] = useState<Phase2MaturityStatus | null>(null)
  const [domainDiscovery, setDomainDiscovery] = useState<Phase2DomainDiscoveryResponse | null>(null)
  const [closedLoop, setClosedLoop] = useState<Phase2ClosedLoopStatusResponse | null>(null)
  const [closedLoopScheduler, setClosedLoopScheduler] = useState<Phase2ClosedLoopSchedulerStatus | null>(null)
  const [governanceDecisions, setGovernanceDecisions] = useState<Phase2GovernanceDecision[]>([])
  const [selectedClosedLoopRunId, setSelectedClosedLoopRunId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedScenario, setSelectedScenario] = useState<string>(initialScenarioFromHash ?? '')
  const [targetBaseUrl, setTargetBaseUrl] = useState('')
  const [branchName, setBranchName] = useState('')
  const [prNumber, setPrNumber] = useState('')
  const [targetRepoPath, setTargetRepoPath] = useState('')
  const [frontendRepo, setFrontendRepo] = useState('')
  const [frontendRef, setFrontendRef] = useState('')
  const [backendRepo, setBackendRepo] = useState('')
  const [backendRef, setBackendRef] = useState('')
  const [startingRun, setStartingRun] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [workflowYaml, setWorkflowYaml] = useState<string>('')
  const [workflowLoading, setWorkflowLoading] = useState(false)
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  const [closedLoopRunning, setClosedLoopRunning] = useState(false)
  const [closedLoopError, setClosedLoopError] = useState<string | null>(null)
  const [closedLoopReplayRunId, setClosedLoopReplayRunId] = useState<string | null>(null)
  const [closedLoopReplay, setClosedLoopReplay] = useState<Phase2ClosedLoopAuditBundle['replay'] | null>(null)
  const [closedLoopPromotion, setClosedLoopPromotion] = useState<Phase2ClosedLoopAuditBundle['promotion'] | null>(null)
  const [closedLoopPromotionEvents, setClosedLoopPromotionEvents] = useState<Phase2KnowledgePromotionEvent[]>([])
  const [closedLoopAuditReviews, setClosedLoopAuditReviews] = useState<Phase2IndependentAuditReview[]>([])
  const [closedLoopAuditReviewQueue, setClosedLoopAuditReviewQueue] = useState<Phase2IndependentAuditReviewQueueItem[]>([])
  const [closedLoopLearningSignals, setClosedLoopLearningSignals] = useState<Phase2L5LearningSignal[]>([])
  const [closedLoopPromotionActionPendingId, setClosedLoopPromotionActionPendingId] = useState<string | null>(null)
  const [closedLoopPromotionActionError, setClosedLoopPromotionActionError] = useState<string | null>(null)
  const [closedLoopAuditReviewPendingRunId, setClosedLoopAuditReviewPendingRunId] = useState<string | null>(null)
  const [closedLoopAuditReviewError, setClosedLoopAuditReviewError] = useState<string | null>(null)
  const [closedLoopReplayLoading, setClosedLoopReplayLoading] = useState(false)
  const [closedLoopReplayError, setClosedLoopReplayError] = useState<string | null>(null)

  useEffect(() => {
    const syncFromHash = () => {
      const nextScenario = parseOverviewHashScenario()
      setSelectedScenario(nextScenario ?? '')
    }

    window.addEventListener('hashchange', syncFromHash)
    return () => window.removeEventListener('hashchange', syncFromHash)
  }, [])

  useEffect(() => {
    let mounted = true

    const load = async () => {
      try {
        const [
          sessionData,
          scenarioData,
          statsData,
          maturityData,
          domainDiscoveryData,
          closedLoopData,
          schedulerData,
          governanceData,
          auditReviewData,
          auditReviewQueueData,
          learningSignalData,
        ] = await Promise.all([
          api.getPhase2Sessions(),
          api.getPhase2Scenarios(),
          api.getStats(),
          api.getPhase2Maturity().catch(() => null),
          api.getPhase2DomainDiscovery().catch(() => null),
          api.getPhase2ClosedLoopStatus().catch(() => null),
          api.getPhase2ClosedLoopSchedulerStatus().catch(() => null),
          api.getPhase2GovernanceDecisions({ limit: 12 }).catch(() => []),
          api.getPhase2IndependentAuditReviews({ limit: 30 }).catch(() => []),
          api.getPhase2IndependentAuditReviewQueue({ limit: 12 }).catch(() => []),
          api.getPhase2L5LearningSignals({ limit: 12 }).catch(() => []),
        ])
        if (!mounted) return
        setSessions(sessionData)
        setScenarios(scenarioData)
        setStats(statsData)
        setMaturity(maturityData)
        setDomainDiscovery(domainDiscoveryData)
        setClosedLoop(closedLoopData)
        setClosedLoopScheduler(schedulerData)
        setGovernanceDecisions(governanceData)
        setClosedLoopAuditReviews(auditReviewData)
        setClosedLoopAuditReviewQueue(auditReviewQueueData)
        setClosedLoopLearningSignals(learningSignalData)
        setSelectedClosedLoopRunId((current) => {
          const recentRuns = closedLoopData?.recentRuns ?? []
          if (current && recentRuns.some((candidate) => candidate.id === current)) return current
          return closedLoopData?.latestRun?.id ?? recentRuns[0]?.id ?? null
        })
        if (scenarioData.length > 0 && !scenarioData.some((scenario) => scenario.id === selectedScenario)) {
          setSelectedScenario(scenarioData[0]!.id)
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }

    void load()
    const interval = window.setInterval(load, 8000)
    return () => {
      mounted = false
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    if (selectedScenario) {
      writeOverviewHashScenario(selectedScenario)
    }
  }, [selectedScenario])

  useEffect(() => {
    if (!selectedScenario || !scenarios.some((scenario) => scenario.id === selectedScenario)) {
      setWorkflowYaml('')
      setWorkflowError(null)
      return
    }

    let mounted = true
    setWorkflowLoading(true)
    setWorkflowError(null)

    void api.getPhase2ScenarioWorkflowContract(selectedScenario)
      .then((response) => {
        if (!mounted) return
        setWorkflowYaml(response.workflow_contract_yaml)
      })
      .catch((error) => {
        if (!mounted) return
        setWorkflowYaml('')
        const message = error instanceof Error ? error.message : 'Failed to load workflow contract'
        setWorkflowError(message.includes('404') ? 'This scenario does not have a workflow contract yet.' : message)
      })
      .finally(() => {
        if (mounted) setWorkflowLoading(false)
      })

    return () => {
      mounted = false
    }
  }, [selectedScenario, scenarios])

  const orderedSessions = useMemo(
    () => [...sessions].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    [sessions],
  )

  const completedSessions = orderedSessions.filter((session) => session.status === 'complete')
  const failedSessions = orderedSessions.filter((session) => session.status === 'failed')
  const runningSessions = orderedSessions.filter((session) => session.status === 'running' || session.status === 'pending')
  const multiAgentSessions = orderedSessions.filter(isMultiAgent)
  const totalFindings = orderedSessions.reduce((sum, session) => sum + session.findingCount, 0)
  const passRate = orderedSessions.length > 0
    ? Math.round((completedSessions.length / orderedSessions.length) * 100)
    : 0

  const averageDurationMs = completedSessions.reduce((sum, session) => {
    if (!session.completedAt) return sum
    return sum + (new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime())
  }, 0) / (completedSessions.length || 1)

  const trendData = orderedSessions.slice(0, 10).reverse().map((session, idx) => ({
    run: `S${idx + 1}`,
    complete: session.status === 'complete' ? 1 : 0,
    failed: session.status === 'failed' ? 1 : 0,
  }))

  const latestSessions = orderedSessions.slice(0, 5)
  const scenarioCoverage = Array.from(
    orderedSessions.reduce((acc, session) => {
      const current = acc.get(session.scenarioId) ?? { total: 0, complete: 0, failed: 0 }
      current.total += 1
      if (session.status === 'complete') current.complete += 1
      if (session.status === 'failed') current.failed += 1
      acc.set(session.scenarioId, current)
      return acc
    }, new Map<string, { total: number; complete: number; failed: number }>()),
  ).slice(0, 6)

  const contractSummary = stats?.agentic.contract_adherence ?? {
    violated: 0,
    drift: 0,
    compliant: 0,
    no_contract: 0,
    hard_violations: 0,
    drift_signals: 0,
  }
  const scenarioGateSummary = stats?.agentic.scenario_quality_gates ?? {
    open: 0,
    review_required: 0,
    restricted: 0,
  }
  const selectedScenarioSummary = scenarios.find((scenario) => scenario.id === selectedScenario)
  const selectedScenarioGate = selectedScenarioSummary?.quality_gate
  const latestClosedLoop = closedLoop?.latestRun ?? null
  const recentClosedLoopRuns = closedLoop?.recentRuns ?? []
  const selectedClosedLoopRun = selectedClosedLoopRunId
    ? recentClosedLoopRuns.find((candidate) => candidate.id === selectedClosedLoopRunId) ?? null
    : null
  const auditedClosedLoop = selectedClosedLoopRun ?? latestClosedLoop
  const activeReplayPreview = auditedClosedLoop?.id === closedLoopReplayRunId ? closedLoopReplay : null
  const activePromotionPreview = auditedClosedLoop?.id === closedLoopReplayRunId ? closedLoopPromotion : null
  const schedulerEnabled = closedLoopScheduler?.enabled ?? false

  useEffect(() => {
    setClosedLoopReplayRunId(null)
    setClosedLoopReplay(null)
    setClosedLoopPromotion(null)
    setClosedLoopPromotionEvents([])
    setClosedLoopReplayError(null)
    setClosedLoopPromotionActionError(null)
    setClosedLoopPromotionActionPendingId(null)
    setClosedLoopAuditReviewError(null)
    setClosedLoopAuditReviewPendingRunId(null)

    if (!auditedClosedLoop?.id) return
    let mounted = true
    void api.getPhase2KnowledgePromotionEvents({ sourceRunId: auditedClosedLoop.id, limit: 12 })
      .then((events) => {
        if (mounted) setClosedLoopPromotionEvents(events)
      })
      .catch(() => {
        if (mounted) setClosedLoopPromotionEvents([])
      })

    return () => {
      mounted = false
    }
  }, [auditedClosedLoop?.id])

  if (loading) return <LoadingState />

  const handleStartRun = async () => {
    if (!selectedScenario || startingRun) return
    if (selectedScenarioGate?.status === 'restricted') return
    setStartingRun(true)
    setStartError(null)
    try {
      const result = await api.startPhase2Run({
        scenario_id: selectedScenario,
        execution_context: buildExecutionContext({
          targetBaseUrl,
          branchName,
          prNumber,
          targetRepoPath,
          frontendRepo,
          frontendRef,
          backendRepo,
          backendRef,
        }),
      })
      window.location.hash = '#agentic-runs'
      window.dispatchEvent(new CustomEvent('agentic-run-started', { detail: result }))
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'Failed to start agentic session')
    } finally {
      setStartingRun(false)
    }
  }

  const handleClosedLoopRun = async (applyApprovedChanges: boolean) => {
    if (closedLoopRunning) return
    setClosedLoopRunning(true)
    setClosedLoopError(null)
    try {
      await api.runPhase2ClosedLoop({
        scenarioId: selectedScenario || undefined,
        maxScenarios: selectedScenario ? 1 : 3,
        applyApprovedChanges,
        executionContext: buildExecutionContext({
          targetBaseUrl,
          branchName,
          prNumber,
          targetRepoPath,
          frontendRepo,
          frontendRef,
          backendRepo,
          backendRef,
        }),
      })
      const [nextStatus, nextGovernance] = await Promise.all([
        api.getPhase2ClosedLoopStatus(),
        api.getPhase2GovernanceDecisions({ limit: 12 }).catch(() => governanceDecisions),
      ])
      setClosedLoop(nextStatus)
      setGovernanceDecisions(nextGovernance)
      setSelectedClosedLoopRunId(nextStatus.latestRun?.id ?? null)
    } catch (error) {
      setClosedLoopError(error instanceof Error ? error.message : 'Failed to run L5 closed loop')
    } finally {
      setClosedLoopRunning(false)
    }
  }

  const handleClosedLoopSchedulerStart = async () => {
    if (closedLoopRunning) return
    setClosedLoopRunning(true)
    setClosedLoopError(null)
    try {
      const scheduler = await api.startPhase2ClosedLoopScheduler({
        scenarioId: selectedScenario || undefined,
        maxScenarios: selectedScenario ? 1 : 3,
        applyApprovedChanges: false,
        executionContext: buildExecutionContext({
          targetBaseUrl,
          branchName,
          prNumber,
          targetRepoPath,
          frontendRepo,
          frontendRef,
          backendRepo,
          backendRef,
        }),
        intervalMs: 15 * 60 * 1000,
      })
      setClosedLoopScheduler(scheduler)
    } catch (error) {
      setClosedLoopError(error instanceof Error ? error.message : 'Failed to start L5 automation')
    } finally {
      setClosedLoopRunning(false)
    }
  }

  const handleClosedLoopSchedulerStop = async () => {
    if (closedLoopRunning) return
    setClosedLoopRunning(true)
    setClosedLoopError(null)
    try {
      const scheduler = await api.stopPhase2ClosedLoopScheduler()
      setClosedLoopScheduler(scheduler)
    } catch (error) {
      setClosedLoopError(error instanceof Error ? error.message : 'Failed to pause L5 automation')
    } finally {
      setClosedLoopRunning(false)
    }
  }

  const handleClosedLoopSchedulerTick = async () => {
    if (closedLoopRunning) return
    setClosedLoopRunning(true)
    setClosedLoopError(null)
    try {
      await api.tickPhase2ClosedLoopScheduler({
        scenarioId: selectedScenario || undefined,
        maxScenarios: selectedScenario ? 1 : 3,
        executionContext: buildExecutionContext({
          targetBaseUrl,
          branchName,
          prNumber,
          targetRepoPath,
          frontendRepo,
          frontendRef,
          backendRepo,
          backendRef,
        }),
      })
      const [nextStatus, nextScheduler] = await Promise.all([
        api.getPhase2ClosedLoopStatus(),
        api.getPhase2ClosedLoopSchedulerStatus(),
      ])
      const nextGovernance = await api.getPhase2GovernanceDecisions({ limit: 12 }).catch(() => governanceDecisions)
      setClosedLoop(nextStatus)
      setClosedLoopScheduler(nextScheduler)
      setGovernanceDecisions(nextGovernance)
      setSelectedClosedLoopRunId(nextStatus.latestRun?.id ?? null)
    } catch (error) {
      setClosedLoopError(error instanceof Error ? error.message : 'Failed to run L5 automation')
    } finally {
      setClosedLoopRunning(false)
    }
  }

  const handleLoadClosedLoopReplayPreview = async () => {
    if (!auditedClosedLoop || closedLoopReplayLoading) return
    setClosedLoopReplayLoading(true)
    setClosedLoopReplayError(null)
    try {
      const [bundle, promotionEvents] = await Promise.all([
        api.getPhase2ClosedLoopAuditBundle(auditedClosedLoop.id),
        api.getPhase2KnowledgePromotionEvents({ sourceRunId: auditedClosedLoop.id, limit: 12 }).catch(() => []),
      ])
      setClosedLoopReplayRunId(auditedClosedLoop.id)
      setClosedLoopReplay(bundle.replay)
      setClosedLoopPromotion(bundle.promotion)
      setClosedLoopPromotionEvents(promotionEvents)
    } catch (error) {
      setClosedLoopReplayError(error instanceof Error ? error.message : 'Failed to load L5 bundle')
    } finally {
      setClosedLoopReplayLoading(false)
    }
  }

  const handleClosedLoopPromotionAction = async (candidate: Phase2KnowledgePromotionCandidate) => {
    if (!auditedClosedLoop || closedLoopPromotionActionPendingId) return
    setClosedLoopPromotionActionPendingId(candidate.id)
    setClosedLoopPromotionActionError(null)
    try {
      await api.runPhase2KnowledgePromotionAction(candidate, { actor: 'dashboard' })
      const [bundle, nextStatus, nextGovernance, nextMaturity, nextPromotionEvents, nextLearningSignals] = await Promise.all([
        api.getPhase2ClosedLoopAuditBundle(auditedClosedLoop.id),
        api.getPhase2ClosedLoopStatus(),
        api.getPhase2GovernanceDecisions({ limit: 12 }).catch(() => governanceDecisions),
        api.getPhase2Maturity().catch(() => maturity),
        api.getPhase2KnowledgePromotionEvents({ sourceRunId: auditedClosedLoop.id, limit: 12 }).catch(() => closedLoopPromotionEvents),
        api.getPhase2L5LearningSignals({ limit: 12 }).catch(() => closedLoopLearningSignals),
      ])
      setClosedLoopReplayRunId(auditedClosedLoop.id)
      setClosedLoopReplay(bundle.replay)
      setClosedLoopPromotion(bundle.promotion)
      setClosedLoopPromotionEvents(nextPromotionEvents)
      setClosedLoop(nextStatus)
      setGovernanceDecisions(nextGovernance)
      setMaturity(nextMaturity)
      setClosedLoopLearningSignals(nextLearningSignals)
    } catch (error) {
      setClosedLoopPromotionActionError(error instanceof Error ? error.message : 'Failed to run governed L5 action')
    } finally {
      setClosedLoopPromotionActionPendingId(null)
    }
  }

  const handleReviewIndependentAudit = async (run: Phase2ClosedLoopRun, reason: string) => {
    if (closedLoopAuditReviewPendingRunId) return
    setClosedLoopAuditReviewPendingRunId(run.id)
    setClosedLoopAuditReviewError(null)
    try {
      await api.reviewPhase2IndependentAudit(run.id, {
        actor: 'dashboard',
        reason,
      })
      const [nextStatus, nextMaturity, nextReviews, nextReviewQueue, nextLearningSignals] = await Promise.all([
        api.getPhase2ClosedLoopStatus(),
        api.getPhase2Maturity().catch(() => maturity),
        api.getPhase2IndependentAuditReviews({ limit: 30 }).catch(() => closedLoopAuditReviews),
        api.getPhase2IndependentAuditReviewQueue({ limit: 12 }).catch(() => closedLoopAuditReviewQueue),
        api.getPhase2L5LearningSignals({ limit: 12 }).catch(() => closedLoopLearningSignals),
      ])
      setClosedLoop(nextStatus)
      setMaturity(nextMaturity)
      setClosedLoopAuditReviews(nextReviews)
      setClosedLoopAuditReviewQueue(nextReviewQueue)
      setClosedLoopLearningSignals(nextLearningSignals)
      setSelectedClosedLoopRunId(run.id)
    } catch (error) {
      setClosedLoopAuditReviewError(error instanceof Error ? error.message : 'Failed to record audit review')
    } finally {
      setClosedLoopAuditReviewPendingRunId(null)
    }
  }

  const handleClosedLoopSafeReplay = async () => {
    if (!activeReplayPreview || closedLoopReplayLoading || closedLoopRunning) return
    setClosedLoopReplayLoading(true)
    setClosedLoopRunning(true)
    setClosedLoopReplayError(null)
    setClosedLoopError(null)
    try {
      await api.runPhase2ClosedLoop(activeReplayPreview.safeReplayPayload)
      const [nextStatus, nextGovernance] = await Promise.all([
        api.getPhase2ClosedLoopStatus(),
        api.getPhase2GovernanceDecisions({ limit: 12 }).catch(() => governanceDecisions),
      ])
      setClosedLoop(nextStatus)
      setGovernanceDecisions(nextGovernance)
      setSelectedClosedLoopRunId(nextStatus.latestRun?.id ?? null)
      setClosedLoopReplayRunId(null)
      setClosedLoopReplay(null)
      setClosedLoopPromotion(null)
    } catch (error) {
      setClosedLoopReplayError(error instanceof Error ? error.message : 'Failed to run L5 safe replay')
    } finally {
      setClosedLoopReplayLoading(false)
      setClosedLoopRunning(false)
    }
  }

  return (
    <motion.div
      className="space-y-6 p-6"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <div className="grid grid-cols-4 gap-4">
        <motion.div variants={itemVariants}>
          <StatCard
            label="Agentic sessions"
            value={orderedSessions.length}
            sub={`${completedSessions.length} completed`}
            trend="up"
            trendValue={`${multiAgentSessions.length} multi-agent`}
            icon={<Activity className="h-4 w-4" />}
            accentColor="var(--accent)"
          />
        </motion.div>

        <motion.div variants={itemVariants}>
          <StatCard
            label="Completion rate"
            value={`${passRate}%`}
            sub={`${failedSessions.length} failed`}
            trend={passRate >= 60 ? 'up' : 'down'}
            trendValue={runningSessions.length > 0 ? `${runningSessions.length} running` : 'no backlog'}
            icon={<Bot className="h-4 w-4" />}
            accentColor="var(--success)"
          />
        </motion.div>

        <motion.div variants={itemVariants}>
          <StatCard
            label="Handoffs / multi-agent"
            value={multiAgentSessions.length}
            sub="sessions with multiple roles"
            trend="neutral"
            trendValue="persisted handoffs"
            icon={<ArrowRightLeft className="h-4 w-4" />}
            accentColor="var(--info)"
          />
        </motion.div>

        <motion.div variants={itemVariants}>
          <StatCard
            label="Agentic findings"
            value={totalFindings}
            sub={`${failedSessions.length} failed sessions`}
            trend={totalFindings > 0 ? 'down' : 'neutral'}
            trendValue={totalFindings > 0 ? 'needs review' : 'no findings'}
            icon={<AlertTriangle className="h-4 w-4" />}
            accentColor={totalFindings > 0 ? 'var(--danger)' : 'var(--warning)'}
          />
        </motion.div>
      </div>

      {maturity && (
        <motion.div variants={itemVariants}>
          <MaturityStatusPanel maturity={maturity} />
        </motion.div>
      )}

      <motion.div variants={itemVariants}>
        <DomainDiscoveryPanel
          discovery={domainDiscovery}
          onCreateScenarioDraft={api.createPhase2DomainDiscoveryScenarioDraft}
        />
      </motion.div>

      <motion.div variants={itemVariants}>
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">L5 closed loop</h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Learning, governed apply, and before/after verification per scenario.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                loading={closedLoopRunning}
                onClick={() => void handleClosedLoopRun(false)}
              >
                Analyze
              </Button>
              <Button
                variant="primary"
                loading={closedLoopRunning}
                onClick={() => void handleClosedLoopRun(true)}
              >
                Apply approved
              </Button>
              <Button
                variant="secondary"
                loading={closedLoopRunning}
                onClick={() => void handleClosedLoopSchedulerTick()}
              >
                Run now
              </Button>
              <Button
                variant={schedulerEnabled ? 'secondary' : 'primary'}
                loading={closedLoopRunning}
                onClick={() => {
                  if (schedulerEnabled) {
                    void handleClosedLoopSchedulerStop()
                  } else {
                    void handleClosedLoopSchedulerStart()
                  }
                }}
              >
                {schedulerEnabled ? 'Pause auto' : 'Start auto'}
              </Button>
            </div>
          </div>

          <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Execution context
            </p>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Target base URL</span>
                <input
                  value={targetBaseUrl}
                  onChange={(event) => setTargetBaseUrl(event.target.value)}
                  placeholder="https://preview.example.com"
                  className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Branch name</span>
                <input
                  value={branchName}
                  onChange={(event) => setBranchName(event.target.value)}
                  placeholder="feature/LABS-1031"
                  className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">PR number</span>
                <input
                  value={prNumber}
                  onChange={(event) => setPrNumber(event.target.value)}
                  placeholder="1031"
                  className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Target repo path</span>
                <input
                  value={targetRepoPath}
                  onChange={(event) => setTargetRepoPath(event.target.value)}
                  placeholder="/workspace/frontend-pr-preview"
                  className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Frontend repo</span>
                <input
                  value={frontendRepo}
                  onChange={(event) => setFrontendRepo(event.target.value)}
                  placeholder="org/frontend"
                  className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Frontend ref</span>
                <input
                  value={frontendRef}
                  onChange={(event) => setFrontendRef(event.target.value)}
                  placeholder="feature/LABS-1031"
                  className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Backend repo</span>
                <input
                  value={backendRepo}
                  onChange={(event) => setBackendRepo(event.target.value)}
                  placeholder="org/backend"
                  className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Backend ref</span>
                <input
                  value={backendRef}
                  onChange={(event) => setBackendRef(event.target.value)}
                  placeholder="feature/API-204"
                  className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:outline-none"
                />
              </label>
            </div>
            {latestClosedLoop?.metadata?.executionContext && (
              <p className="mt-3 text-xs text-[var(--text-muted)]">
                Last run context: {String(latestClosedLoop.metadata.executionContext['targetBaseUrl'] ?? latestClosedLoop.metadata.executionContext['branchName'] ?? latestClosedLoop.metadata.executionContext['source'] ?? 'custom')}
              </p>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-6">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Last iteration</p>
              <p className="mt-1 text-lg font-semibold text-[var(--text-primary)]">
                {latestClosedLoop?.status?.replace('_', ' ') ?? 'not run'}
              </p>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Queued scenarios</p>
              <p className="mt-1 text-lg font-semibold text-[var(--text-primary)]">
                {closedLoop?.queue.filter((item) => item.status === 'queued').length ?? 0}
              </p>
              <p className="mt-1 truncate text-xs text-[var(--text-muted)]">
                L5 replay {closedLoop?.queue.filter((item) => item.l5SignalPolicy.requiresReplay).length ?? 0}
              </p>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Actions</p>
              <p className="mt-1 text-lg font-semibold text-[var(--text-primary)]">
                {latestClosedLoop?.actions.length ?? 0}
              </p>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Lifecycle</p>
              <p className="mt-1 text-lg font-semibold text-[var(--text-primary)]">
                {latestClosedLoop?.metadata?.lifecycle?.length ?? 0}
              </p>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Rerun</p>
              <p className="mt-1 text-lg font-semibold text-[var(--text-primary)]">
                {latestClosedLoop?.verification?.rerunRequired ? 'required' : 'not required'}
              </p>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Automation</p>
              <p className="mt-1 text-lg font-semibold text-[var(--text-primary)]">
                {schedulerEnabled ? 'active' : 'paused'}
              </p>
              <p className="mt-1 truncate text-xs text-[var(--text-muted)]">
                {closedLoopScheduler?.nextTickAt ? `next ${formatRelativeTime(closedLoopScheduler.nextTickAt)}` : 'not scheduled'}
              </p>
            </div>
          </div>

          {latestClosedLoop ? (
            <p className="mt-4 text-xs text-[var(--text-muted)]">
              {String(latestClosedLoop.summary.statusReason ?? 'L5 iteration recorded.')}
            </p>
          ) : null}

          {closedLoopError && (
            <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {closedLoopError}
            </div>
          )}

        </Card>
      </motion.div>

      <motion.div variants={itemVariants}>
        <L5RunAuditPanel
          run={auditedClosedLoop}
          runs={recentClosedLoopRuns}
          selectedRunId={auditedClosedLoop?.id ?? selectedClosedLoopRunId}
          onSelectRun={setSelectedClosedLoopRunId}
          auditBundleUrl={auditedClosedLoop ? api.getPhase2ClosedLoopAuditBundleUrl(auditedClosedLoop.id) : undefined}
          replayPreview={activeReplayPreview}
          promotionPreview={activePromotionPreview}
          promotionEvents={closedLoopPromotionEvents}
          auditReviews={closedLoopAuditReviews}
          auditReviewQueue={closedLoopAuditReviewQueue}
          learningSignals={closedLoopLearningSignals}
          promotionActionPendingId={closedLoopPromotionActionPendingId}
          promotionActionError={closedLoopPromotionActionError}
          auditReviewPendingRunId={closedLoopAuditReviewPendingRunId}
          auditReviewError={closedLoopAuditReviewError}
          replayLoading={closedLoopReplayLoading}
          replayError={closedLoopReplayError}
          onLoadReplayPreview={() => void handleLoadClosedLoopReplayPreview()}
          onRunSafeReplay={() => void handleClosedLoopSafeReplay()}
          onRunPromotionAction={(candidate) => void handleClosedLoopPromotionAction(candidate)}
          onReviewIndependentAudit={(run, reason) => void handleReviewIndependentAudit(run, reason)}
          guards={closedLoop?.guards ?? []}
          governanceDecisions={governanceDecisions}
        />
      </motion.div>

      <motion.div variants={itemVariants}>
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Contract adherence</h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Agentic sessions summarized by workflow contract verdict.
              </p>
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              {orderedSessions.length} visible sessions
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-red-200">Violated</p>
              <p className="mt-1 text-2xl font-semibold text-red-300">{contractSummary.violated}</p>
            </div>
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-amber-200">Drift</p>
              <p className="mt-1 text-2xl font-semibold text-amber-300">{contractSummary.drift}</p>
            </div>
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-emerald-200">Compliant</p>
              <p className="mt-1 text-2xl font-semibold text-emerald-300">{contractSummary.compliant}</p>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">No contract</p>
              <p className="mt-1 text-2xl font-semibold text-[var(--text-primary)]">{contractSummary.no_contract}</p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--text-muted)]">
            <span className="rounded-md border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-red-200">
              {contractSummary.hard_violations} hard violations
            </span>
            <span className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-amber-200">
              {contractSummary.drift_signals} drift signals
            </span>
          </div>
        </Card>
      </motion.div>

      <motion.div variants={itemVariants}>
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Scenario quality gates</h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Automatic governance based on recent contract history per scenario.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-emerald-300">
              open {scenarioGateSummary.open}
            </span>
            <span className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-amber-300">
              review required {scenarioGateSummary.review_required}
            </span>
            <span className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-red-300">
              restricted {scenarioGateSummary.restricted}
            </span>
          </div>
        </Card>
      </motion.div>

      <motion.div variants={itemVariants}>
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Agentic session trend</h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Completions and failures across recent agentic sessions.
              </p>
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              Last activity {orderedSessions[0] ? formatRelativeTime(orderedSessions[0].startedAt) : 'no activity yet'}
            </div>
          </div>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="agenticComplete" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#14b8a6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="agenticFailed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="run" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="complete" stroke="#14b8a6" strokeWidth={2} fill="url(#agenticComplete)" />
                <Area type="monotone" dataKey="failed" stroke="#ef4444" strokeWidth={2} fill="url(#agenticFailed)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </motion.div>

      <motion.div variants={itemVariants}>
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Workflow contract</h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Deterministic spec for the selected scenario.
              </p>
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              {selectedScenario || 'No scenario selected'}
            </div>
          </div>

          <div className="mb-4">
            <label className="mb-2 block text-xs uppercase tracking-wide text-[var(--text-muted)]">Scenario</label>
            <select
              value={selectedScenario}
              onChange={(event) => setSelectedScenario(event.target.value)}
              className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] focus:border-[var(--accent)]/50 focus:outline-none"
            >
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.name}
                </option>
              ))}
            </select>
          </div>

          {selectedScenarioGate ? (
            <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs uppercase tracking-wide text-[var(--text-muted)]">quality gate</span>
                <span
                  className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                    selectedScenarioGate.status === 'restricted'
                      ? 'border border-red-500/20 bg-red-500/10 text-red-300'
                      : selectedScenarioGate.status === 'review_required'
                        ? 'border border-amber-500/20 bg-amber-500/10 text-amber-300'
                        : 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
                  }`}
                >
                  {selectedScenarioGate.status.replace('_', ' ')}
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  {selectedScenarioGate.recentViolated} violated / {selectedScenarioGate.recentDrift} drift
                </span>
              </div>
              <p className="mt-2 text-xs text-[var(--text-muted)]">{selectedScenarioGate.reason}</p>
            </div>
          ) : null}

          {workflowLoading ? (
            <div className="text-sm text-[var(--text-muted)]">Loading workflow contract...</div>
          ) : workflowError ? (
            <div className="text-sm text-red-300">{workflowError}</div>
          ) : (
            <pre className="max-h-96 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4 text-xs text-[var(--text-secondary)]">
              {workflowYaml}
            </pre>
          )}
        </Card>
      </motion.div>

      <motion.div variants={itemVariants}>
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Start agentic session</h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Start a new live session directly from the dashboard.
              </p>
            </div>
          </div>

          <div className="flex justify-end">
            <div className="flex items-end">
              <Button
                variant="primary"
                icon={<Play className="h-3.5 w-3.5" />}
                loading={startingRun}
                onClick={handleStartRun}
                disabled={selectedScenarioGate?.status === 'restricted'}
              >
                {selectedScenarioGate?.status === 'restricted' ? 'Scenario restricted' : 'Start session'}
              </Button>
            </div>
          </div>

          {targetBaseUrl || branchName || prNumber || targetRepoPath || frontendRepo || backendRepo ? (
            <p className="mt-3 text-xs text-[var(--text-muted)]">
              Run context will target {targetBaseUrl || 'default local base URL'}{branchName ? `, branch ${branchName}` : ''}{prNumber ? `, PR #${prNumber}` : ''}{frontendRef ? `, frontend ${frontendRef}` : ''}{backendRef ? `, backend ${backendRef}` : ''}{targetRepoPath ? `, repo ${targetRepoPath}` : ''}.
            </p>
          ) : null}

          {startError && (
            <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {startError}
            </div>
          )}
        </Card>
      </motion.div>

      <div className="grid grid-cols-5 gap-4">
        <motion.div variants={itemVariants} className="col-span-3">
          <Card className="h-full">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Recent agentic sessions</h2>
              <span className="text-xs text-[var(--text-muted)]">
                avg duration {completedSessions.length > 0 ? formatDuration(Math.round(averageDurationMs / 1000)) : '0s'}
              </span>
            </div>
            {latestSessions.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="space-y-3">
                {latestSessions.map((session) => (
                  <div key={session.id} className="rounded-lg bg-[var(--bg-primary)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[var(--text-primary)]">{scenarioLabel(session)}</p>
                        <p className="mt-1 text-xs text-[var(--text-muted)]">{formatRelativeTime(session.startedAt)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] uppercase text-[var(--text-secondary)]">
                          {isMultiAgent(session) ? 'multi-agent' : 'single-agent'}
                        </span>
                        <span className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] uppercase text-[var(--text-secondary)]">
                          {session.status}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-4 gap-2 text-xs text-[var(--text-muted)]">
                      <span>{session.eventCount} events</span>
                      <span>{session.artifactCount} artifacts</span>
                      <span>{session.findingCount} findings</span>
                      <span>
                        {session.completedAt
                          ? formatDuration(Math.round((new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()) / 1000))
                          : 'running'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </motion.div>

        <motion.div variants={itemVariants} className="col-span-2">
          <Card className="h-full">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Scenario coverage</h2>
              <Clock3 className="h-4 w-4 text-[var(--text-muted)]" />
            </div>
            {scenarioCoverage.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-[var(--text-muted)]">
                No agentic coverage recorded.
              </div>
            ) : (
              <div className="space-y-3">
                {scenarioCoverage.map(([scenarioId, summary]) => (
                  <div key={scenarioId} className="rounded-lg bg-[var(--bg-primary)] p-4">
                    <p className="text-sm font-semibold text-[var(--text-primary)]">{scenarioId.replace(/_/g, ' ')}</p>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                      <div>
                        <p className="text-lg font-semibold text-[var(--text-primary)]">{summary.total}</p>
                        <p className="text-[var(--text-muted)]">runs</p>
                      </div>
                      <div>
                        <p className="text-lg font-semibold text-green-300">{summary.complete}</p>
                        <p className="text-[var(--text-muted)]">ok</p>
                      </div>
                      <div>
                        <p className="text-lg font-semibold text-red-300">{summary.failed}</p>
                        <p className="text-[var(--text-muted)]">fail</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </motion.div>
      </div>
    </motion.div>
  )
}

function buildExecutionContext(input: {
  targetBaseUrl: string
  branchName: string
  prNumber: string
  targetRepoPath: string
  frontendRepo: string
  frontendRef: string
  backendRepo: string
  backendRef: string
}): Phase2ExecutionContext | undefined {
  const targetBaseUrl = input.targetBaseUrl.trim()
  const branchName = input.branchName.trim()
  const prNumber = input.prNumber.trim()
  const targetRepoPath = input.targetRepoPath.trim()
  const frontendRepo = input.frontendRepo.trim()
  const frontendRef = input.frontendRef.trim()
  const backendRepo = input.backendRepo.trim()
  const backendRef = input.backendRef.trim()

  const previewTargets = [
    frontendRepo || frontendRef
      ? {
        role: 'frontend',
        repo: frontendRepo || undefined,
        ref: frontendRef || undefined,
        url: targetBaseUrl || undefined,
      }
      : null,
    backendRepo || backendRef
      ? {
        role: 'backend',
        repo: backendRepo || undefined,
        ref: backendRef || undefined,
      }
      : null,
  ].filter((target): target is NonNullable<typeof target> => Boolean(target))

  if (!targetBaseUrl && !branchName && !prNumber && !targetRepoPath && previewTargets.length === 0) return undefined

  return {
    source: previewTargets.length > 0 ? 'pr_preview' : 'custom',
    branchName: branchName || undefined,
    prNumber: prNumber ? Number(prNumber) : undefined,
    targetBaseUrl: targetBaseUrl || undefined,
    targetRepoPath: targetRepoPath || undefined,
    previewTargets,
  }
}
