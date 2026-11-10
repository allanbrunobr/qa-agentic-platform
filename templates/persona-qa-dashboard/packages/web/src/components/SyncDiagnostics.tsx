import { API_BASE } from '@/lib/api-base'
import { useState, useEffect, useCallback } from 'react'
import { X, RefreshCw, CheckCircle, AlertCircle, FileText, Database, Clock, Zap } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { formatRelativeTime } from '@/lib/utils'


interface SyncSummary {
  success: boolean
  timestamp: string
  source: string
  context_files_processed: number
  new_runs_imported: number
  existing_runs_updated: number
  findings_total: number
  new_findings: number
  scenarios_count: number
  error?: string
}

interface SyncDiagnosticsProps {
  open: boolean
  onClose: () => void
  onSyncComplete?: () => void
}

interface ToastState {
  visible: boolean
  success: boolean
  message: string
}

function SyncDetailRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2 text-[var(--text-muted)]">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <span className="text-xs font-medium text-[var(--text-primary)]">{String(value)}</span>
    </div>
  )
}

function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  useEffect(() => {
    if (toast.visible) {
      const timer = setTimeout(onDismiss, 5000)
      return () => clearTimeout(timer)
    }
  }, [toast.visible, onDismiss])

  if (!toast.visible) return null

  return (
    <div
      className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg transition-all ${
        toast.success
          ? 'border-green-500/30 bg-green-500/10 text-green-400'
          : 'border-red-500/30 bg-red-500/10 text-red-400'
      }`}
      role="alert"
    >
      {toast.success ? (
        <CheckCircle className="h-4 w-4" />
      ) : (
        <AlertCircle className="h-4 w-4" />
      )}
      <span>{toast.message}</span>
      <button onClick={onDismiss} className="ml-2 opacity-60 hover:opacity-100">
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

export function SyncDiagnostics({ open, onClose, onSyncComplete }: SyncDiagnosticsProps) {
  const [summary, setSummary] = useState<SyncSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [toast, setToast] = useState<ToastState>({ visible: false, success: true, message: '' })

  const fetchSummary = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/sync/summary`)
      if (!res.ok) throw new Error()
      const data = await res.json()
      if (data.summary !== undefined) {
        setSummary(data.summary)
      } else {
        setSummary(data as SyncSummary)
      }
    } catch {
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) fetchSummary()
  }, [open, fetchSummary])

  const handleSyncNow = async () => {
    setSyncing(true)
    try {
      const res = await fetch(`${API_BASE}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'manual' }),
      })
      const data: SyncSummary = await res.json()
      setSummary(data)

      if (data.success) {
        const changes = data.new_runs_imported + data.new_findings
        setToast({
          visible: true,
          success: true,
          message: changes > 0
            ? `Sync complete: ${data.context_files_processed} files processed, ${data.new_runs_imported} new runs, ${data.new_findings} new findings`
            : 'Sync complete: no changes detected',
        })
      } else {
        setToast({
          visible: true,
          success: false,
          message: `Sync error: ${data.error ?? 'unknown error'}`,
        })
      }

      onSyncComplete?.()
    } catch {
      setToast({
        visible: true,
        success: false,
        message: 'Could not reach the API to sync',
      })
    } finally {
      setSyncing(false)
    }
  }

  if (!open) return <Toast toast={toast} onDismiss={() => setToast(t => ({ ...t, visible: false }))} />

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Sync details
            </h2>
            <button
              onClick={onClose}
              className="rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="px-5 py-4">
            {loading ? (
              <div className="flex h-32 items-center justify-center text-xs text-[var(--text-muted)]">
                Loading...
              </div>
            ) : summary ? (
              <div className="divide-y divide-[var(--border)]">
                <SyncDetailRow
                  icon={<Clock className="h-3.5 w-3.5" />}
                  label="Last sync"
                  value={formatRelativeTime(summary.timestamp)}
                />
                <SyncDetailRow
                  icon={<Zap className="h-3.5 w-3.5" />}
                  label="Source"
                  value={summary.source}
                />
                <SyncDetailRow
                  icon={<FileText className="h-3.5 w-3.5" />}
                  label="Context files processed"
                  value={summary.context_files_processed}
                />
                <SyncDetailRow
                  icon={<FileText className="h-3.5 w-3.5" />}
                  label="New runs imported"
                  value={summary.new_runs_imported}
                />
                <SyncDetailRow
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                  label="Runs updated"
                  value={summary.existing_runs_updated}
                />
                <SyncDetailRow
                  icon={<Database className="h-3.5 w-3.5" />}
                  label="Total findings"
                  value={summary.findings_total}
                />
                <SyncDetailRow
                  icon={<Database className="h-3.5 w-3.5" />}
                  label="New findings"
                  value={summary.new_findings}
                />
                <SyncDetailRow
                  icon={<FileText className="h-3.5 w-3.5" />}
                  label="Scenarios"
                  value={summary.scenarios_count}
                />
                {summary.error && (
                  <div className="py-2">
                    <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-2 text-xs text-red-400">
                      {summary.error}
                    </div>
                  </div>
                )}
                <div className="py-2">
                  <div className="flex items-center gap-1.5">
                    {summary.success ? (
                      <>
                        <CheckCircle className="h-3.5 w-3.5 text-green-400" />
                        <span className="text-xs text-green-400">Sync succeeded</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="h-3.5 w-3.5 text-red-400" />
                        <span className="text-xs text-red-400">Sync failed</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-32 items-center justify-center text-xs text-[var(--text-muted)]">
                No sync has run yet
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end border-t border-[var(--border)] px-5 py-3">
            <Button
              variant="primary"
              size="sm"
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              loading={syncing}
              disabled={syncing}
              onClick={handleSyncNow}
            >
              {syncing ? 'Syncing...' : 'Sync now'}
            </Button>
          </div>
        </div>
      </div>

      <Toast toast={toast} onDismiss={() => setToast(t => ({ ...t, visible: false }))} />
    </>
  )
}
