import { API_BASE } from '@/lib/api-base'
import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import {
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  FileText,
} from 'lucide-react'
import { cn } from '@/lib/utils'


interface TimelineEvent {
  id: string
  type: 'setup' | 'artifact' | 'finding' | 'scenario_complete' | 'scenario_failed' | 'sync'
  label: string
  timestamp: string
  durationFromPrev: number | null
}

interface RunTimelineProps {
  runId: number
  className?: string
}

const EVENT_CONFIG: Record<
  TimelineEvent['type'],
  { icon: typeof Play; color: string; bgColor: string }
> = {
  setup: { icon: Play, color: '#2dd4bf', bgColor: 'rgba(45,212,191,0.15)' },
  artifact: { icon: FileText, color: '#a78bfa', bgColor: 'rgba(167,139,250,0.15)' },
  finding: { icon: AlertTriangle, color: '#f97316', bgColor: 'rgba(249,115,22,0.15)' },
  scenario_complete: { icon: CheckCircle2, color: '#22c55e', bgColor: 'rgba(34,197,94,0.15)' },
  scenario_failed: { icon: XCircle, color: '#ef4444', bgColor: 'rgba(239,68,68,0.15)' },
  sync: { icon: RefreshCw, color: '#3b82f6', bgColor: 'rgba(59,130,246,0.15)' },
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ts
  }
}

export function RunTimeline({ runId, className }: RunTimelineProps) {
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`${API_BASE}/api/runs/${runId}/timeline`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data: { events: TimelineEvent[] }) => setEvents(data.events))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [runId])

  if (loading) {
    return (
      <div className={cn('flex items-center justify-center py-8 text-xs text-[var(--text-muted)]', className)}>
        Loading timeline...
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('flex items-center justify-center py-8 text-xs text-red-400', className)}>
        Failed to load timeline: {error}
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className={cn('flex items-center justify-center py-8 text-xs text-[var(--text-muted)]', className)}>
        No timeline events available
      </div>
    )
  }

  return (
    <div className={cn('relative', className)}>
      <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Run timeline
      </h4>
      <div className="relative">
        {events.map((event, index) => {
          const config = EVENT_CONFIG[event.type]
          const Icon = config.icon

          return (
            <motion.div
              key={event.id}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.08 }}
              className="relative flex gap-3 pb-4 last:pb-0"
            >
              {/* Vertical connector line */}
              {index < events.length - 1 && (
                <div
                  className="absolute left-[15px] top-[32px] bottom-0 w-px"
                  style={{ backgroundColor: 'var(--border)' }}
                />
              )}

              {/* Icon circle */}
              <div
                className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                style={{ backgroundColor: config.bgColor, border: `2px solid ${config.color}40` }}
              >
                <Icon className="h-3.5 w-3.5" style={{ color: config.color }} />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 pt-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    {event.label}
                  </span>
                  {event.durationFromPrev != null && event.durationFromPrev > 0 && (
                    <span className="shrink-0 rounded bg-[var(--bg-hover)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">
                      +{formatDurationMs(event.durationFromPrev)}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-mono text-[var(--text-muted)]">
                  {formatTimestamp(event.timestamp)}
                </span>
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
