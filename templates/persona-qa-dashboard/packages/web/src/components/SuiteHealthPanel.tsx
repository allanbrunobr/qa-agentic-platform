import { API_BASE } from '@/lib/api-base'
import { useState, useEffect } from 'react'
import { CheckCircle, XCircle, AlertTriangle, Clock, Play, Database, RefreshCw } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { formatRelativeTime } from '@/lib/utils'


interface ScenarioHealth {
  scenario_id: string
  scenario_name: string
  status: 'pass' | 'fail'
  passed: number
  failed: number
  started_at: string
}

interface SuiteHealthData {
  last_run: {
    status: 'pass' | 'fail'
    started_at: string
    total_tests: number
    passed: number
    failed: number
    skipped: number
    scenario_count: number
    is_full_suite: boolean
  } | null
  scenarios: ScenarioHealth[]
  passed_scenarios: number
  failed_scenarios: number
  scenarios_without_runs: Array<{ scenario_id: string; name: string }>
  is_stale: boolean
  db_clean_required: boolean
}

interface SuiteHealthPanelProps {
  onExecuteTests?: () => void
}

function normalizeSuiteHealthData(raw: Partial<SuiteHealthData> | null | undefined): SuiteHealthData {
  return {
    last_run: raw?.last_run ?? null,
    scenarios: Array.isArray(raw?.scenarios) ? raw.scenarios : [],
    passed_scenarios: typeof raw?.passed_scenarios === 'number' ? raw.passed_scenarios : 0,
    failed_scenarios: typeof raw?.failed_scenarios === 'number' ? raw.failed_scenarios : 0,
    scenarios_without_runs: Array.isArray(raw?.scenarios_without_runs) ? raw.scenarios_without_runs : [],
    is_stale: Boolean(raw?.is_stale),
    db_clean_required: Boolean(raw?.db_clean_required),
  }
}

export function SuiteHealthPanel({ onExecuteTests }: SuiteHealthPanelProps) {
  const [data, setData] = useState<SuiteHealthData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${API_BASE}/api/suite-health`)
      .then(res => res.json())
      .then((d: Partial<SuiteHealthData>) => setData(normalizeSuiteHealthData(d)))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <Card className="p-6">
        <div className="flex h-32 items-center justify-center text-xs text-[var(--text-muted)]">
          Loading suite health...
        </div>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card className="p-6">
        <div className="flex h-32 items-center justify-center text-xs text-[var(--text-muted)]">
          Failed to load suite health
        </div>
      </Card>
    )
  }

  const lastRunFailed = data.last_run?.status === 'fail'

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            Test suite health
          </h2>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            Tracked separately from dashboard health
          </p>
        </div>
        {lastRunFailed && onExecuteTests && (
          <Button
            variant="danger"
            size="sm"
            icon={<Play className="h-3 w-3" />}
            onClick={onExecuteTests}
          >
            Run tests
          </Button>
        )}
      </div>

      {/* Last Full Suite Run */}
      <div className="mb-4 rounded-lg bg-[var(--bg-primary)] p-4">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
          {data.last_run?.is_full_suite
            ? 'Last full suite run'
            : 'Aggregated result (partial coverage)'}
        </div>
        {!data.last_run?.is_full_suite && data.last_run && (
          <div className="mb-2 rounded-md bg-yellow-500/10 border border-yellow-500/20 px-2 py-1">
            <span className="text-xs text-yellow-400">
              Not all scenarios ran. Aggregated result of the {data.last_run.scenario_count} scenarios that ran.
            </span>
          </div>
        )}
        {data.last_run ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {data.last_run.status === 'pass' ? (
                <CheckCircle className="h-4 w-4 text-green-400" />
              ) : (
                <XCircle className="h-4 w-4 text-red-400" />
              )}
              <span
                className={`text-sm font-semibold ${
                  data.last_run.status === 'pass' ? 'text-green-400' : 'text-red-400'
                }`}
              >
                {data.last_run.status === 'pass' ? 'Passed' : 'Failed'}
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                — {data.last_run.scenario_count} scenario{data.last_run.scenario_count !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div>
                <p className="text-lg font-bold tabular-nums text-[var(--text-primary)]">
                  {data.last_run.total_tests}
                </p>
                <p className="text-[10px] text-[var(--text-muted)]">Total</p>
              </div>
              <div>
                <p className="text-lg font-bold tabular-nums text-green-400">
                  {data.last_run.passed}
                </p>
                <p className="text-[10px] text-[var(--text-muted)]">Passed</p>
              </div>
              <div>
                <p className="text-lg font-bold tabular-nums text-red-400">
                  {data.last_run.failed}
                </p>
                <p className="text-[10px] text-[var(--text-muted)]">Failed</p>
              </div>
              <div>
                <p className="text-lg font-bold tabular-nums text-[var(--text-muted)]">
                  {data.last_run.skipped}
                </p>
                <p className="text-[10px] text-[var(--text-muted)]">Skipped</p>
              </div>
            </div>
            <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
              <Clock className="h-3 w-3" />
              {formatRelativeTime(data.last_run.started_at)}
            </div>
          </div>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">No runs found</p>
        )}
      </div>

      {/* Scenarios by status */}
      {data.scenarios.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Scenarios ({data.passed_scenarios} passed / {data.failed_scenarios} failed)
          </div>
          <div className="space-y-1.5">
            {data.scenarios.map(s => (
              <div
                key={s.scenario_id}
                className="flex items-center justify-between rounded-lg bg-[var(--bg-primary)] px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  {s.status === 'pass' ? (
                    <CheckCircle className="h-3.5 w-3.5 text-green-400" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-red-400" />
                  )}
                  <span className="text-xs text-[var(--text-primary)]">{s.scenario_name}</span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-green-400">{s.passed}P</span>
                  <span className="text-red-400">{s.failed}F</span>
                  <span className="text-[var(--text-muted)]">
                    {formatRelativeTime(s.started_at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scenarios without runs */}
      {data.scenarios_without_runs.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Scenarios without a recent run
          </div>
          <div className="space-y-1">
            {data.scenarios_without_runs.map(s => (
              <div key={s.scenario_id} className="flex items-center gap-2 px-3 py-1.5">
                <AlertTriangle className="h-3 w-3 text-yellow-400" />
                <span className="text-xs text-[var(--text-muted)]">{s.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Indicators */}
      <div className="flex items-center gap-4">
        {data.is_stale && (
          <div className="flex items-center gap-1.5 rounded-md bg-yellow-500/10 border border-yellow-500/20 px-2 py-1">
            <RefreshCw className="h-3 w-3 text-yellow-400" />
            <span className="text-xs text-yellow-400">Stale data</span>
          </div>
        )}
        {data.db_clean_required && (
          <div className="flex items-center gap-1.5 rounded-md bg-orange-500/10 border border-orange-500/20 px-2 py-1">
            <Database className="h-3 w-3 text-orange-400" />
            <span className="text-xs text-orange-400">Cleanup recommended</span>
          </div>
        )}
      </div>
    </Card>
  )
}
