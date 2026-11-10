import { API_BASE } from '@/lib/api-base'
import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/Badge'
import { SourceBadge } from '@/components/SourceBadge'
import { formatDuration, formatRelativeTime } from '@/lib/utils'
import { cn } from '@/lib/utils'
import type { ApiRun } from '@/lib/mock-data'


interface PaginationInfo {
  page: number
  limit: number
  total: number
  totalPages: number
}

interface ScenarioHistoryTableProps {
  scenarioId: string
  onNavigateToRun?: (runId: number) => void
  className?: string
}

type SortField = 'started_at' | 'status' | 'duration_ms' | 'passed' | 'failed'
type SortDir = 'asc' | 'desc'

function mapApiStatus(status: string): 'passed' | 'failed' | 'running' | 'skipped' {
  if (status === 'complete') return 'passed'
  if (status === 'failed') return 'failed'
  if (status === 'running') return 'running'
  return 'skipped'
}

export function ScenarioHistoryTable({ scenarioId, onNavigateToRun, className }: ScenarioHistoryTableProps) {
  const [runs, setRuns] = useState<ApiRun[]>([])
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, limit: 10, total: 0, totalPages: 0 })
  const [loading, setLoading] = useState(true)
  const [sortField, setSortField] = useState<SortField>('started_at')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const fetchRuns = useCallback((page: number) => {
    setLoading(true)
    fetch(`${API_BASE}/api/scenarios/${scenarioId}/runs?page=${page}&limit=10`)
      .then(res => res.json())
      .then((data: { runs: ApiRun[]; pagination: PaginationInfo }) => {
        setRuns(data.runs)
        setPagination(data.pagination)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [scenarioId])

  useEffect(() => {
    fetchRuns(1)
  }, [fetchRuns])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  const sorted = [...runs].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1
    switch (sortField) {
      case 'started_at':
        return dir * (new Date(a.started_at).getTime() - new Date(b.started_at).getTime())
      case 'status':
        return dir * a.status.localeCompare(b.status)
      case 'duration_ms':
        return dir * ((a.duration_ms ?? 0) - (b.duration_ms ?? 0))
      case 'passed':
        return dir * (a.passed - b.passed)
      case 'failed':
        return dir * (a.failed - b.failed)
      default:
        return 0
    }
  })

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null
    return sortDir === 'asc'
      ? <ChevronUp className="inline h-3 w-3" />
      : <ChevronDown className="inline h-3 w-3" />
  }

  return (
    <div className={className}>
      <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">
        Run history
      </h3>
      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-xs text-[var(--text-muted)]">
            Loading...
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-xs text-[var(--text-muted)]">
            No runs found
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--bg-primary)]">
                    <th className="px-4 py-2.5 text-left font-medium text-[var(--text-muted)]">
                      Run
                    </th>
                    <th
                      className="px-4 py-2.5 text-left font-medium text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-secondary)]"
                      onClick={() => handleSort('started_at')}
                    >
                      Data <SortIcon field="started_at" />
                    </th>
                    <th
                      className="px-4 py-2.5 text-left font-medium text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-secondary)]"
                      onClick={() => handleSort('status')}
                    >
                      Status <SortIcon field="status" />
                    </th>
                    <th
                      className="px-4 py-2.5 text-left font-medium text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-secondary)]"
                      onClick={() => handleSort('duration_ms')}
                    >
                      Duration <SortIcon field="duration_ms" />
                    </th>
                    <th
                      className="px-4 py-2.5 text-center font-medium text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-secondary)]"
                      onClick={() => handleSort('passed')}
                    >
                      Passed <SortIcon field="passed" />
                    </th>
                    <th
                      className="px-4 py-2.5 text-center font-medium text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-secondary)]"
                      onClick={() => handleSort('failed')}
                    >
                      Failed <SortIcon field="failed" />
                    </th>
                    <th className="px-4 py-2.5 text-left font-medium text-[var(--text-muted)]">
                      Source
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((run, idx) => (
                    <motion.tr
                      key={run.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: idx * 0.03 }}
                      onClick={() => onNavigateToRun?.(run.id)}
                      className={cn(
                        'border-b border-[var(--border)]/50 transition-colors',
                        onNavigateToRun && 'cursor-pointer hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <td className="px-4 py-2.5 font-mono text-[var(--text-muted)]">
                        #{run.id.toString().padStart(4, '0')}
                      </td>
                      <td className="px-4 py-2.5 text-[var(--text-secondary)]">
                        {formatRelativeTime(run.started_at)}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={mapApiStatus(run.status)} />
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[var(--text-secondary)]">
                        {run.duration_ms ? formatDuration(Math.round(run.duration_ms / 1000)) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className="tabular-nums text-green-400">{run.passed}</span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className="tabular-nums text-red-400">{run.failed}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <SourceBadge source={(run as ApiRun & { run_source?: string }).run_source} />
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {pagination.totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-2.5">
                <span className="text-[10px] text-[var(--text-muted)]">
                  Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => fetchRuns(pagination.page - 1)}
                    disabled={pagination.page <= 1}
                    className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => fetchRuns(pagination.page + 1)}
                    disabled={pagination.page >= pagination.totalPages}
                    className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  )
}
