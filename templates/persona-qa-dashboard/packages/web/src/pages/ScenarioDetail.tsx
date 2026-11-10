import { API_BASE } from '@/lib/api-base'
import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, Users, Layers } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { PERSONA_COLORS } from '@/lib/mock-data'
import type { ApiRun, ApiFinding } from '@/lib/mock-data'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { ScenarioMetrics } from '@/components/ScenarioMetrics'
import { RecentRuns } from '@/components/RecentRuns'
import { RecentFindings } from '@/components/RecentFindings'
import { ScenarioHistoryTable } from '@/components/ScenarioHistoryTable'
import { RunTimeline } from '@/components/RunTimeline'


interface ScenarioDetailProps {
  scenarioId: string
  onBack: () => void
  onNavigateToRun?: (runId: number) => void
}

interface ScenarioStep {
  id: string
  description: string
  agent: string
  [key: string]: unknown
}

interface ScenarioDetailData {
  id: number
  scenario_id: string
  name: string
  description: string | null
  step_count: number
  agent_count: number
  last_run_at: string | null
  last_status: string | null
  steps: ScenarioStep[]
  raw: Record<string, unknown>
}

interface ScenarioStatsData {
  latestRun: ApiRun | null
  recentRuns: ApiRun[]
  successRate: number
  avgDurationMs: number | null
  totalFindings: number
  lastFinding: ApiFinding | null
}

function LoadingState() {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-[var(--text-muted)]">
      Loading...
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
      <p className="text-sm">{message}</p>
      <p className="text-xs">Run tests to populate data</p>
    </div>
  )
}

export function ScenarioDetail({ scenarioId, onBack, onNavigateToRun }: ScenarioDetailProps) {
  const [scenario, setScenario] = useState<ScenarioDetailData | null>(null)
  const [stats, setStats] = useState<ScenarioStatsData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [scenarioData, statsData] = await Promise.all([
          api.getScenario(scenarioId),
          fetch(`${API_BASE}/api/scenarios/${scenarioId}/stats`).then(r => r.ok ? r.json() : null),
        ])
        setScenario(scenarioData as ScenarioDetailData)
        setStats(statsData as ScenarioStatsData | null)
      } catch { /* ignore */ }
      setLoading(false)
    }
    fetchData()
  }, [scenarioId])

  if (loading) return <LoadingState />
  if (!scenario) return <EmptyState message="Scenario not found." />

  const steps = scenario.steps || []

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
      className="p-6"
    >
      {/* Back button */}
      <Button
        variant="ghost"
        size="sm"
        icon={<ArrowLeft className="h-3.5 w-3.5" />}
        onClick={onBack}
        className="mb-4"
      >
        Back to Scenarios
      </Button>

      {/* Header */}
      <Card className="mb-6">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-lg font-bold text-[var(--text-primary)]">
                {scenario.name}
              </h2>
            </div>
            {scenario.description && (
              <p className="text-sm text-[var(--text-muted)] leading-relaxed mb-4">
                {scenario.description}
              </p>
            )}
            <div className="flex items-center gap-5 text-xs text-[var(--text-muted)]">
              <span className="flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5" />
                <span className="font-medium text-[var(--text-secondary)]">{scenario.agent_count}</span> agents
              </span>
              <span className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5" />
                <span className="font-medium text-[var(--text-secondary)]">{scenario.step_count}</span> steps
              </span>
            </div>
          </div>
        </div>
      </Card>

      {/* Scenario Metrics (Story 4.1) */}
      {stats && (
        <ScenarioMetrics
          latestRun={stats.latestRun}
          successRate={stats.successRate}
          avgDurationMs={stats.avgDurationMs}
          className="mb-6"
        />
      )}

      {/* Recent Runs + Recent Findings row (Story 4.1) */}
      {stats && (
        <div className="grid grid-cols-1 gap-6 mb-6 lg:grid-cols-2">
          <RecentRuns runs={stats.recentRuns} />
          <RecentFindings
            totalFindings={stats.totalFindings}
            lastFinding={stats.lastFinding}
          />
        </div>
      )}

      {/* Run Timeline for latest run (Story 3.1) */}
      {stats?.latestRun && (
        <Card className="mb-6">
          <RunTimeline runId={stats.latestRun.id} />
        </Card>
      )}

      {/* Scenario History Table (Story 4.2) */}
      <ScenarioHistoryTable
        scenarioId={scenarioId}
        onNavigateToRun={onNavigateToRun}
        className="mb-6"
      />

      {/* Step flow timeline */}
      <Card>
        <h3 className="mb-4 text-sm font-semibold text-[var(--text-primary)]">
          Step Flow
        </h3>
        {steps.length > 0 ? (
          <div className="relative">
            {steps.map((step, index) => {
              const personaColor = PERSONA_COLORS[step.agent] || 'var(--accent)'

              return (
                <motion.div
                  key={step.id || index}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.08 }}
                  className="relative flex gap-4 pb-6 last:pb-0"
                >
                  {/* Vertical line */}
                  {index < steps.length - 1 && (
                    <div
                      className="absolute left-[15px] top-[32px] bottom-0 w-px"
                      style={{ backgroundColor: 'var(--border)' }}
                    />
                  )}

                  {/* Step number circle */}
                  <div
                    className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                    style={{
                      backgroundColor: `${personaColor}20`,
                      color: personaColor,
                      border: `2px solid ${personaColor}40`,
                    }}
                  >
                    {index + 1}
                  </div>

                  {/* Step content */}
                  <div
                    className={cn(
                      'flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3',
                    )}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {step.description}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: personaColor }}
                      />
                      <span className="text-xs text-[var(--text-muted)]">
                        {step.agent}
                      </span>
                    </div>
                  </div>
                </motion.div>
              )
            })}
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center text-xs text-[var(--text-muted)]">
            No steps defined for this scenario
          </div>
        )}
      </Card>
    </motion.div>
  )
}
