import { API_BASE } from '@/lib/api-base'
import { useState } from 'react'
import { Download, FileText } from 'lucide-react'
import { Button } from '@/components/ui/Button'


type ExportFormat = 'json' | 'csv'

interface DataExportProps {
  filterParams?: Record<string, string>
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

export function DataExport({ filterParams }: DataExportProps) {
  const [exporting, setExporting] = useState(false)
  const [exportingSummary, setExportingSummary] = useState(false)

  const handleExport = async (format: ExportFormat) => {
    setExporting(true)
    try {
      const params = new URLSearchParams({ format, ...filterParams })
      const url = `${API_BASE}/api/runs/export?${params}`
      const response = await fetch(url)
      const blob = await response.blob()
      const blobUrl = URL.createObjectURL(blob)
      const ext = format === 'csv' ? 'csv' : 'json'
      triggerDownload(blobUrl, `runs-export.${ext}`)
      URL.revokeObjectURL(blobUrl)
    } catch {
      // silent fail — could add toast notification later
    } finally {
      setExporting(false)
    }
  }

  const handleExportSummary = async () => {
    setExportingSummary(true)
    try {
      const params = new URLSearchParams({ ...filterParams })
      const qs = params.toString()
      const url = qs
        ? `${API_BASE}/api/runs/export-summary?${qs}`
        : `${API_BASE}/api/runs/export-summary`
      const response = await fetch(url)
      const blob = await response.blob()
      const blobUrl = URL.createObjectURL(blob)
      triggerDownload(blobUrl, 'summary-report.md')
      URL.revokeObjectURL(blobUrl)
    } catch {
      // silent fail
    } finally {
      setExportingSummary(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        icon={<Download className="h-3.5 w-3.5" />}
        loading={exporting}
        onClick={() => handleExport('json')}
      >
        JSON
      </Button>
      <Button
        variant="secondary"
        size="sm"
        icon={<Download className="h-3.5 w-3.5" />}
        loading={exporting}
        onClick={() => handleExport('csv')}
      >
        CSV
      </Button>
      <Button
        variant="ghost"
        size="sm"
        icon={<FileText className="h-3.5 w-3.5" />}
        loading={exportingSummary}
        onClick={handleExportSummary}
      >
        Report
      </Button>
    </div>
  )
}
