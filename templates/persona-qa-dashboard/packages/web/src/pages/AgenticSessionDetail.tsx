import { API_BASE } from '@/lib/api-base'
import { useState, useEffect } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StepHistoryPanel } from '@/components/StepHistoryPanel'
import { cn } from '@/lib/utils'


interface SessionDetail {
  id: string
  runId?: number
  scenarioId: string
  status: string
  startedAt: string
  completedAt?: string
  events: Array<{
    id: string
    type: string
    timestamp: string
    agentRole?: string
    data?: Record<string, unknown>
    payload?: Record<string, unknown>
  }>
  artifacts: Record<string, unknown>
  findings: Array<Record<string, unknown>>
  checkpoint: { lastCompletedStep: number; cursor: number }
}

interface AgenticSessionDetailProps {
  sessionId: string
  onBack?: () => void
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400',
  running: 'bg-blue-500/20 text-blue-400',
  complete: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  complete: 'Complete',
  failed: 'Failed',
}

function formatDateTime(ts: string): string {
  try {
    return new Date(ts).toLocaleString('en-US')
  } catch {
    return ts
  }
}

export function AgenticSessionDetail({ sessionId, onBack }: AgenticSessionDetailProps) {
  const [session, setSession] = useState<SessionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`${API_BASE}/api/p2/sessions/${sessionId}`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(data => setSession(data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [sessionId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-[var(--text-muted)]">
        Loading session...
      </div>
    )
  }

  if (error || !session) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <p className="text-sm text-red-400">Failed to load session: {error ?? 'not found'}</p>
        {onBack && (
          <Button variant="secondary" size="sm" onClick={onBack}>Back</Button>
        )}
      </div>
    )
  }

  const currentStep = session.events
    .filter(e => e.type === 'step_started')
    .map(e => e.data?.['stepId'] as string)
    .pop()

  const artifactKeys = Object.keys(session.artifacts)
  const findingEvents = session.events.filter(e => e.type === 'finding_recorded')
  const adaptationEvents = session.events.filter(e => e.type === 'adaptation_decision')
  const recoveryEvents = session.events.filter(e => e.type === 'recovery_decision' || e.type === 'interruption_recorded')

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {onBack && (
            <Button variant="secondary" size="sm" onClick={onBack}>
              Back
            </Button>
          )}
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            {session.scenarioId.replace(/_/g, ' ')}
          </h2>
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold',
              STATUS_COLORS[session.status] ?? 'bg-gray-500/20 text-gray-400'
            )}
          >
            {STATUS_LABELS[session.status] ?? session.status}
          </span>
        </div>
        <span className="font-mono text-xs text-[var(--text-muted)]">{session.id.slice(0, 8)}</span>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Status</p>
          <p className="mt-1 text-sm font-semibold text-[var(--text-primary)]">
            {STATUS_LABELS[session.status] ?? session.status}
          </p>
        </Card>
        <Card className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Events</p>
          <p className="mt-1 text-sm font-semibold text-[var(--text-primary)]">
            {session.events.length}
          </p>
        </Card>
        <Card className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Artifacts</p>
          <p className="mt-1 text-sm font-semibold text-[var(--text-primary)]">
            {artifactKeys.length}
          </p>
        </Card>
        <Card className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Findings</p>
          <p className="mt-1 text-sm font-semibold text-[var(--text-primary)]">
            {findingEvents.length}
          </p>
        </Card>
      </div>

      {/* Info row */}
      <div className="flex items-center gap-4 text-xs text-[var(--text-secondary)]">
        <span>Started: {formatDateTime(session.startedAt)}</span>
        {session.completedAt && <span>Ended: {formatDateTime(session.completedAt)}</span>}
        {session.status === 'running' && currentStep && (
          <span className="text-blue-400">Current step: {currentStep}</span>
        )}
      </div>

      {/* Artifacts */}
      {currentStep && (
        <StepHistoryPanel scenarioId={session.scenarioId} stepId={currentStep} />
      )}

      {/* Artifacts */}
      {artifactKeys.length > 0 && (
        <Card className="p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
            Collected artifacts
          </h3>
          <div className="flex flex-wrap gap-2">
            {artifactKeys.map(key => (
              <span
                key={key}
                className="inline-flex items-center rounded bg-[var(--bg-hover)] px-2 py-1 text-xs font-mono text-[var(--text-secondary)]"
              >
                {key}: {String(session.artifacts[key]).slice(0, 20)}
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* Findings */}
      {findingEvents.length > 0 && (
        <Card className="p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
            Findings ({findingEvents.length})
          </h3>
          <div className="space-y-2">
            {findingEvents.map(e => (
              <div key={e.id} className="flex items-center gap-2 text-xs">
                <span
                  className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                  style={{
                    color: (e.data?.['severity'] as string) === 'critical' ? '#ef4444' : '#f97316',
                    backgroundColor: (e.data?.['severity'] as string) === 'critical' ? 'rgba(239,68,68,0.2)' : 'rgba(249,115,22,0.2)',
                  }}
                >
                  {(e.data?.['severity'] as string) ?? 'info'}
                </span>
                <span className="text-[var(--text-primary)]">{(e.data?.['title'] as string) ?? 'Finding'}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {recoveryEvents.length > 0 && (
        <Card className="p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
            Recovery and interruptions
          </h3>
          <div className="space-y-2">
            {recoveryEvents.map(event => {
              const payload = event.payload ?? event.data ?? {}
              const decision = payload['decision']
              const outcome = payload['outcome']
              return (
                <div key={event.id} className="rounded border border-[var(--border)] p-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[var(--text-primary)]">{event.type}</span>
                    <span className="text-[var(--text-muted)]">{formatDateTime(event.timestamp)}</span>
                  </div>
                  <p className="mt-1 text-[var(--text-secondary)]">
                    Cause: {String(payload['cause'] ?? payload['reason'] ?? 'not recorded')}
                  </p>
                  {decision != null && (
                    <p className="text-[var(--text-secondary)]">Decision: {String(decision)}</p>
                  )}
                  {outcome != null && (
                    <p className="text-[var(--text-secondary)]">Outcome: {String(outcome)}</p>
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {adaptationEvents.length > 0 && (
        <Card className="p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
            Adaptation feed
          </h3>
          <div className="space-y-2">
            {adaptationEvents.map(event => {
              const payload = event.payload ?? event.data ?? {}
              const outcome = payload['outcome']
              return (
                <div key={event.id} className="rounded border border-[var(--border)] p-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[var(--text-primary)]">{String(payload['type'] ?? 'adaptation')}</span>
                    <span className="text-[var(--text-muted)]">confidence {String(payload['confidence'] ?? 'n/a')}</span>
                  </div>
                  <p className="mt-1 text-[var(--text-secondary)]">{String(payload['reason'] ?? '')}</p>
                  {outcome != null && (
                    <p className="text-[var(--text-secondary)]">Outcome: {String(outcome)}</p>
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Timeline */}
      <Card className="p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
          Timeline
        </h3>
        <div className="space-y-2">
          {session.events.map((event) => (
            <div key={event.id} className="flex items-start gap-3 rounded border border-[var(--border)] p-2 text-xs">
              <span className="min-w-32 text-[var(--text-muted)]">{formatDateTime(event.timestamp)}</span>
              <div>
                <p className="font-semibold text-[var(--text-primary)]">{event.type}</p>
                {event.agentRole && (
                  <p className="text-[var(--text-secondary)]">{event.agentRole}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
