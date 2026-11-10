import { z } from 'zod'

export const Phase2ExecutionPreviewTargetSchema = z.object({
  role: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  sha: z.string().min(1).optional(),
  url: z.string().url().optional(),
})

export const Phase2ExecutionContextSchema = z.object({
  source: z.enum(['pr_preview', 'branch_local', 'staging', 'production', 'custom']).optional(),
  branchName: z.string().min(1).optional(),
  prNumber: z.number().int().positive().optional(),
  targetBaseUrl: z.string().url().optional(),
  targetRepoPath: z.string().min(1).optional(),
  previewTargets: z.array(Phase2ExecutionPreviewTargetSchema).max(12).optional(),
  notes: z.array(z.string().min(1)).max(20).optional(),
})

export type Phase2ExecutionPreviewTarget = z.infer<typeof Phase2ExecutionPreviewTargetSchema>
export type Phase2ExecutionContext = z.infer<typeof Phase2ExecutionContextSchema>

export function parseExecutionContext(input: unknown): Phase2ExecutionContext | undefined {
  const parsed = Phase2ExecutionContextSchema.safeParse(input)
  if (!parsed.success) return undefined
  return hasExecutionContextValue(parsed.data) ? parsed.data : undefined
}

export function resolveExecutionBaseUrl(context: Phase2ExecutionContext | undefined): string | undefined {
  if (!context) return undefined
  if (context.targetBaseUrl) return context.targetBaseUrl

  const frontendTarget = context.previewTargets?.find((target) => {
    const role = target.role?.toLowerCase()
    return role === 'frontend' || role === 'web' || role === 'webapp' || role === 'app'
  })
  if (frontendTarget?.url) return frontendTarget.url
  return context.previewTargets?.find((target) => typeof target.url === 'string')?.url
}

const API_PREVIEW_ROLES = new Set(['backend', 'api', 'server', 'service'])

/**
 * Base URL for HTTP probes in API (non-browser) runs: the explicit targetBaseUrl, or a preview target
 * whose role is a backend. Unlike resolveExecutionBaseUrl, it never falls back to a frontend preview:
 * probing the frontend would record API results for a service that was never called.
 */
export function resolveExecutionApiBaseUrl(context: Phase2ExecutionContext | undefined): string | undefined {
  if (!context) return undefined
  if (context.targetBaseUrl) return context.targetBaseUrl
  return context.previewTargets?.find((target) => {
    const role = target.role?.toLowerCase()
    return Boolean(role && API_PREVIEW_ROLES.has(role) && target.url)
  })?.url
}

export function summarizeExecutionContext(context: Phase2ExecutionContext | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined
  return {
    source: context.source,
    branchName: context.branchName,
    prNumber: context.prNumber,
    targetBaseUrl: context.targetBaseUrl,
    targetRepoPath: context.targetRepoPath,
    previewTargets: context.previewTargets?.map((target) => ({
      role: target.role,
      repo: target.repo,
      ref: target.ref,
      sha: target.sha,
      url: target.url,
    })),
    notes: context.notes,
  }
}

function hasExecutionContextValue(context: Phase2ExecutionContext): boolean {
  return Boolean(
    context.source
    || context.branchName
    || context.prNumber
    || context.targetBaseUrl
    || context.targetRepoPath
    || (context.previewTargets && context.previewTargets.length > 0)
    || (context.notes && context.notes.length > 0),
  )
}
