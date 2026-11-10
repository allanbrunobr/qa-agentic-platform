import { API_BASE } from '@/lib/api-base'
import { useState, useEffect, useCallback } from 'react'
import { Activity, Database, Play, AlertCircle } from 'lucide-react'
import { formatRelativeTime } from '@/lib/utils'


interface StatusData {
  api: 'up' | 'down'
  db: 'ok' | 'error'
  last_sync: string | null
  last_sync_source: string | null
  latest_activity_at: string | null
  latest_activity_source: 'runs' | 'p2_sessions' | null
  active_run: {
    id: number | string
    status: string
    started_at: string
    source?: 'runs' | 'p2_sessions'
  } | null
}

interface DashboardHealthStripProps {
  onSyncDetailsClick?: () => void
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${
        ok ? 'bg-green-400' : 'bg-red-400 animate-pulse'
      }`}
    />
  )
}

function ActiveRunAge({ startedAt }: { startedAt: string }) {
  const [, setTick] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 10_000)
    return () => clearInterval(interval)
  }, [])

  return <span>{formatRelativeTime(startedAt)}</span>
}

export function DashboardHealthStrip(_props: DashboardHealthStripProps) {
  const [status, setStatus] = useState<StatusData | null>(null)
  const [apiDown, setApiDown] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/status`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: StatusData = await res.json()
      setStatus(data)
      setApiDown(false)
    } catch {
      setApiDown(true)
      setStatus(prev =>
        prev ? { ...prev, api: 'down' } : {
          api: 'down',
          db: 'error',
          last_sync: null,
          last_sync_source: null,
          latest_activity_at: null,
          latest_activity_source: null,
          active_run: null,
        }
      )
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 10_000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  const activeRunStatus = status?.active_run
    ? status.active_run.status === 'running'
      ? 'running'
      : status.active_run.status
    : 'none'

  return (
    <div
      className="flex items-center gap-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-xs"
      role="status"
      aria-label="System status"
    >
      {/* API Status */}
      <div className="flex items-center gap-1.5">
        <Activity className="h-3 w-3 text-[var(--text-muted)]" />
        <span className="text-[var(--text-muted)]">API</span>
        <StatusDot ok={!apiDown && status?.api === 'up'} />
        <span className={apiDown || status?.api !== 'up' ? 'text-red-400 font-medium' : 'text-green-400'}>
          {apiDown || status?.api !== 'up' ? 'down' : 'up'}
        </span>
      </div>

      <div className="h-3 w-px bg-[var(--border)]" />

      {/* DB Status */}
      <div className="flex items-center gap-1.5">
        <Database className="h-3 w-3 text-[var(--text-muted)]" />
        <span className="text-[var(--text-muted)]">DB</span>
        <StatusDot ok={status?.db === 'ok'} />
        <span className={status?.db !== 'ok' ? 'text-red-400 font-medium' : 'text-green-400'}>
          {status?.db === 'ok' ? 'ok' : 'error'}
        </span>
      </div>

      <div className="h-3 w-px bg-[var(--border)]" />

      {/* Latest Activity */}
      <div className="flex items-center gap-1.5">
        <Activity className="h-3 w-3 text-[var(--text-muted)]" />
        <span className="text-[var(--text-muted)]">Activity</span>
        <span className="text-[var(--text-secondary)]">
          {status?.latest_activity_at ? formatRelativeTime(status.latest_activity_at) : 'never'}
        </span>
        {status?.latest_activity_source === 'p2_sessions' && (
          <span className="text-[var(--accent)]">agentic</span>
        )}
      </div>

      <div className="h-3 w-px bg-[var(--border)]" />

      {/* Active Run */}
      <div className="flex items-center gap-1.5">
        {activeRunStatus === 'running' ? (
          <>
            <Play className="h-3 w-3 text-teal-400 animate-pulse" />
            <span className="text-teal-400 font-medium">running</span>
            {status?.active_run?.source === 'p2_sessions' && (
              <span className="text-[var(--accent)]">agentic</span>
            )}
            {status?.active_run && (
              <span className="text-[var(--text-muted)]">
                (<ActiveRunAge startedAt={status.active_run.started_at} />)
              </span>
            )}
          </>
        ) : activeRunStatus === 'failed' ? (
          <>
            <AlertCircle className="h-3 w-3 text-red-400" />
            <span className="text-red-400 font-medium">failed</span>
          </>
        ) : activeRunStatus === 'pending' ? (
          <>
            <Play className="h-3 w-3 text-yellow-400" />
            <span className="text-yellow-400 font-medium">pending</span>
          </>
        ) : (
          <>
            <Play className="h-3 w-3 text-[var(--text-muted)]" />
            <span className="text-[var(--text-muted)]">none</span>
          </>
        )}
      </div>
    </div>
  )
}
