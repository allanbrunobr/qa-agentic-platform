import { API_BASE, wsBase } from '@/lib/api-base'
import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, ChevronUp, Clock, AlertTriangle, Radio, Link2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { StatusBadge, SeverityBadge } from '@/components/ui/Badge'
import type { ApiRun } from '@/lib/mock-data'
import { formatDuration, formatRelativeTime } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { LiveLog, type LogEvent } from '@/components/LiveLog'
import { api } from '@/lib/api'
import { RunSourceBadge } from '@/components/RunSourceBadge'
import { ArtifactsSection } from '@/components/ArtifactsSection'
import { EvidenceSummary } from '@/components/EvidenceSummary'
import { RunFilters, EMPTY_FILTERS, type RunFilterState } from '@/components/RunFilters'
import { DataExport } from '@/components/DataExport'
import { EmptyState } from '@/components/EmptyState'

// Extended API run type with new fields from Stories 2.1, 2.3, 5.1
interface ApiRunExtended extends ApiRun {
  run_source?: string | null
  artifacts?: string | null
  suite_type?: string | null
  clean_db_before_run?: boolean | null
  started_by?: string | null
  error_message?: string | null
  screenshots_count?: number
  log_entries_count?: number
  context_available?: boolean
}

interface RunFindingDetail {
  id: number
  run_id: number
  finding_id: string
  agent: string
  step: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  title: string
  expected: string
  actual: string
  screenshot_path: string | null
  timestamp: string
}

interface RunPrLink {
  id: number
  run_id: number
  pr_number: number
  gate_status: 'passed' | 'blocked'
  created_at: string
}

interface RunDetailPayload extends Omit<ApiRunExtended, 'artifacts'> {
  findings?: RunFindingDetail[]
  pr_links?: RunPrLink[]
  artifacts?: Record<string, unknown> | string | null
}


interface RunsProps {
  activeRunId?: number | null
}

function LoadingState() {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-[var(--text-muted)]">
      Loading...
    </div>
  )
}

function mapApiStatus(status: string): 'passed' | 'failed' | 'running' | 'skipped' {
  if (status === 'complete') return 'passed'
  if (status === 'failed') return 'failed'
  if (status === 'running') return 'running'
  if (status === 'pending') return 'running'
  return 'skipped'
}

function formatDurationMs(ms: number | null): string {
  if (!ms) return '0s'
  return formatDuration(Math.round(ms / 1000))
}

function parseArtifacts(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return null }
  }
  return null
}

function normalizeRunDetail(raw: unknown): RunDetailPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<RunDetailPayload>
  return {
    ...(value as RunDetailPayload),
    findings: Array.isArray(value.findings) ? value.findings : [],
    pr_links: Array.isArray(value.pr_links) ? value.pr_links : [],
    artifacts: value.artifacts ?? null,
  }
}

function formatNullable(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function copyableValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  return String(value)
}

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </p>
      <div className="mt-1 text-sm text-[var(--text-primary)] break-words">
        {value}
      </div>
    </div>
  )
}

function getInitialFilters(): RunFilterState {
  try {
    const params = new URLSearchParams(window.location.search)
    return {
      scenario: params.get('scenario') ?? '',
      status: params.get('status') ?? '',
      source: params.get('source') ?? '',
      from: params.get('from') ?? '',
      to: params.get('to') ?? '',
      has_findings: params.get('has_findings') ?? '',
    }
  } catch {
    return { ...EMPTY_FILTERS }
  }
}

export function Runs({ activeRunId }: RunsProps) {
  const [runs, setRuns] = useState<ApiRun[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(activeRunId ?? null)
  const [liveEvents, setLiveEvents] = useState<LogEvent[]>([])
  const [liveStatus, setLiveStatus] = useState<'running' | 'complete' | 'failed'>('running')
  const wsRef = useRef<WebSocket | null>(null)
  const [filters, setFilters] = useState<RunFilterState>(getInitialFilters)
  const [runDetails, setRunDetails] = useState<Record<number, RunDetailPayload | null>>({})
  const [runDetailLoading, setRunDetailLoading] = useState<Record<number, boolean>>({})
  const [runDetailErrors, setRunDetailErrors] = useState<Record<number, string | null>>({})

  // Persist filter state in URL query params
  const handleFilterChange = useCallback((newFilters: RunFilterState) => {
    setFilters(newFilters)
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(newFilters)) {
      if (value) params.set(key, value)
    }
    const qs = params.toString()
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    window.history.replaceState(null, '', newUrl)
  }, [])

  // Fetch runs from API with filters
  useEffect(() => {
    const params: Record<string, string> = {}
    for (const [key, value] of Object.entries(filters)) {
      if (value) params[key] = value
    }
    const qs = new URLSearchParams(params).toString()
    const url = qs
      ? `${API_BASE}/api/runs?${qs}`
      : `${API_BASE}/api/runs`

    fetch(url)
      .then(r => r.json())
      .then(d => setRuns(d as ApiRun[]))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [filters])

  // Auto-expand active run
  useEffect(() => {
    if (activeRunId) setExpandedId(activeRunId)
  }, [activeRunId])

  const loadRunDetail = useCallback(async (runId: number) => {
    if (runDetails[runId] || runDetailLoading[runId]) return

    setRunDetailLoading(prev => ({ ...prev, [runId]: true }))
    setRunDetailErrors(prev => ({ ...prev, [runId]: null }))

    try {
      const detail = normalizeRunDetail(await api.getRun(runId))
      setRunDetails(prev => ({ ...prev, [runId]: detail }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load run details'
      setRunDetailErrors(prev => ({ ...prev, [runId]: message }))
    } finally {
      setRunDetailLoading(prev => ({ ...prev, [runId]: false }))
    }
  }, [runDetailLoading, runDetails])

  // WebSocket for live run
  useEffect(() => {
    if (!activeRunId) return

    const ws = new WebSocket(`${wsBase()}/ws/runs/${activeRunId}`)
    wsRef.current = ws

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)

        if (msg.type === 'log') {
          const raw = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload)
          let logEvent: LogEvent
          try {
            const parsed = JSON.parse(raw) as LogEvent
            logEvent = parsed.type && parsed.message ? parsed : {
              type: 'system', timestamp: '', message: raw, raw,
            }
          } catch {
            logEvent = { type: 'system', timestamp: '', message: raw, raw }
          }
          setLiveEvents(prev => [...prev, logEvent])
        }

        if (msg.type === 'complete' || (msg.type === 'status' && (msg.payload?.status === 'complete' || msg.payload?.status === 'failed'))) {
          const status = msg.payload?.status || 'complete'
          setLiveStatus(status)
        }
      } catch { /* ignore */ }
    }

    return () => { ws.close(); wsRef.current = null }
  }, [activeRunId])

  useEffect(() => {
    if (expandedId) {
      void loadRunDetail(expandedId)
    }
  }, [expandedId, loadRunDetail])

  if (loading) return <LoadingState />

  // Build display list: mark active run as live
  interface DisplayRun extends ApiRun {
    isLive?: boolean
  }

  const allRuns: DisplayRun[] = runs.map(r => ({
    ...r,
    isLive: r.id === activeRunId,
  }))

  if (allRuns.length === 0) return (
    <EmptyState
      title="No runs found"
      description="Run tests with pnpm test:persona-qa"
    />
  )

  return (
    <div className="p-6">
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <RunFilters filters={filters} onChange={handleFilterChange} />
          <DataExport filterParams={Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== ''))} />
        </div>
        <p className="mt-3 text-sm text-[var(--text-muted)]">
          {allRuns.length} runs found
        </p>
      </div>

      <div className="space-y-3">
        {allRuns.map((run, index) => {
          const isExpanded = expandedId === run.id
          const isLive = run.id === activeRunId
          const displayStatus = mapApiStatus(run.status)
          const detail = runDetails[run.id] ?? null
          const detailLoading = Boolean(runDetailLoading[run.id])
          const detailError = runDetailErrors[run.id]
          const mergedDetail = detail ?? normalizeRunDetail({
            ...run,
            findings: [],
            pr_links: [],
            artifacts: (run as ApiRunExtended).artifacts ?? null,
          })
          const artifacts = parseArtifacts(detail?.artifacts ?? (run as ApiRunExtended).artifacts)
          const findings = detail?.findings ?? []
          const prLinks = detail?.pr_links ?? []
          const primaryArtifacts = artifacts
            ? ['customer_id', 'order_id', 'cancelled_order_id', 'modified_order_id', 'shipment_id', 'invoice_id']
                .filter(key => key in artifacts)
            : []

          return (
            <motion.div
              key={run.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.04 }}
            >
              <Card className={cn('overflow-hidden p-0', isLive && liveStatus === 'running' && 'border-[var(--accent)]/40')}>
                {/* Run card header */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : run.id)}
                  className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <div
                    className={cn('h-8 w-1 shrink-0 rounded-full', isLive && liveStatus === 'running' && 'animate-pulse')}
                    style={{
                      backgroundColor:
                        displayStatus === 'passed' ? 'var(--success)' :
                        displayStatus === 'failed' ? 'var(--danger)' :
                        displayStatus === 'running' ? 'var(--accent)' :
                        'var(--border)',
                    }}
                  />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-[var(--text-muted)]">
                        #{run.id.toString().padStart(4, '0')}
                      </span>
                      <h3 className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {run.scenario_name}
                      </h3>
                      <RunSourceBadge source={(run as ApiRunExtended).run_source} />
                      {isLive && liveStatus === 'running' && (
                        <Radio className="h-3.5 w-3.5 text-[var(--accent)] animate-pulse" />
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 text-xs text-[var(--text-muted)]">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {isLive ? 'just now' : formatRelativeTime(run.started_at)}
                      </span>
                      {run.duration_ms && run.status !== 'running' && (
                        <span>{formatDurationMs(run.duration_ms)}</span>
                      )}
                      {isLive && (
                        <span className="text-[var(--accent)]">{liveEvents.length} events</span>
                      )}
                    </div>
                    <EvidenceSummary
                      findingsCount={run.findings_count}
                      screenshotsCount={(run as ApiRunExtended).screenshots_count}
                      artifactsCount={(run as unknown as { artifacts_count?: number }).artifacts_count}
                      contextAvailable={(run as ApiRunExtended).context_available}
                      className="mt-0.5"
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    {run.findings_count > 0 && (
                      <span className="flex items-center gap-1 text-xs text-[var(--warning)]">
                        <AlertTriangle className="h-3 w-3" />
                        {run.findings_count}
                      </span>
                    )}
                    <StatusBadge status={displayStatus} />
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4 text-[var(--text-muted)]" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />
                    )}
                  </div>
                </button>

                {/* Expanded detail */}
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden border-t border-[var(--border)]"
                    >
                      <div className="p-4 space-y-4">
                        {detailLoading && (
                          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-xs text-[var(--text-muted)]">
                            Loading run details...
                          </div>
                        )}
                        {detailError && (
                          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                            {detailError}
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                          <DetailField label="Run" value={`#${run.id.toString().padStart(4, '0')}`} />
                          <DetailField label="Status" value={<StatusBadge status={displayStatus} />} />
                          <DetailField label="Source" value={<RunSourceBadge source={(run as ApiRunExtended).run_source} />} />
                          <DetailField label="Scenario" value={run.scenario_name} />
                          <DetailField label="Session" value={<span className="font-mono text-xs">{run.session_id}</span>} />
                          <DetailField label="Started by" value={formatNullable(mergedDetail?.started_by)} />
                          <DetailField label="Suite type" value={formatNullable(mergedDetail?.suite_type)} />
                          <DetailField label="Clean DB" value={formatNullable(mergedDetail?.clean_db_before_run)} />
                        </div>

                        <div className="grid grid-cols-4 gap-4">
                          <div className="rounded-lg bg-[var(--bg-primary)] p-3 text-center">
                            <p className="text-lg font-bold tabular-nums text-[var(--text-primary)]">{run.total_tests}</p>
                            <p className="text-[10px] text-[var(--text-muted)]">Total tests</p>
                          </div>
                          <div className="rounded-lg bg-[var(--bg-primary)] p-3 text-center">
                            <p className="text-lg font-bold tabular-nums text-[var(--success)]">{run.passed}</p>
                            <p className="text-[10px] text-[var(--text-muted)]">Passed</p>
                          </div>
                          <div className="rounded-lg bg-[var(--bg-primary)] p-3 text-center">
                            <p className="text-lg font-bold tabular-nums text-[var(--danger)]">{run.failed}</p>
                            <p className="text-[10px] text-[var(--text-muted)]">Failed</p>
                          </div>
                          <div className="rounded-lg bg-[var(--bg-primary)] p-3 text-center">
                            <p className="text-lg font-bold tabular-nums text-[var(--text-muted)]">{run.skipped}</p>
                            <p className="text-[10px] text-[var(--text-muted)]">Skipped</p>
                          </div>
                        </div>

                        <div className="grid gap-3 lg:grid-cols-2">
                          <div className="rounded-lg bg-[var(--bg-primary)] p-3">
                            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                              Findings
                            </p>
                            {run.findings_count > 0 ? (
                              <div className="flex flex-wrap gap-2">
                                {run.critical_count > 0 && (
                                  <div className="flex items-center gap-1.5">
                                    <SeverityBadge severity="critical" />
                                    <span className="text-xs font-semibold text-[var(--text-primary)]">
                                      {run.critical_count}
                                    </span>
                                  </div>
                                )}
                                {run.high_count > 0 && (
                                  <div className="flex items-center gap-1.5">
                                    <SeverityBadge severity="high" />
                                    <span className="text-xs font-semibold text-[var(--text-primary)]">
                                      {run.high_count}
                                    </span>
                                  </div>
                                )}
                                {run.findings_count - run.critical_count - run.high_count > 0 && (
                                  <span className="text-xs text-[var(--text-muted)]">
                                    +{run.findings_count - run.critical_count - run.high_count} more
                                  </span>
                                )}
                              </div>
                            ) : (
                              <p className="text-xs text-[var(--text-muted)]">No findings</p>
                            )}
                          </div>

                          <div className="rounded-lg bg-[var(--bg-primary)] p-3">
                            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                              Evidence
                            </p>
                            <div className="flex flex-wrap gap-2 text-xs text-[var(--text-muted)]">
                              <span>Findings: {run.findings_count}</span>
                              <span>Screenshots: {(run as ApiRunExtended).screenshots_count ?? 0}</span>
                              <span>Artifacts: {Object.keys(artifacts ?? {}).length}</span>
                              <span>Context: {(run as ApiRunExtended).context_available ? 'yes' : 'no'}</span>
                              <span>Logs: {(run as ApiRunExtended).log_entries_count ?? liveEvents.length}</span>
                            </div>
                          </div>
                        </div>

                        {primaryArtifacts.length > 0 && (
                          <div className="rounded-lg bg-[var(--bg-primary)] p-3">
                            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                              Key artifacts
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {primaryArtifacts.map(key => (
                                <span key={key} className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-xs text-[var(--text-primary)] font-mono">
                                  {key}: {copyableValue(artifacts?.[key])}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        <ArtifactsSection
                          artifacts={artifacts}
                          defaultOpen
                          className="mt-1"
                        />

                        {findings.length > 0 && (
                          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3">
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                                Findings for this run
                              </p>
                              <span className="text-xs text-[var(--text-muted)]">
                                {findings.length} finding{findings.length !== 1 ? 's' : ''}
                              </span>
                            </div>
                            <div className="space-y-2">
                              {findings.slice(0, 8).map(finding => (
                                <div key={finding.id} className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <SeverityBadge severity={finding.severity} />
                                        <span className="text-xs text-[var(--text-muted)]">{finding.agent}</span>
                                        <span className="text-xs text-[var(--text-muted)]">{finding.step}</span>
                                      </div>
                                      <p className="mt-1 text-sm text-[var(--text-primary)]">{finding.title}</p>
                                    </div>
                                    {finding.screenshot_path && (
                                      <a
                                        href={api.getFindingScreenshotUrl(finding.id)}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-xs text-[var(--accent)] hover:underline shrink-0"
                                      >
                                        Screenshot
                                      </a>
                                    )}
                                  </div>
                                  <div className="mt-2 grid gap-2 text-xs text-[var(--text-muted)] lg:grid-cols-2">
                                    <div>
                                      <p className="font-semibold uppercase tracking-wide text-[var(--text-muted)]">Expected</p>
                                      <p className="mt-1 whitespace-pre-wrap text-[var(--text-secondary)]">{finding.expected}</p>
                                    </div>
                                    <div>
                                      <p className="font-semibold uppercase tracking-wide text-[var(--text-muted)]">Actual</p>
                                      <p className="mt-1 whitespace-pre-wrap text-[var(--text-secondary)]">{finding.actual}</p>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {prLinks.length > 0 && (
                          <div className="rounded-lg bg-[var(--bg-primary)] p-3">
                            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                              PR Links
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {prLinks.map(link => (
                                <span key={link.id} className={cn(
                                  'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
                                  link.gate_status === 'passed'
                                    ? 'border-green-500/30 bg-green-500/10 text-green-400'
                                    : 'border-red-500/30 bg-red-500/10 text-red-400',
                                )}>
                                  <Link2 className="h-3 w-3" />
                                  PR #{link.pr_number}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        <details className="rounded-lg bg-[var(--bg-primary)] p-3">
                          <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                            Debug raw
                          </summary>
                          <pre className="mt-3 max-h-72 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 text-[11px] text-[var(--text-secondary)]">
                            {JSON.stringify({
                              run,
                              detail: mergedDetail,
                              artifacts,
                            }, null, 2)}
                          </pre>
                        </details>

                        {isLive || run.status === 'running' || run.status === 'pending' ? (
                          <div>
                            <div className="mb-2 flex items-center justify-between">
                              <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                                Live log
                              </p>
                              <span className="text-xs text-[var(--text-muted)]">{liveEvents.length} events</span>
                            </div>
                            {liveEvents.length > 0 ? (
                              <LiveLog events={liveEvents} className="max-h-96" />
                            ) : (
                              <p className="text-center text-xs text-[var(--text-muted)] py-8">
                                Waiting for test output...
                              </p>
                            )}
                          </div>
                        ) : null}

                        {run.duration_ms && (
                          <div className="text-xs text-[var(--text-muted)]">
                            Duration: {formatDurationMs(run.duration_ms)}
                            {run.completed_at && (
                              <> &middot; Completed {formatRelativeTime(run.completed_at)}</>
                            )}
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </Card>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
