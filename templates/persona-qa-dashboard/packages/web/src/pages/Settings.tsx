import { useEffect, useMemo, useState } from 'react'
import { Activity, Bot, CheckCircle2, Database, KeyRound, Link2, Settings as SettingsIcon, ShieldCheck, XCircle } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { api, type DashboardStats, type DashboardStatus, type Phase2ScenarioSummary, type Phase2SessionSummary, type RuntimeSettingsResponse } from '@/lib/api'
import { cn, formatRelativeTime } from '@/lib/utils'

type PersonaRecord = {
  id?: string
  name?: string
  role?: string
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold uppercase',
        ok
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-red-500/30 bg-red-500/10 text-red-300',
      )}
    >
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {label}
    </span>
  )
}

function InfoRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] py-2 last:border-0">
      <span className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</span>
      <span className="break-all text-right text-sm text-[var(--text-primary)]">{value ?? 'not configured'}</span>
    </div>
  )
}

function configLabel(value: 'configured' | 'default' | 'missing' | undefined) {
  if (value === 'configured') return 'configured from .env.local'
  if (value === 'default') return 'using built-in default'
  return 'missing'
}

export function Settings() {
  const [status, setStatus] = useState<DashboardStatus | null>(null)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettingsResponse | null>(null)
  const [sessions, setSessions] = useState<Phase2SessionSummary[]>([])
  const [scenarios, setScenarios] = useState<Phase2ScenarioSummary[]>([])
  const [personas, setPersonas] = useState<PersonaRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<'anthropic' | 'openai'>('anthropic')
  const [savingProvider, setSavingProvider] = useState(false)
  const [providerNotice, setProviderNotice] = useState<string | null>(null)
  const [providerNoticeIsError, setProviderNoticeIsError] = useState(false)

  useEffect(() => {
    let mounted = true

    const load = async () => {
      setError(null)
      try {
        const [nextStatus, nextStats, nextRuntimeSettings, nextSessions, nextScenarios, nextPersonas] = await Promise.all([
          api.getStatus(),
          api.getStats(),
          api.getRuntimeSettings(),
          api.getPhase2Sessions(),
          api.getPhase2Scenarios(),
          api.getPersonas() as Promise<PersonaRecord[]>,
        ])
        if (!mounted) return
        setStatus(nextStatus)
        setStats(nextStats)
        setRuntimeSettings(nextRuntimeSettings)
        setSelectedProvider(nextRuntimeSettings.provider)
        setSessions(nextSessions)
        setScenarios(nextScenarios)
        setPersonas(Array.isArray(nextPersonas) ? nextPersonas : [])
      } catch (loadError) {
        if (!mounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load settings')
      } finally {
        if (mounted) setLoading(false)
      }
    }

    void load()
    const interval = window.setInterval(load, 10000)
    return () => {
      mounted = false
      window.clearInterval(interval)
    }
  }, [])

  const environment = useMemo(() => ({
    dashboardUrl: window.location.origin,
    apiUrl: `${window.location.origin}/api (proxied by the dashboard server)`,
    mode: import.meta.env.MODE,
  }), [])

  const runtimeConfig = status?.runtime_config
  const targetUrl = runtimeConfig?.target_app_url ?? 'http://localhost:3012'

  const activeSession = sessions.find((session) => session.status === 'running' || session.status === 'pending') ?? null
  const lastActivity = status?.latest_activity_at ?? stats?.agentic.last_activity_at ?? null
  const providerOptions = runtimeSettings?.supportedProviders ?? []
  const providerChanged = runtimeSettings ? selectedProvider !== runtimeSettings.provider : false

  const handleSaveProvider = async () => {
    setSavingProvider(true)
    setProviderNotice(null)
    try {
      const nextSettings = await api.updateRuntimeSettings({ provider: selectedProvider })
      setRuntimeSettings(nextSettings)
      setStatus((current) => {
        if (!current?.runtime_config) return current
        return {
          ...current,
          runtime_config: {
            ...current.runtime_config,
            provider: nextSettings.provider,
          },
        }
      })
      setProviderNoticeIsError(false)
      setProviderNotice('Provider saved. The change applies to the next run.')
    } catch (saveError) {
      setProviderNoticeIsError(true)
      setProviderNotice(saveError instanceof Error ? saveError.message : 'Failed to save provider')
    } finally {
      setSavingProvider(false)
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">Settings</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Diagnostics for the dashboard, adapter, and local environment.
        </p>
      </div>

      {loading && (
        <Card>
          <p className="text-sm text-[var(--text-muted)]">Loading settings...</p>
        </Card>
      )}

      {error && (
        <Card className="border-red-500/30 bg-red-500/10">
          <p className="text-sm text-red-300">{error}</p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Environment</h2>
          </div>
          <div>
            <InfoRow label="Dashboard URL" value={environment.dashboardUrl} />
            <InfoRow label="API URL" value={environment.apiUrl} />
            <InfoRow label="Target app URL" value={targetUrl} />
            <InfoRow label="Playwright base URL" value={configLabel(runtimeConfig?.playwright_base_url)} />
            <InfoRow label="Mode" value={environment.mode} />
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill ok={status?.api === 'up'} label={`api ${status?.api ?? 'unknown'}`} />
            <StatusPill ok={status?.db === 'ok'} label={`db ${status?.db ?? 'unknown'}`} />
          </div>
        </Card>

        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <SettingsIcon className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Model provider</h2>
          </div>
          <div>
            <InfoRow label="Current provider" value={runtimeConfig?.provider ?? runtimeSettings?.provider ?? 'anthropic'} />
            <InfoRow label="Applies to" value="next run" />
          </div>
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Provider
              </span>
              <select
                value={selectedProvider}
                onChange={(event) => {
                  setSelectedProvider(event.target.value as 'anthropic' | 'openai')
                  setProviderNotice(null)
                }}
                className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)]/50 focus:outline-none"
              >
                {providerOptions.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-xs text-[var(--text-muted)]">
              {providerOptions.find((provider) => provider.id === selectedProvider)?.description ?? 'Select the provider used for upcoming agentic runs.'}
            </div>
            <Button
              variant="primary"
              onClick={handleSaveProvider}
              disabled={!providerChanged}
              loading={savingProvider}
              className="w-full justify-center"
            >
              Save provider
            </Button>
            {providerNotice && (
              <div className={cn(
                'rounded-md border px-3 py-2 text-xs',
                providerNoticeIsError
                  ? 'border-red-500/30 bg-red-500/10 text-red-300'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
              )}>
                {providerNotice}
              </div>
            )}
          </div>
        </Card>

        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Credentials & Secrets</h2>
          </div>
          <div>
            <InfoRow label="Selected provider" value={runtimeConfig?.provider ?? runtimeSettings?.provider ?? 'anthropic'} />
            <InfoRow label="Anthropic key" value={configLabel(runtimeConfig?.anthropic_key)} />
            <InfoRow label="OpenAI key" value={configLabel(runtimeConfig?.openai_key)} />
            <InfoRow label="Primary test user" value={configLabel(runtimeConfig?.test_user)} />
            <InfoRow label="Primary test password" value={configLabel(runtimeConfig?.test_password)} />
            <InfoRow label="Secondary test user" value={configLabel(runtimeConfig?.secondary_user)} />
            <InfoRow label="Secret values" value="masked; never displayed" />
          </div>
        </Card>

        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Adapter</h2>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3">
              <p className="text-xl font-semibold text-[var(--text-primary)]">{personas.length}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">personas</p>
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3">
              <p className="text-xl font-semibold text-[var(--text-primary)]">{scenarios.length}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">scenarios</p>
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3">
              <p className="text-xl font-semibold text-[var(--text-primary)]">{stats?.total_scenarios ?? scenarios.length}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">registered</p>
            </div>
          </div>
          <div>
            <InfoRow label="Adapter path" value=".agentic-qa/adapter" />
            <InfoRow label="Personas source" value="adapter/personas" />
            <InfoRow label="Scenarios source" value="adapter/scenarios" />
          </div>
        </Card>

        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Local data</h2>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3">
              <p className="text-xl font-semibold text-[var(--text-primary)]">{sessions.length}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">sessions</p>
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3">
              <p className="text-xl font-semibold text-[var(--text-primary)]">{stats?.agentic.total_findings ?? 0}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">findings</p>
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3">
              <p className="text-xl font-semibold text-[var(--text-primary)]">{stats?.agentic.running_sessions ?? 0}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">running</p>
            </div>
          </div>
          <div>
            <InfoRow label="DB path" value=".agentic-qa/persona-qa.db" />
            <InfoRow label="Artifacts path" value=".agentic-qa/packages/api/artifacts" />
            <InfoRow label="Last activity" value={lastActivity ? formatRelativeTime(lastActivity) : 'none'} />
          </div>
        </Card>

        <Card className="space-y-4 lg:col-span-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Execution defaults</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <InfoRow label="Parallel runs" value="disabled" />
            <InfoRow label="Default scenario" value={scenarios[0]?.name ?? 'not loaded'} />
            <InfoRow label="Active session" value={activeSession ? `${activeSession.scenarioId} (${activeSession.status})` : 'none'} />
            <InfoRow label="Review mode" value="manual approval for restricted/drifted flows" />
          </div>
        </Card>

        <Card className="space-y-4 lg:col-span-2">
          <div className="flex items-center gap-2">
            <SettingsIcon className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Handoff notes</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3">
              <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                <Activity className="h-4 w-4 text-[var(--accent)]" />
                Local dashboard
              </div>
              <p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
                Use this page to confirm that the API, local database, personas, and scenarios loaded.
              </p>
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3">
              <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                <KeyRound className="h-4 w-4 text-[var(--accent)]" />
                Sensitive values
              </div>
              <p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
                Keys and passwords must stay in the local environment. The provider choice only affects the next run.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
