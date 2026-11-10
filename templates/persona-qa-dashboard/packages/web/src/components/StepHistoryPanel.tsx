import { API_BASE } from '@/lib/api-base'
import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'


interface StepHistory {
  totalExecutions: number
  successRate: number
  averageDurationMs: number
  p95DurationMs: number
  retryRecoveryRate: number
  failureBreakdown: Record<string, number>
  patterns: Array<{ category: string; signature: string; count: number; mitigation: string }>
  adaptations: Array<{ type: string; reason: string; confidence: number; outcome?: string; timestamp: string }>
}

export function StepHistoryPanel({ scenarioId, stepId }: { scenarioId: string; stepId: string }) {
  const [history, setHistory] = useState<StepHistory | null>(null)

  useEffect(() => {
    const scenario = encodeURIComponent(scenarioId)
    const step = encodeURIComponent(stepId)

    fetch(`${API_BASE}/api/p2/scenarios/${scenario}/steps/${step}/history`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => setHistory(data))
      .catch(() => setHistory(null))
  }, [scenarioId, stepId])

  if (!history) return null

  return (
    <Card className="p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
        Step history
      </h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <Metric label="Runs" value={String(history.totalExecutions)} />
        <Metric label="Success rate" value={`${Math.round(history.successRate * 100)}%`} />
        <Metric label="Avg duration" value={`${history.averageDurationMs}ms`} />
        <Metric label="P95" value={`${history.p95DurationMs}ms`} />
      </div>

      {Object.keys(history.failureBreakdown).length > 0 && (
        <div className="mt-4">
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Failures</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {Object.entries(history.failureBreakdown).map(([category, count]) => (
              <span key={category} className="rounded bg-[var(--bg-hover)] px-2 py-1 text-xs text-[var(--text-secondary)]">
                {category}: {count}
              </span>
            ))}
          </div>
        </div>
      )}

      {history.patterns.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Known patterns</p>
          {history.patterns.slice(0, 3).map((pattern) => (
            <div key={`${pattern.category}-${pattern.signature}`} className="rounded border border-[var(--border)] p-2 text-xs">
              <p className="font-semibold text-[var(--text-primary)]">{pattern.category} · {pattern.count}x</p>
              <p className="text-[var(--text-secondary)]">{pattern.mitigation}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[var(--border)] p-2">
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 font-semibold text-[var(--text-primary)]">{value}</p>
    </div>
  )
}
