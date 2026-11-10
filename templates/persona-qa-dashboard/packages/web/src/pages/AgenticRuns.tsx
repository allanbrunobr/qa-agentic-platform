import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Bot, CheckCircle2, Clock3, MessageSquareText, Play, Wrench, XCircle } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { api, type Phase2ScenarioSummary, type Phase2SessionArtifact, type Phase2SessionDetail, type Phase2SessionEvent, type Phase2SessionFinding, type Phase2SessionSummary, type Phase2WorkflowContractResponse } from '@/lib/api'
import { cn, formatDuration, formatRelativeTime } from '@/lib/utils'

type AgenticStatus = Phase2SessionSummary['status']
type RunsView = 'current' | 'history'
type SessionFilter = 'all' | 'single' | 'multi'
type ContractFilter = 'all' | 'contract_compliant' | 'contract_drift' | 'contract_violated' | 'contract_evaluating'
type SortMode = 'recent' | 'contract_severity'
type SessionWindow = 'all' | '10' | '20'
type HandoffFilter = 'all' | 'proposed' | 'accepted' | 'rejected'

function parseAgenticRunsHash() {
  const hash = window.location.hash.replace(/^#/, '')
  const [page, query = ''] = hash.split('?')
  if (page !== 'agentic-runs') return null

  const params = new URLSearchParams(query)
  const tab = params.get('tab')
  const sessionFilter = params.get('sessionFilter')
  const contractFilter = params.get('contractFilter')
  const sortMode = params.get('sortMode')
  const sessionWindow = params.get('sessionWindow')
  const agentFilter = params.get('agentFilter')
  const handoffFilter = params.get('handoffFilter')
  const selectedId = params.get('selectedId')

  return {
    tab: tab === 'current' || tab === 'history' ? (tab as RunsView) : null,
    selectedId,
    sessionFilter: sessionFilter === 'all' || sessionFilter === 'single' || sessionFilter === 'multi'
      ? (sessionFilter as SessionFilter)
      : null,
    contractFilter:
      contractFilter === 'all' ||
      contractFilter === 'contract_evaluating' ||
      contractFilter === 'contract_compliant' ||
      contractFilter === 'contract_drift' ||
      contractFilter === 'contract_violated'
        ? (contractFilter as ContractFilter)
        : null,
    sortMode: sortMode === 'recent' || sortMode === 'contract_severity' ? (sortMode as SortMode) : null,
    sessionWindow: sessionWindow === 'all' || sessionWindow === '10' || sessionWindow === '20'
      ? (sessionWindow as SessionWindow)
      : null,
    agentFilter,
    handoffFilter:
      handoffFilter === 'all' || handoffFilter === 'proposed' || handoffFilter === 'accepted' || handoffFilter === 'rejected'
        ? (handoffFilter as HandoffFilter)
        : null,
  }
}

function writeAgenticRunsHash(state: {
  tab: RunsView
  selectedId: string | null
  sessionFilter: SessionFilter
  contractFilter: ContractFilter
  sortMode: SortMode
  sessionWindow: SessionWindow
  agentFilter: string
  handoffFilter: HandoffFilter
}) {
  const params = new URLSearchParams()
  if (state.tab === 'history') params.set('tab', 'history')
  if (state.tab === 'history' && state.selectedId) params.set('selectedId', state.selectedId)
  if (state.tab === 'history' && state.sessionFilter !== 'all') params.set('sessionFilter', state.sessionFilter)
  if (state.tab === 'history' && state.contractFilter !== 'all') params.set('contractFilter', state.contractFilter)
  if (state.tab === 'history' && state.sortMode !== 'recent') params.set('sortMode', state.sortMode)
  if (state.tab === 'history' && state.sessionWindow !== 'all') params.set('sessionWindow', state.sessionWindow)
  if (state.agentFilter !== 'all') params.set('agentFilter', state.agentFilter)
  if (state.handoffFilter !== 'all') params.set('handoffFilter', state.handoffFilter)
  const nextHash = params.toString() ? `#agentic-runs?${params.toString()}` : '#agentic-runs'
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, '', nextHash)
  }
}

function contractVerdictClasses(verdict: Phase2SessionSummary['contractVerdict']) {
  switch (verdict) {
    case 'contract_evaluating':
      return 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
    case 'contract_compliant':
      return 'border-green-500/30 bg-green-500/10 text-green-300'
    case 'contract_drift':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-300'
    case 'contract_violated':
      return 'border-red-500/30 bg-red-500/10 text-red-300'
    default:
      return 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300'
  }
}

function formatContractVerdict(verdict: Phase2SessionSummary['contractVerdict']) {
  return verdict ? verdict.replace(/^contract_/, '').replace(/_/g, ' ') : 'no contract'
}

function statusClasses(status: AgenticStatus) {
  switch (status) {
    case 'complete':
      return 'border-green-500/30 bg-green-500/10 text-green-300'
    case 'failed':
      return 'border-red-500/30 bg-red-500/10 text-red-300'
    case 'running':
      return 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
    default:
      return 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300'
  }
}

function agentColor(agentId: string) {
  if (agentId.includes('sales')) return 'border-sky-500/30 bg-sky-500/10 text-sky-300'
  if (agentId.includes('fulfill')) return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
  if (agentId.includes('billing')) return 'border-violet-500/30 bg-violet-500/10 text-violet-300'
  if (agentId.includes('manager')) return 'border-amber-500/30 bg-amber-500/10 text-amber-300'
  return 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300'
}

function formatAgentName(agentId: string) {
  return agentId
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function eventPayload(event: Phase2SessionEvent) {
  return (event.payload ?? event.data ?? {}) as Record<string, unknown>
}

function deriveObservedToolsByStep(events: Phase2SessionEvent[]): Record<string, string[]> {
  const toolsByStep = new Map<string, string[]>()
  let activeStepId: string | null = null

  for (const event of events) {
    const payload = eventPayload(event)

    if (event.type === 'step_started') {
      activeStepId = typeof payload.stepId === 'string' ? payload.stepId : null
      continue
    }

    if (event.type === 'tool_call' && activeStepId) {
      const toolName = typeof payload.toolName === 'string' ? payload.toolName : null
      if (!toolName) continue
      const current = toolsByStep.get(activeStepId) ?? []
      current.push(toolName)
      toolsByStep.set(activeStepId, current)
      continue
    }

    if (
      event.type === 'step_completed' ||
      event.type === 'step_failed'
    ) {
      activeStepId = null
    }
  }

  return Object.fromEntries(Array.from(toolsByStep.entries()))
}

function capabilityMatchesObservedTools(capabilityId: string, observedTools: string[]): boolean {
  if (observedTools.includes(capabilityId)) return true

  const compositeCapabilityMap: Record<string, string[]> = {
    validateManagementClosure: ['verifyFinanceDashboard', 'verifyReportsPage'],
  }

  const compositeTools = compositeCapabilityMap[capabilityId]
  if (!compositeTools) return false

  return compositeTools.every((tool) => observedTools.includes(tool))
}

function getEventArtifactId(event: Phase2SessionEvent): string | null {
  const payload = eventPayload(event)
  if (typeof payload.artifactId === 'string') return payload.artifactId
  if (payload.output && typeof payload.output === 'object') {
    const artifactId = (payload.output as Record<string, unknown>).artifactId
    if (typeof artifactId === 'string' || typeof artifactId === 'number') return String(artifactId)
  }
  return null
}

function ScreenshotModal({
  src,
  alt,
  onClose,
}: {
  src: string
  alt: string
  onClose: () => void
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="relative max-h-[90vh] max-w-[92vw]"
        onClick={(event) => event.stopPropagation()}
      >
        <img
          src={src}
          alt={alt}
          className="max-h-[88vh] max-w-full rounded-xl border border-[var(--border)] shadow-2xl"
        />
      </motion.div>
    </motion.div>
  )
}

export function summarizeConversationEvent(event: Phase2SessionEvent): { title: string; body: string } | null {
  const payload = eventPayload(event)

  // A finding the runtime refused in the response that ended its step: the agent never saw the
  // refusal, so this is the only place the finding shows up.
  if (event.type === 'error' && payload.event === 'finding_refused_at_step_end') {
    return {
      title: `Finding not recorded: ${String(payload.title ?? 'untitled')}`,
      body: JSON.stringify(payload, null, 2),
    }
  }

  if (event.type === 'tool_call') {
    return {
      title: `Called ${String(payload.toolName ?? 'tool')}`,
      body: JSON.stringify(payload.input ?? {}, null, 2),
    }
  }

  if (event.type === 'tool_result') {
    return {
      title: `${String(payload.toolName ?? 'tool')} ${payload.ok ? 'succeeded' : 'failed'}`,
      body: JSON.stringify(payload.ok ? payload.output ?? {} : payload.error ?? {}, null, 2),
    }
  }

  if (event.type === 'handoff_emitted' || event.type === 'handoff_accepted' || event.type === 'handoff_rejected') {
    return {
      title: event.type.replace(/_/g, ' '),
      body: JSON.stringify(payload, null, 2),
    }
  }

  if (event.type === 'step_started' || event.type === 'step_completed' || event.type === 'step_failed') {
    return {
      title: event.type.replace(/_/g, ' '),
      body: JSON.stringify(payload, null, 2),
    }
  }

  return null
}

function HandoffBoard({ events }: { events: Phase2SessionEvent[] }) {
  const handoffs = events.filter((event) =>
    event.type === 'handoff_emitted' ||
    event.type === 'handoff_accepted' ||
    event.type === 'handoff_rejected',
  )

  if (handoffs.length === 0) {
    return (
      <Card>
        <p className="text-sm text-[var(--text-muted)]">
          No handoffs recorded in this session.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {handoffs.map((event) => {
        const payload = eventPayload(event)
        const fromAgent = String(payload.fromAgentId ?? payload.agentId ?? 'orchestrator')
        const toAgent = String(payload.toAgentId ?? payload.nextAgentId ?? 'unknown')
        const requiredArtifacts = Array.isArray(payload.requiredArtifacts)
          ? payload.requiredArtifacts.map(String)
          : []
        const statusLabel =
          event.type === 'handoff_accepted'
            ? 'Accepted'
            : event.type === 'handoff_rejected'
              ? 'Rejected'
              : 'Proposed'

        return (
          <Card key={event.id} className="space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <MessageSquareText className="h-4 w-4" />
                <span>{formatRelativeTime(event.timestamp)}</span>
              </div>
              <span className={cn('rounded-md border px-2 py-1 text-xs font-semibold', statusClasses(
                event.type === 'handoff_rejected' ? 'failed' : event.type === 'handoff_accepted' ? 'complete' : 'running',
              ))}>
                {statusLabel}
              </span>
            </div>

            <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-center">
              <div className={cn('rounded-lg border px-4 py-3', agentColor(fromAgent))}>
                <div className="flex items-center gap-2 text-xs uppercase tracking-wide opacity-80">
                  <Bot className="h-3.5 w-3.5" />
                  Sender
                </div>
                <p className="mt-2 text-sm font-semibold">{formatAgentName(fromAgent)}</p>
              </div>

              <div className="flex items-center justify-center">
                <ArrowRight className="h-5 w-5 text-[var(--text-muted)]" />
              </div>

              <div className={cn('rounded-lg border px-4 py-3', agentColor(toAgent))}>
                <div className="flex items-center gap-2 text-xs uppercase tracking-wide opacity-80">
                  <Bot className="h-3.5 w-3.5" />
                  Receiver
                </div>
                <p className="mt-2 text-sm font-semibold">{formatAgentName(toAgent)}</p>
              </div>
            </div>

            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Reason</p>
              <p className="mt-2 text-sm text-[var(--text-primary)]">
                {String(payload.reason ?? payload.expectedOutput ?? 'No handoff rationale recorded.')}
              </p>
            </div>

            {requiredArtifacts.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {requiredArtifacts.map((artifact) => (
                  <span
                    key={artifact}
                    className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-secondary)]"
                  >
                    {artifact}
                  </span>
                ))}
              </div>
            )}
          </Card>
        )
      })}
    </div>
  )
}

function EventTimeline({
  events,
  artifactsById,
  onOpenScreenshot,
}: {
  events: Phase2SessionEvent[]
  artifactsById: Record<string, Phase2SessionArtifact>
  onOpenScreenshot: (src: string, alt: string) => void
}) {
  if (events.length === 0) {
    return (
      <Card>
        <p className="text-sm text-[var(--text-muted)]">No events available.</p>
      </Card>
    )
  }

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Event timeline</h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Chronological log of the agentic session.
        </p>
      </div>

      <div className="space-y-3">
        {events.map((event) => {
          const payload = eventPayload(event)
          const artifactId = getEventArtifactId(event)
          const artifact = artifactId ? artifactsById[artifactId] : undefined
          const screenshotUrl = artifact?.type === 'screenshot' ? api.getPhase2ArtifactContentUrl(artifact.id) : null
          return (
            <div key={event.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="rounded-md border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
                    {event.type}
                  </span>
                  {event.agentRole && (
                    <span className={cn('rounded-md border px-2 py-0.5 text-xs', agentColor(event.agentRole))}>
                      {formatAgentName(event.agentRole)}
                    </span>
                  )}
                </div>
                <span className="text-xs text-[var(--text-muted)]">
                  {formatRelativeTime(event.timestamp)}
                </span>
              </div>
              {Object.keys(payload).length > 0 && (
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs text-[var(--text-secondary)]">
                  {JSON.stringify(payload, null, 2)}
                </pre>
              )}
              {screenshotUrl && (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => onOpenScreenshot(screenshotUrl, artifact?.description ?? 'Session screenshot')}
                    className="block w-full"
                  >
                    <img
                      src={screenshotUrl}
                      alt={artifact?.description ?? 'Session screenshot'}
                      className="max-h-64 w-full rounded-lg border border-[var(--border)] object-contain"
                    />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function FindingsByAgent({ findings }: { findings: Phase2SessionFinding[] }) {
  const grouped = findings.reduce<Record<string, {
    total: number
    criticalHigh: number
    titles: string[]
  }>>((acc, finding) => {
    const agentId = finding.agentId ?? 'unknown'
    const current = acc[agentId] ?? { total: 0, criticalHigh: 0, titles: [] }
    current.total += 1
    if (finding.severity === 'critical' || finding.severity === 'high') {
      current.criticalHigh += 1
    }
    current.titles.push(finding.title)
    acc[agentId] = current
    return acc
  }, {})

  const ordered = Object.entries(grouped).sort((a, b) => b[1].total - a[1].total)

  if (ordered.length === 0) {
    return (
      <Card>
        <p className="text-sm text-[var(--text-muted)]">No findings recorded in this session.</p>
      </Card>
    )
  }

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Findings by agent</h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Findings compared by role in this session.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {ordered.map(([agentId, summary]) => (
          <div key={agentId} className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
            <div className="flex items-center justify-between gap-3">
              <span className={cn('rounded-md border px-2 py-1 text-xs font-semibold', agentColor(agentId))}>
                {formatAgentName(agentId)}
              </span>
              <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                <span>{summary.total} total</span>
                <span className={summary.criticalHigh > 0 ? 'text-red-300' : 'text-[var(--text-muted)]'}>
                  {summary.criticalHigh} crit/high
                </span>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {summary.titles.slice(0, 3).map((title) => (
                <div key={title} className="rounded-md border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                  {title}
                </div>
              ))}
              {summary.titles.length > 3 && (
                <p className="text-xs text-[var(--text-muted)]">
                  +{summary.titles.length - 3} more findings
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

function AgentConversation({
  events,
  artifactsById,
  onOpenScreenshot,
}: {
  events: Phase2SessionEvent[]
  artifactsById: Record<string, Phase2SessionArtifact>
  onOpenScreenshot: (src: string, alt: string) => void
}) {
  const conversationEvents = events
    .filter((event) => event.agentRole || event.type.startsWith('handoff_'))
    .map((event) => ({
      event,
      summary: summarizeConversationEvent(event),
    }))
    .filter((entry) => entry.summary !== null)

  if (conversationEvents.length === 0) {
    return (
      <Card>
        <p className="text-sm text-[var(--text-muted)]">No agent conversation available.</p>
      </Card>
    )
  }

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Agent conversation</h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Operational view of exchanges between agents and tools.
        </p>
      </div>

      <div className="space-y-4">
        {conversationEvents.map(({ event, summary }) => {
          const agentId = event.agentRole ?? String(eventPayload(event).fromAgentId ?? 'system')
          const alignRight = agentId.includes('fulfill') || agentId.includes('billing')
          const artifactId = getEventArtifactId(event)
          const artifact = artifactId ? artifactsById[artifactId] : undefined
          const screenshotUrl = artifact?.type === 'screenshot' ? api.getPhase2ArtifactContentUrl(artifact.id) : null

          return (
            <div key={event.id} className={cn('flex', alignRight ? 'justify-end' : 'justify-start')}>
              <div className="max-w-[85%] space-y-2">
                <div className={cn('inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs', agentColor(agentId))}>
                  <Bot className="h-3.5 w-3.5" />
                  {formatAgentName(agentId)}
                </div>

                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Wrench className="h-4 w-4 text-[var(--text-muted)]" />
                      <p className="text-sm font-semibold text-[var(--text-primary)]">
                        {summary?.title}
                      </p>
                    </div>
                    <span className="text-xs text-[var(--text-muted)]">
                      {formatRelativeTime(event.timestamp)}
                    </span>
                  </div>
                  <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs text-[var(--text-secondary)]">
                    {summary?.body}
                  </pre>
                  {screenshotUrl && (
                    <button
                      type="button"
                      onClick={() => onOpenScreenshot(screenshotUrl, artifact?.description ?? 'Session screenshot')}
                      className="mt-3 block w-full"
                    >
                      <img
                        src={screenshotUrl}
                        alt={artifact?.description ?? 'Session screenshot'}
                        className="max-h-64 w-full rounded-lg border border-[var(--border)] object-contain"
                      />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function ScreenshotGallery({
  artifacts,
  onOpenScreenshot,
}: {
  artifacts: Phase2SessionArtifact[]
  onOpenScreenshot: (src: string, alt: string) => void
}) {
  const screenshots = artifacts.filter((artifact) => artifact.type === 'screenshot')

  if (screenshots.length === 0) {
    return (
      <Card>
        <p className="text-sm text-[var(--text-muted)]">No screenshots recorded in this session.</p>
      </Card>
    )
  }

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Screenshots</h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Visual evidence captured during the run.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {screenshots.map((artifact) => (
          <button
            type="button"
            key={artifact.id}
            onClick={() => onOpenScreenshot(api.getPhase2ArtifactContentUrl(artifact.id), artifact.description)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3"
          >
            <img
              src={api.getPhase2ArtifactContentUrl(artifact.id)}
              alt={artifact.description}
              className="aspect-video w-full rounded-md border border-[var(--border)] object-cover"
            />
            <div className="mt-3 space-y-1">
              <p className="text-sm font-medium text-[var(--text-primary)]">{artifact.description}</p>
              <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
                <span>{formatAgentName(artifact.agentRole)}</span>
                <span>{formatRelativeTime(artifact.timestamp)}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </Card>
  )
}

function WorkflowSpecPanel({
  workflowYaml,
  loading,
  error,
}: {
  workflowYaml: string | null | undefined
  loading: boolean
  error: string | null
}) {
  return (
    <Card className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Workflow contract</h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Deterministic spec expected for this session.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading workflow contract...</p>
      ) : error ? (
        <p className="text-sm text-red-300">{error}</p>
      ) : workflowYaml ? (
        <pre className="max-h-96 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4 text-xs text-[var(--text-secondary)]">
          {workflowYaml}
        </pre>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">No workflow contract available.</p>
      )}
    </Card>
  )
}

function SpecVsRunReal({
  workflowContract,
  sessionDetail,
  events,
}: {
  workflowContract: Phase2WorkflowContractResponse | null
  sessionDetail: Phase2SessionDetail
  events: Phase2SessionEvent[]
}) {
  const evaluation = sessionDetail.contractEvaluation
  const contractSteps = evaluation?.stepChecks?.length
    ? evaluation.stepChecks.map((step) => ({
        id: step.stepId,
        agentId: step.agentId,
        capabilityId: step.expectedCapability,
        producedArtifacts: step.expectedArtifacts,
        order: step.expectedOrder,
      }))
    : Array.isArray(workflowContract?.workflow_contract?.steps)
      ? workflowContract?.workflow_contract?.steps as Array<Record<string, unknown>>
      : []

  const startedStepIds = new Set(
    events
      .filter((event) => event.type === 'step_started')
      .map((event) => String(eventPayload(event).stepId ?? ''))
      .filter(Boolean),
  )
  const completedStepIds = new Set(
    events
      .filter((event) => event.type === 'step_completed')
      .map((event) => String(eventPayload(event).stepId ?? ''))
      .filter(Boolean),
  )
  const failedStepIds = new Set(
    events
      .filter((event) => event.type === 'step_failed')
      .map((event) => String(eventPayload(event).stepId ?? ''))
      .filter(Boolean),
  )
  const observedStepOrder = events
    .filter((event) => event.type === 'step_started')
    .map((event) => String(eventPayload(event).stepId ?? ''))
    .filter(Boolean)
  const expectedStepOrder = contractSteps.map((step) => String(step.id ?? 'unknown_step'))
  const observedToolsByStep = deriveObservedToolsByStep(events)

  const fallbackExpectedArtifacts = Array.from(
    new Set(
      contractSteps.flatMap((step) =>
        Array.isArray(step.producedArtifacts) ? step.producedArtifacts.map(String) : [],
      ),
    ),
  )
  const expectedArtifacts = evaluation?.expectedArtifacts ?? fallbackExpectedArtifacts
  const producedArtifacts = evaluation?.producedArtifacts ?? Object.keys(sessionDetail.artifacts ?? {})
  const unexpectedArtifacts = evaluation?.unexpectedArtifacts ?? producedArtifacts.filter((artifact) => !expectedArtifacts.includes(artifact))

  const stepViolations = contractSteps.map((step) => {
    const stepId = String(step.id ?? 'unknown_step')
    const expectedIndex = expectedStepOrder.indexOf(stepId)
    const observedIndex = observedStepOrder.indexOf(stepId)
    const expectedCapability = String(step.capabilityId ?? 'unknown')
    const observedTools = observedToolsByStep[stepId] ?? []
    const status = failedStepIds.has(stepId)
      ? 'failed'
      : completedStepIds.has(stepId)
        ? 'complete'
        : startedStepIds.has(stepId)
          ? 'running'
          : 'pending'

    return {
      step,
      stepId,
      status,
      expectedIndex,
      observedIndex,
      expectedCapability,
      observedTools,
      neverStarted: status === 'pending' && (sessionDetail.status === 'complete' || sessionDetail.status === 'failed'),
      incomplete: status === 'running' && sessionDetail.status !== 'running' && sessionDetail.status !== 'pending',
      outOfOrder: observedIndex !== -1 && observedIndex !== expectedIndex,
      capabilityMismatch:
        observedTools.length > 0 && expectedCapability !== 'unknown'
          ? !capabilityMatchesObservedTools(expectedCapability, observedTools)
          : false,
    }
  })

  const neverStartedCount = evaluation
    ? evaluation.stepChecks.filter((item) => item.neverStarted).length
    : stepViolations.filter((item) => item.neverStarted).length
  const incompleteCount = evaluation
    ? evaluation.stepChecks.filter((item) => item.incomplete).length
    : stepViolations.filter((item) => item.incomplete).length
  const failedCount = evaluation
    ? evaluation.stepChecks.filter((item) => item.status === 'failed').length
    : stepViolations.filter((item) => item.status === 'failed').length
  const missingArtifactCount = evaluation
    ? evaluation.missingArtifacts.length
    : expectedArtifacts.filter((artifact) => !producedArtifacts.includes(artifact)).length
  const outOfOrderCount = evaluation
    ? evaluation.stepChecks.filter((item) => item.outOfOrder).length
    : stepViolations.filter((item) => item.outOfOrder).length
  const capabilityMismatchCount = evaluation
    ? evaluation.stepChecks.filter((item) => item.capabilityMismatch).length
    : stepViolations.filter((item) => item.capabilityMismatch).length
  const observedUnexpectedSteps = evaluation?.observedUnexpectedSteps ?? observedStepOrder.filter((stepId) => !expectedStepOrder.includes(stepId))
  const hardViolationCount = evaluation?.hardViolations ?? (neverStartedCount + incompleteCount + failedCount + missingArtifactCount)
  const driftCount = evaluation?.driftSignals ?? (unexpectedArtifacts.length + outOfOrderCount + observedUnexpectedSteps.length + capabilityMismatchCount)
  const verdict = evaluation
    ? evaluation.verdict.replace(/_/g, ' ')
    : hardViolationCount > 0
      ? 'contract violated'
      : driftCount > 0
        ? 'contract drift'
        : 'contract compliant'
  const normalizedStepChecks = evaluation?.stepChecks ?? stepViolations.map((step) => ({
    stepId: step.stepId,
    agentId: String((step.step as Record<string, unknown>).agentId ?? 'unknown'),
    expectedCapability: step.expectedCapability,
    observedTools: step.observedTools,
    expectedOrder: step.expectedIndex,
    observedOrder: step.observedIndex,
    status: step.status,
    neverStarted: step.neverStarted,
    incomplete: step.incomplete,
    outOfOrder: step.outOfOrder,
    capabilityMismatch: step.capabilityMismatch,
    expectedArtifacts: Array.isArray((step.step as Record<string, unknown>).producedArtifacts)
      ? ((step.step as Record<string, unknown>).producedArtifacts as string[])
      : [],
  }))

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Spec vs actual run</h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Comparison between the expected contract and the observed run.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            'rounded-md border px-3 py-1.5 text-xs font-semibold uppercase',
            verdict === 'contract evaluating'
              ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
              : verdict === 'contract violated'
              ? 'border-red-500/30 bg-red-500/10 text-red-300'
              : verdict === 'contract drift'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                : 'border-green-500/30 bg-green-500/10 text-green-300',
          )}
        >
          {verdict}
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          hard violations: {hardViolationCount}
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          drift signals: {driftCount}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <span className={cn(
          'rounded-md border px-2 py-1 text-xs',
          neverStartedCount > 0 ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-green-500/30 bg-green-500/10 text-green-300',
        )}>
          steps not started: {neverStartedCount}
        </span>
        <span className={cn(
          'rounded-md border px-2 py-1 text-xs',
          incompleteCount > 0 ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-green-500/30 bg-green-500/10 text-green-300',
        )}>
          steps incomplete: {incompleteCount}
        </span>
        <span className={cn(
          'rounded-md border px-2 py-1 text-xs',
          failedCount > 0 ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-green-500/30 bg-green-500/10 text-green-300',
        )}>
          steps failed: {failedCount}
        </span>
        <span className={cn(
          'rounded-md border px-2 py-1 text-xs',
          missingArtifactCount > 0 ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-green-500/30 bg-green-500/10 text-green-300',
        )}>
          missing artifacts: {missingArtifactCount}
        </span>
        <span className={cn(
          'rounded-md border px-2 py-1 text-xs',
          unexpectedArtifacts.length > 0 ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-green-500/30 bg-green-500/10 text-green-300',
        )}>
          unexpected artifacts: {unexpectedArtifacts.length}
        </span>
        <span className={cn(
          'rounded-md border px-2 py-1 text-xs',
          outOfOrderCount > 0 || observedUnexpectedSteps.length > 0
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
            : 'border-green-500/30 bg-green-500/10 text-green-300',
        )}>
          order mismatches: {outOfOrderCount + observedUnexpectedSteps.length}
        </span>
        <span className={cn(
          'rounded-md border px-2 py-1 text-xs',
          capabilityMismatchCount > 0
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
            : 'border-green-500/30 bg-green-500/10 text-green-300',
        )}>
          capability mismatches: {capabilityMismatchCount}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
          <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Expected order</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {expectedStepOrder.map((stepId, index) => (
              <span key={`${stepId}-expected`} className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-secondary)]">
                {index + 1}. {stepId}
              </span>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
          <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Observed order</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {observedStepOrder.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">No steps started.</p>
            ) : (
              observedStepOrder.map((stepId, index) => {
                const expectedAtPosition = expectedStepOrder[index]
                const matches = expectedAtPosition === stepId
                const unexpected = !expectedStepOrder.includes(stepId)
                return (
                  <span
                    key={`${stepId}-${index}-observed`}
                    className={cn(
                      'rounded-md border px-2 py-1 text-xs',
                      unexpected
                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                        : matches
                          ? 'border-green-500/30 bg-green-500/10 text-green-300'
                          : 'border-red-500/30 bg-red-500/10 text-red-300',
                    )}
                  >
                    {index + 1}. {stepId}
                  </span>
                )
              })
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Expected steps</p>
          {contractSteps.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">No expected steps.</p>
          ) : (
            normalizedStepChecks.map((rawStep) => {
              const stepId = rawStep.stepId
              const status = rawStep.status
              const neverStarted = rawStep.neverStarted
              const incomplete = rawStep.incomplete
              const outOfOrder = rawStep.outOfOrder
              const expectedIndex = rawStep.expectedOrder
              const observedIndex = rawStep.observedOrder
              const expectedCapability = rawStep.expectedCapability
              const observedTools = rawStep.observedTools
              const capabilityMismatch = rawStep.capabilityMismatch
              const agentId = rawStep.agentId
              const expectedArtifactsForStep = rawStep.expectedArtifacts

              return (
                <div key={stepId} className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-[var(--text-primary)]">{stepId}</p>
                    <span className={cn('rounded-md border px-2 py-1 text-[10px] font-semibold uppercase', statusClasses(status as AgenticStatus))}>
                      {status}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-2 text-xs text-[var(--text-muted)]">
                    <span>agent: {agentId}</span>
                    <span>expected capability: {expectedCapability}</span>
                    <span>observed tools: {observedTools.join(', ') || 'none'}</span>
                    <span>expected order: {expectedIndex + 1}</span>
                    {observedIndex !== -1 && <span>observed order: {observedIndex + 1}</span>}
                    <span>
                      artifacts: {expectedArtifactsForStep.join(', ') || 'none'}
                    </span>
                    {neverStarted && <span className="text-red-300">violation: expected step never started</span>}
                    {incomplete && <span className="text-red-300">violation: step started but did not complete</span>}
                    {outOfOrder && <span className="text-amber-300">violation: step executed out of expected order</span>}
                    {capabilityMismatch && <span className="text-amber-300">violation: step used tool(s) different from expected capability</span>}
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="space-y-3">
          <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Expected artifacts</p>
          <div className="flex flex-wrap gap-2">
            {expectedArtifacts.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">No expected artifacts.</p>
            ) : (
              expectedArtifacts.map((artifact) => {
                const present = producedArtifacts.includes(artifact)
                return (
                  <span
                    key={artifact}
                    className={cn(
                      'rounded-md border px-2 py-1 text-xs',
                      present
                        ? 'border-green-500/30 bg-green-500/10 text-green-300'
                        : 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300',
                    )}
                  >
                    {artifact} {present ? 'present' : 'missing'}
                  </span>
                )
              })
            )}
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
            <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Produced artifacts</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {producedArtifacts.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">No artifacts produced.</p>
              ) : (
                producedArtifacts.map((artifact) => (
                  <span
                    key={artifact}
                    className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-secondary)]"
                  >
                    {artifact}
                  </span>
                ))
              )}
            </div>
          </div>

          {unexpectedArtifacts.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
              <p className="text-xs uppercase tracking-wide text-amber-300">Unexpected artifacts</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {unexpectedArtifacts.map((artifact) => (
                  <span key={artifact} className="rounded-md border border-amber-500/30 px-2 py-1 text-xs text-amber-200">
                    {artifact}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

export function AgenticRuns() {
  const [sessions, setSessions] = useState<Phase2SessionSummary[]>([])
  const [scenarios, setScenarios] = useState<Phase2ScenarioSummary[]>([])
  const initialHashState = parseAgenticRunsHash()
  const [activeView, setActiveView] = useState<RunsView>(initialHashState?.tab ?? 'current')
  const [selectedId, setSelectedId] = useState<string | null>(initialHashState?.selectedId ?? null)
  const [currentSessionIdOverride, setCurrentSessionIdOverride] = useState<string | null>(null)
  const [selectedScenario, setSelectedScenario] = useState('')
  const [startingRun, setStartingRun] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [sessionDetail, setSessionDetail] = useState<Phase2SessionDetail | null>(null)
  const [events, setEvents] = useState<Phase2SessionEvent[]>([])
  const [findings, setFindings] = useState<Phase2SessionFinding[]>([])
  const [artifacts, setArtifacts] = useState<Phase2SessionArtifact[]>([])
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailConnection, setDetailConnection] = useState<'connecting' | 'live' | 'fallback' | 'idle'>('idle')
  const [workflowContract, setWorkflowContract] = useState<Phase2WorkflowContractResponse | null>(null)
  const [workflowLoading, setWorkflowLoading] = useState(false)
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  const [screenshotModal, setScreenshotModal] = useState<{ src: string; alt: string } | null>(null)
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>(initialHashState?.sessionFilter ?? 'all')
  const [contractFilter, setContractFilter] = useState<ContractFilter>(initialHashState?.contractFilter ?? 'all')
  const [sortMode, setSortMode] = useState<SortMode>(initialHashState?.sortMode ?? 'recent')
  const [sessionWindow, setSessionWindow] = useState<SessionWindow>(initialHashState?.sessionWindow ?? 'all')
  const [agentFilter, setAgentFilter] = useState<string>(initialHashState?.agentFilter ?? 'all')
  const [handoffFilter, setHandoffFilter] = useState<HandoffFilter>(initialHashState?.handoffFilter ?? 'all')

  useEffect(() => {
    const handleAgenticRunStarted = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<{ session_id?: string }>
      if (event.detail?.session_id) {
        setActiveView('current')
        setCurrentSessionIdOverride(event.detail.session_id)
      }
    }

    window.addEventListener('agentic-run-started', handleAgenticRunStarted)
    return () => window.removeEventListener('agentic-run-started', handleAgenticRunStarted)
  }, [])

  useEffect(() => {
    const syncFromHash = () => {
      const hashState = parseAgenticRunsHash()
      if (!hashState) return
      setActiveView(hashState.tab ?? 'current')
      setSelectedId(hashState.selectedId ?? null)
      setSessionFilter(hashState.sessionFilter ?? 'all')
      setContractFilter(hashState.contractFilter ?? 'all')
      setSortMode(hashState.sortMode ?? 'recent')
      setSessionWindow(hashState.sessionWindow ?? 'all')
      setAgentFilter(hashState.agentFilter ?? 'all')
      setHandoffFilter(hashState.handoffFilter ?? 'all')
    }

    window.addEventListener('hashchange', syncFromHash)
    return () => window.removeEventListener('hashchange', syncFromHash)
  }, [])

  useEffect(() => {
    let mounted = true

    const load = async () => {
      try {
        const [nextSessions, nextScenarios] = await Promise.all([
          api.getPhase2Sessions(),
          api.getPhase2Scenarios(),
        ])
        if (!mounted) return
        setSessions(nextSessions)
        setScenarios(nextScenarios)
        setSelectedScenario((current) => (
          nextScenarios.some((scenario) => scenario.id === current)
            ? current
            : nextScenarios[0]?.id ?? current
        ))
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

  const sessionsByRecency = useMemo(
    () => [...sessions].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    [sessions],
  )

  const activeSession = sessions.find((session) => session.status === 'running' || session.status === 'pending') ?? null
  const currentSessionSummary = useMemo(() => {
    if (currentSessionIdOverride) {
      const overrideSession = sessions.find((session) => session.id === currentSessionIdOverride)
      if (overrideSession) return overrideSession
    }
    return activeSession ?? sessionsByRecency[0] ?? null
  }, [activeSession, currentSessionIdOverride, sessions, sessionsByRecency])

  const detailSessionId = activeView === 'current'
    ? currentSessionIdOverride ?? currentSessionSummary?.id ?? null
    : selectedId

  useEffect(() => {
    if (currentSessionIdOverride && currentSessionSummary?.id === currentSessionIdOverride) {
      setCurrentSessionIdOverride(null)
    }
  }, [currentSessionIdOverride, currentSessionSummary?.id])

  useEffect(() => {
    if (!detailSessionId) {
      setSessionDetail(null)
      setEvents([])
      setFindings([])
      setArtifacts([])
      setDetailConnection('idle')
      return
    }

    let mounted = true
    setDetailLoading(true)
    setDetailConnection('connecting')

    const loadDetail = async () => {
      try {
        const [detail, nextEvents, nextFindings, nextArtifacts] = await Promise.all([
          api.getPhase2Session(detailSessionId),
          api.getPhase2SessionEvents(detailSessionId),
          api.getPhase2SessionFindings(detailSessionId),
          api.getPhase2SessionArtifacts(detailSessionId),
        ])
        if (!mounted) return
        setSessionDetail(detail)
        setEvents(nextEvents)
        setFindings(nextFindings)
        setArtifacts(nextArtifacts)
      } finally {
        if (mounted) setDetailLoading(false)
      }
    }

    void loadDetail()
    let fallbackInterval: number | null = null

    const startFallback = () => {
      if (fallbackInterval !== null) return
      setDetailConnection('fallback')
      fallbackInterval = window.setInterval(loadDetail, 5000)
    }

    let socketSettled = false
    let ws: WebSocket | null = null

    try {
      ws = new WebSocket(api.getPhase2SessionWsUrl(detailSessionId))

      ws.onopen = () => {
        socketSettled = true
        if (!mounted) return
        setDetailConnection('live')
        if (fallbackInterval !== null) {
          window.clearInterval(fallbackInterval)
          fallbackInterval = null
        }
      }

      ws.onmessage = (message) => {
        try {
          const parsed = JSON.parse(message.data as string) as {
            type?: string
            payload?: {
              kind?: string
              session?: Phase2SessionDetail
              events?: Phase2SessionEvent[]
              findings?: Phase2SessionFinding[]
              artifacts?: Phase2SessionArtifact[]
            }
          }

          if (parsed.payload?.kind !== 'phase2_snapshot') return
          if (parsed.payload.session) setSessionDetail(parsed.payload.session)
          if (parsed.payload.events) setEvents(parsed.payload.events)
          if (parsed.payload.findings) setFindings(parsed.payload.findings)
          if (parsed.payload.artifacts) setArtifacts(parsed.payload.artifacts)
          if (mounted) setDetailLoading(false)
        } catch {
          // Ignore malformed websocket frames and keep fallback logic.
        }
      }

      ws.onerror = () => {
        if (!socketSettled) {
          startFallback()
        } else if (mounted) {
          setDetailConnection('fallback')
        }
      }

      ws.onclose = () => {
        startFallback()
      }
    } catch {
      startFallback()
    }

    const wsTimeout = window.setTimeout(() => {
      if (!socketSettled && mounted) {
        startFallback()
      }
    }, 1500)

    return () => {
      mounted = false
      window.clearTimeout(wsTimeout)
      if (fallbackInterval !== null) {
        window.clearInterval(fallbackInterval)
      }
      ws?.close()
    }
  }, [detailSessionId])

  useEffect(() => {
    if (!sessionDetail?.scenarioId) {
      setWorkflowContract(null)
      setWorkflowError(null)
      return
    }

    let mounted = true
    setWorkflowLoading(true)
    setWorkflowError(null)

    void api.getPhase2ScenarioWorkflowContract(sessionDetail.scenarioId)
      .then((response) => {
        if (!mounted) return
        setWorkflowContract(response)
      })
      .catch((error) => {
        if (!mounted) return
        setWorkflowContract(null)
        const message = error instanceof Error ? error.message : 'Failed to load workflow contract'
        setWorkflowError(message.includes('404') ? 'This session has no workflow contract.' : message)
      })
      .finally(() => {
        if (mounted) setWorkflowLoading(false)
      })

    return () => {
      mounted = false
    }
  }, [sessionDetail?.scenarioId])

  const sessionDuration = useMemo(() => {
    if (!sessionDetail?.completedAt) return null
    const ms = new Date(sessionDetail.completedAt).getTime() - new Date(sessionDetail.startedAt).getTime()
    return ms > 0 ? formatDuration(Math.round(ms / 1000)) : '0s'
  }, [sessionDetail])

  const availableAgents = useMemo(() => {
    const agents = new Set<string>()
    for (const event of events) {
      if (event.agentRole) agents.add(event.agentRole)
      const payload = eventPayload(event)
      if (typeof payload.fromAgentId === 'string') agents.add(payload.fromAgentId)
      if (typeof payload.toAgentId === 'string') agents.add(payload.toAgentId)
    }
    return ['all', ...Array.from(agents)]
  }, [events])

  const artifactsById = useMemo(
    () => Object.fromEntries(artifacts.map((artifact) => [artifact.id, artifact])),
    [artifacts],
  )

  const filteredEvents = useMemo(() => {
    return events.filter((event) => {
      const payload = eventPayload(event)
      const matchesAgent =
        agentFilter === 'all' ||
        event.agentRole === agentFilter ||
        payload.fromAgentId === agentFilter ||
        payload.toAgentId === agentFilter

      const handoffStatus =
        event.type === 'handoff_emitted'
          ? 'proposed'
          : event.type === 'handoff_accepted'
            ? 'accepted'
            : event.type === 'handoff_rejected'
              ? 'rejected'
              : null

      const matchesHandoff =
        handoffFilter === 'all' ||
        handoffStatus === handoffFilter

      if (handoffFilter !== 'all' && !handoffStatus) return false
      return matchesAgent && matchesHandoff
    })
  }, [agentFilter, events, handoffFilter])

  const historySessions = useMemo(
    () => sessions.filter((session) => session.id !== currentSessionSummary?.id),
    [currentSessionSummary?.id, sessions],
  )

  const orderedHistorySessions = useMemo(() => {
    const severityRank = (verdict: Phase2SessionSummary['contractVerdict']) => {
      switch (verdict) {
        case 'contract_violated':
          return 0
        case 'contract_drift':
          return 1
        case 'contract_evaluating':
          return 2
        case 'contract_compliant':
          return 3
        default:
          return 4
      }
    }

    const sorted = [...sessions].sort((a, b) => {
      if (sortMode === 'contract_severity') {
        const severityDiff = severityRank(a.contractVerdict ?? null) - severityRank(b.contractVerdict ?? null)
        if (severityDiff !== 0) return severityDiff
      }

      return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    })

    const filtered = sorted.filter((session) => {
      const isMultiRole = session.scenarioId.includes('multi_role')
      const matchesSessionType =
        sessionFilter === 'all'
          ? true
          : sessionFilter === 'multi'
            ? isMultiRole
            : !isMultiRole

      const matchesContract =
        contractFilter === 'all'
          ? true
          : session.contractVerdict === contractFilter

      return matchesSessionType && matchesContract
    })

    if (sessionWindow === 'all') return filtered

    const limit = Number(sessionWindow)
    return filtered.slice(0, limit)
  }, [contractFilter, historySessions, sessionFilter, sessionWindow, sortMode])

  useEffect(() => {
    if (activeView !== 'history') return

    const hasSelectedHistorySession = selectedId
      ? orderedHistorySessions.some((session) => session.id === selectedId)
      : false

    if (!hasSelectedHistorySession) {
      setSelectedId(orderedHistorySessions[0]?.id ?? null)
    }
  }, [activeView, orderedHistorySessions, selectedId])

  const visibleContractSummary = useMemo(() => {
    return orderedHistorySessions.reduce(
      (acc, session) => {
        switch (session.contractVerdict) {
          case 'contract_violated':
            acc.violated += 1
            break
          case 'contract_drift':
            acc.drift += 1
            break
          case 'contract_compliant':
            acc.compliant += 1
            break
          case 'contract_evaluating':
            acc.noContract += 1
            break
          default:
            acc.noContract += 1
            break
        }
        return acc
      },
      { violated: 0, drift: 0, compliant: 0, noContract: 0 },
    )
  }, [orderedHistorySessions])

  const visibleContractSeverity = useMemo(() => {
    return orderedHistorySessions.reduce(
      (acc, session) => {
        acc.hardViolations += session.contractHardViolations ?? 0
        acc.driftSignals += session.contractDriftSignals ?? 0
        return acc
      },
      { hardViolations: 0, driftSignals: 0 },
    )
  }, [orderedHistorySessions])

  const selectedScenarioGate = scenarios.find((scenario) => scenario.id === selectedScenario)?.quality_gate
  const startRunDisabled = !selectedScenario || selectedScenarioGate?.status === 'restricted' || Boolean(activeSession)

  const handleStartRun = async () => {
    if (startRunDisabled || startingRun) return
    if (selectedScenarioGate?.status === 'restricted') return
    setStartingRun(true)
    setStartError(null)

    try {
      const result = await api.startPhase2Run({
        scenario_id: selectedScenario,
      })
      setActiveView('current')
      setCurrentSessionIdOverride(result.session_id)
      window.dispatchEvent(new CustomEvent('agentic-run-started', { detail: result }))
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'Failed to start agentic session')
    } finally {
      setStartingRun(false)
    }
  }

  useEffect(() => {
    writeAgenticRunsHash({
      tab: activeView,
      selectedId,
      sessionFilter,
      contractFilter,
      sortMode,
      sessionWindow,
      agentFilter,
      handoffFilter,
    })
  }, [activeView, agentFilter, contractFilter, handoffFilter, selectedId, sessionFilter, sessionWindow, sortMode])

  const detailContent = !detailSessionId ? (
    <Card>
      <p className="text-sm text-[var(--text-muted)]">
        {activeView === 'current'
          ? 'No run in focus. Start a new run to follow its events here.'
          : 'Select a session from the history.'}
      </p>
    </Card>
  ) : detailLoading && !sessionDetail ? (
    <Card>
      <p className="text-sm text-[var(--text-muted)]">Loading session detail...</p>
    </Card>
  ) : sessionDetail ? (
    <>
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
            <CheckCircle2 className="h-4 w-4" />
            Status
          </div>
          <p className="mt-3 text-lg font-semibold text-[var(--text-primary)]">
            {sessionDetail.status}
          </p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
            <Clock3 className="h-4 w-4" />
            Duration
          </div>
          <p className="mt-3 text-lg font-semibold text-[var(--text-primary)]">
            {sessionDuration ?? 'Running'}
          </p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
            <MessageSquareText className="h-4 w-4" />
            Events
          </div>
          <p className="mt-3 text-lg font-semibold text-[var(--text-primary)]">
            {events.length}
          </p>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            {detailConnection === 'live'
              ? 'Live via WebSocket'
              : detailConnection === 'fallback'
                ? 'Fallback polling'
                : detailConnection === 'connecting'
                  ? 'Connecting...'
                  : 'Idle'}
          </p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
            {findings.length > 0 ? <XCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
            Findings
          </div>
          <p className="mt-3 text-lg font-semibold text-[var(--text-primary)]">
            {findings.length}
          </p>
        </Card>
      </div>

      <Card className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            {sessionDetail.scenarioId}
          </h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Session ID: {sessionDetail.id}
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Started</p>
            <p className="mt-2 text-sm text-[var(--text-primary)]">{formatRelativeTime(sessionDetail.startedAt)}</p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Checkpoint</p>
            <p className="mt-2 text-sm text-[var(--text-primary)]">
              step {sessionDetail.checkpoint.lastCompletedStep} / cursor {sessionDetail.checkpoint.cursor}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Artifacts</p>
            <p className="mt-2 text-sm text-[var(--text-primary)]">
              {Object.keys(sessionDetail.artifacts ?? {}).length}
            </p>
          </div>
        </div>
      </Card>

      <WorkflowSpecPanel
        workflowYaml={sessionDetail.workflowContractYaml ?? workflowContract?.workflow_contract_yaml}
        loading={workflowLoading}
        error={workflowError}
      />
      <SpecVsRunReal
        workflowContract={workflowContract}
        sessionDetail={sessionDetail}
        events={events}
      />
      <Card className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">View filters</h3>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Filter the session by agent or handoff status.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <p className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">Agent</p>
            <div className="flex flex-wrap gap-2">
              {availableAgents.map((agentId) => (
                <button
                  key={agentId}
                  onClick={() => setAgentFilter(agentId)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                    agentFilter === agentId
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                      : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:border-[var(--accent)]/30',
                  )}
                >
                  {agentId === 'all' ? 'All agents' : formatAgentName(agentId)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">Handoff status</p>
            <div className="flex flex-wrap gap-2">
              {[
                ['all', 'All'],
                ['proposed', 'Proposed'],
                ['accepted', 'Accepted'],
                ['rejected', 'Rejected'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setHandoffFilter(id as HandoffFilter)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                    handoffFilter === id
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                      : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:border-[var(--accent)]/30',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <HandoffBoard events={filteredEvents} />
      <ScreenshotGallery
        artifacts={artifacts.filter((artifact) => agentFilter === 'all' || artifact.agentRole === agentFilter)}
        onOpenScreenshot={(src, alt) => setScreenshotModal({ src, alt })}
      />
      <FindingsByAgent findings={findings.filter((finding) => agentFilter === 'all' || finding.agentId === agentFilter)} />
      <AgentConversation
        events={filteredEvents}
        artifactsById={artifactsById}
        onOpenScreenshot={(src, alt) => setScreenshotModal({ src, alt })}
      />
      <EventTimeline
        events={filteredEvents}
        artifactsById={artifactsById}
        onOpenScreenshot={(src, alt) => setScreenshotModal({ src, alt })}
      />
    </>
  ) : (
    <Card>
      <p className="text-sm text-[var(--text-muted)]">Failed to load the session.</p>
    </Card>
  )

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <AnimatePresence>
        {screenshotModal && (
          <ScreenshotModal
            src={screenshotModal.src}
            alt={screenshotModal.alt}
            onClose={() => setScreenshotModal(null)}
          />
        )}
      </AnimatePresence>
      <Card className="p-2">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Agentic runs views">
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'current'}
            onClick={() => setActiveView('current')}
            className={cn(
              'rounded-md border px-3 py-2 text-sm font-medium transition-colors',
              activeView === 'current'
                ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:border-[var(--accent)]/30',
            )}
          >
            Current run {(currentSessionSummary || currentSessionIdOverride) ? '(1)' : '(0)'}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'history'}
            onClick={() => setActiveView('history')}
            className={cn(
              'rounded-md border px-3 py-2 text-sm font-medium transition-colors',
              activeView === 'history'
                ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:border-[var(--accent)]/30',
            )}
          >
            History ({historySessions.length})
          </button>
        </div>
      </Card>

      {activeView === 'current' ? (
        <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
          <Card className="flex min-h-0 flex-col overflow-hidden p-0">
            <div className="border-b border-[var(--border)] px-5 py-4">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Current run</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                One run in focus at a time. Starting a new run moves the previous one to History.
              </p>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3">
                <div className="mb-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                    New run
                  </h3>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    Start a new run and follow its events live on this tab.
                  </p>
                  {activeSession && (
                    <p className="mt-2 rounded-md border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-300">
                      A session is already running: {activeSession.scenarioId}
                    </p>
                  )}
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                      Scenario
                    </label>
                    <select
                      value={selectedScenario}
                      onChange={(event) => setSelectedScenario(event.target.value)}
                      className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)]/50 focus:outline-none"
                    >
                      {scenarios.map((scenario) => (
                        <option key={scenario.id} value={scenario.id}>
                          {scenario.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {selectedScenarioGate ? (
                    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">quality gate</span>
                        <span
                          className={cn(
                            'rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase',
                            selectedScenarioGate.status === 'restricted'
                              ? 'border-red-500/20 bg-red-500/10 text-red-300'
                              : selectedScenarioGate.status === 'review_required'
                                ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
                                : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
                          )}
                        >
                          {selectedScenarioGate.status.replace('_', ' ')}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                        {selectedScenarioGate.reason}
                      </p>
                    </div>
                  ) : null}

                  <Button
                    variant="primary"
                    icon={<Play className="h-3.5 w-3.5" />}
                    loading={startingRun}
                    onClick={handleStartRun}
                    disabled={startRunDisabled}
                    className="w-full justify-center"
                  >
                    {activeSession
                      ? 'Session running'
                      : selectedScenarioGate?.status === 'restricted'
                        ? 'Scenario restricted'
                        : 'Start session'}
                  </Button>

                  {startError && (
                    <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                      {startError}
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                      Run in focus
                    </h3>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      Shows the active session or, if none is active, the most recent one.
                    </p>
                  </div>
                  {currentSessionSummary && (
                    <span className={cn('rounded-md border px-2 py-1 text-[10px] font-semibold uppercase', statusClasses(currentSessionSummary.status))}>
                      {currentSessionSummary.status}
                    </span>
                  )}
                </div>

                {currentSessionIdOverride && currentSessionSummary?.id !== currentSessionIdOverride ? (
                  <p className="mt-4 text-sm text-[var(--text-muted)]">Starting new session...</p>
                ) : currentSessionSummary ? (
                  <div className="mt-4 space-y-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--text-primary)]">{currentSessionSummary.scenarioId}</p>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">{formatRelativeTime(currentSessionSummary.startedAt)}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className={cn('rounded-md border px-2 py-1 text-[10px] font-semibold uppercase', contractVerdictClasses(currentSessionSummary.contractVerdict ?? null))}>
                        {formatContractVerdict(currentSessionSummary.contractVerdict ?? null)}
                      </span>
                      <span className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">
                        {currentSessionSummary.eventCount} events
                      </span>
                      <span className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">
                        {currentSessionSummary.artifactCount} artifacts
                      </span>
                      <span className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">
                        {currentSessionSummary.findingCount} findings
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-[var(--text-muted)]">
                    No run in focus right now.
                  </p>
                )}
              </div>
            </div>
          </Card>

          <div className="min-h-0 space-y-6 overflow-y-auto pr-1">
            {detailContent}
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
          <Card className="flex min-h-0 flex-col overflow-hidden p-0">
            <div className="border-b border-[var(--border)] px-5 py-4">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">History</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Finished or earlier sessions. The run in focus stays on the Current run tab.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] font-semibold uppercase text-red-300">
                  violated {visibleContractSummary.violated}
                </span>
                <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold uppercase text-amber-300">
                  drift {visibleContractSummary.drift}
                </span>
                <span className="rounded-md border border-green-500/30 bg-green-500/10 px-2 py-1 text-[10px] font-semibold uppercase text-green-300">
                  compliant {visibleContractSummary.compliant}
                </span>
                <span className="rounded-md border border-zinc-500/30 bg-zinc-500/10 px-2 py-1 text-[10px] font-semibold uppercase text-zinc-300">
                  no contract {visibleContractSummary.noContract}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] font-semibold uppercase text-red-300">
                  {visibleContractSeverity.hardViolations} hard violations
                </span>
                <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold uppercase text-amber-300">
                  {visibleContractSeverity.driftSignals} drift signals
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {[
                  { id: 'all', label: 'All' },
                  { id: 'single', label: 'Single-agent' },
                  { id: 'multi', label: 'Multi-agent' },
                ].map((filter) => (
                  <button
                    key={filter.id}
                    onClick={() => setSessionFilter(filter.id as SessionFilter)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                      sessionFilter === filter.id
                        ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                        : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:border-[var(--accent)]/30',
                    )}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {[
                  { id: 'all', label: 'All contracts' },
                  { id: 'contract_evaluating', label: 'Evaluating' },
                  { id: 'contract_compliant', label: 'Compliant' },
                  { id: 'contract_drift', label: 'Drift' },
                  { id: 'contract_violated', label: 'Violated' },
                ].map((filter) => (
                  <button
                    key={filter.id}
                    onClick={() => setContractFilter(filter.id as ContractFilter)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                      contractFilter === filter.id
                        ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                        : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:border-[var(--accent)]/30',
                    )}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {[
                  { id: 'recent', label: 'Most recent' },
                  { id: 'contract_severity', label: 'Contract severity' },
                ].map((mode) => (
                  <button
                    key={mode.id}
                    onClick={() => setSortMode(mode.id as SortMode)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                      sortMode === mode.id
                        ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                        : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:border-[var(--accent)]/30',
                    )}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {[
                  { id: 'all', label: 'All sessions' },
                  { id: '10', label: 'Recent 10' },
                  { id: '20', label: 'Recent 20' },
                ].map((windowOption) => (
                  <button
                    key={windowOption.id}
                    onClick={() => setSessionWindow(windowOption.id as SessionWindow)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                      sessionWindow === windowOption.id
                        ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                        : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:border-[var(--accent)]/30',
                    )}
                  >
                    {windowOption.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading ? (
                <div className="p-5 text-sm text-[var(--text-muted)]">Loading sessions...</div>
              ) : orderedHistorySessions.length === 0 ? (
                <div className="p-5 text-sm text-[var(--text-muted)]">No earlier sessions available.</div>
              ) : (
                <div className="space-y-2 p-3">
                  {orderedHistorySessions.map((session) => {
                    const isMultiRole = session.scenarioId.includes('multi_role')
                    return (
                      <button
                        key={session.id}
                        onClick={() => setSelectedId(session.id)}
                        className={cn(
                          'w-full rounded-lg border px-4 py-3 text-left transition-colors',
                          selectedId === session.id
                            ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                            : 'border-[var(--border)] bg-[var(--bg-primary)] hover:border-[var(--accent)]/30',
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
                            {session.scenarioId}
                          </p>
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              'rounded-md border px-2 py-1 text-[10px] font-semibold uppercase',
                              isMultiRole
                                ? 'border-violet-500/30 bg-violet-500/10 text-violet-300'
                                : 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300',
                            )}>
                              {isMultiRole ? 'multi-agent' : 'single-agent'}
                            </span>
                            <span className={cn('rounded-md border px-2 py-1 text-[10px] font-semibold uppercase', statusClasses(session.status))}>
                              {session.status}
                            </span>
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <span className={cn('rounded-md border px-2 py-1 text-[10px] font-semibold uppercase', contractVerdictClasses(session.contractVerdict ?? null))}>
                            {formatContractVerdict(session.contractVerdict ?? null)}
                          </span>
                          {session.contractVerdict && (
                            <span className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">
                              {session.contractHardViolations ?? 0} hard / {session.contractDriftSignals ?? 0} drift
                            </span>
                          )}
                        </div>
                        <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-[var(--text-muted)]">
                          <span>{session.eventCount} events</span>
                          <span>{session.artifactCount} artifacts</span>
                          <span>{session.findingCount} findings</span>
                        </div>
                        {session.status === 'failed' && session.lastError && (
                          <p className="mt-2 line-clamp-2 text-xs text-red-300" title={session.lastError}>
                            {session.lastError}
                          </p>
                        )}
                        <p className="mt-2 text-xs text-[var(--text-muted)]">
                          {formatRelativeTime(session.startedAt)}
                        </p>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </Card>

          <div className="min-h-0 space-y-6 overflow-y-auto pr-1">
            {detailContent}
          </div>
        </div>
      )}
    </div>
  )
}
