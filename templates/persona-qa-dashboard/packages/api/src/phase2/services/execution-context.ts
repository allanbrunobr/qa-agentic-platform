import { z } from 'zod'

// S-07: the browser and the API probes navigate to these URLs, so only http(s) is accepted.
// z.string().url() alone accepts file://, javascript: and chrome:// as well.
const HttpUrlSchema = z.string().url().refine((value) => {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}, { message: 'must be an http or https URL' })

export const Phase2ExecutionPreviewTargetSchema = z.object({
  role: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  sha: z.string().min(1).optional(),
  url: HttpUrlSchema.optional(),
})

export const Phase2ExecutionContextSchema = z.object({
  source: z.enum(['pr_preview', 'branch_local', 'staging', 'production', 'custom']).optional(),
  branchName: z.string().min(1).optional(),
  prNumber: z.number().int().positive().optional(),
  targetBaseUrl: HttpUrlSchema.optional(),
  targetRepoPath: z.string().min(1).optional(),
  previewTargets: z.array(Phase2ExecutionPreviewTargetSchema).max(12).optional(),
  notes: z.array(z.string().min(1)).max(20).optional(),
})

export type Phase2ExecutionPreviewTarget = z.infer<typeof Phase2ExecutionPreviewTargetSchema>
export type Phase2ExecutionContext = z.infer<typeof Phase2ExecutionContextSchema>

/**
 * Validates a client-supplied execution_context. Unlike parseExecutionContext, which drops an invalid
 * context, this reports the error, so a run never silently falls back to the environment target.
 */
export function validateExecutionContext(
  input: unknown,
): { ok: true } | { ok: false; error: { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> } } {
  if (input === undefined || input === null) return { ok: true }
  const parsed = Phase2ExecutionContextSchema.safeParse(input)
  return parsed.success ? { ok: true } : { ok: false, error: z.flattenError(parsed.error) }
}

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
