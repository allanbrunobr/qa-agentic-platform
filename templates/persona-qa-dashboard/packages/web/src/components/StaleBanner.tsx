import { API_BASE } from '@/lib/api-base'
import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'


interface StalenessResponse {
  has_data: boolean
  is_stale: boolean
  last_activity_at: string | null
  age_ms: number | null
  new_data_available: boolean
}

function formatTimeAgo(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function StaleBanner() {
  const [staleness, setStaleness] = useState<StalenessResponse | null>(null)
  const [dismissed, setDismissed] = useState<'stale' | 'new-data' | null>(null)
  const [syncing, setSyncing] = useState(false)

  const checkStaleness = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/runs/staleness`)
      if (!res.ok) return
      const data: StalenessResponse = await res.json()
      setStaleness(data)
    } catch {
      // Endpoint unavailable — show nothing
      setStaleness(null)
    }
  }, [])

  useEffect(() => {
    checkStaleness()
    const interval = setInterval(checkStaleness, 60000)
    return () => clearInterval(interval)
  }, [checkStaleness])

  const handleSync = async () => {
    setSyncing(true)
    try {
      await fetch(`${API_BASE}/api/sync`, { method: 'POST' })
      setDismissed('new-data')
      await checkStaleness()
    } catch {
      // sync endpoint may not exist — ignore
    } finally {
      setSyncing(false)
    }
  }

  if (!staleness || !staleness.has_data) return null

  return (
    <>
      {/* Stale data warning */}
      {staleness.is_stale && staleness.age_ms != null && dismissed !== 'stale' && (
        <div className="flex items-center gap-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-4 py-2.5">
          <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--warning)]" />
          <p className="flex-1 text-sm text-[var(--warning)]">
            Data may be stale — last activity: {formatTimeAgo(staleness.age_ms)}
          </p>
          <button
            onClick={() => setDismissed('stale')}
            className="shrink-0 text-[var(--warning)] hover:text-[var(--text-primary)] transition-colors"
            aria-label="Dismiss alert"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* New data available */}
      {staleness.new_data_available && dismissed !== 'new-data' && (
        <div className="flex items-center gap-3 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-2.5">
          <RefreshCw className="h-4 w-4 shrink-0 text-[var(--accent)]" />
          <p className="flex-1 text-sm text-[var(--accent)]">
            New data available — click Sync
          </p>
          <Button
            variant="primary"
            size="sm"
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            loading={syncing}
            onClick={handleSync}
          >
            Sync
          </Button>
          <button
            onClick={() => setDismissed('new-data')}
            className="shrink-0 text-[var(--accent)] hover:text-[var(--text-primary)] transition-colors"
            aria-label="Dismiss alert"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </>
  )
}
