import { z } from 'zod'
import type { ToolRegistry } from '../services/tool-registry.js'
import type { ToolHandler, ToolMetadata } from '../types/tool-types.js'

/**
 * reportFinding: how an agent records a defect it observed in the application under test (B-04 in
 * docs/analise-20261109.md). Before it existed, nothing could ever add a finding, so every run showed
 * zero agent findings whatever the agent saw.
 *
 * The handler only validates the input. The agent runtime applies the agent's evidence policy (a
 * screenshot captured in this step, when required), persists the finding, and adds it to the step
 * output, because only the runtime knows the step's profile and evidence.
 */

export const REPORT_FINDING_TOOL = 'reportFinding'

export const ReportedFindingSchema = z.object({
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(1).max(4000),
  evidenceArtifactIds: z.array(z.string().min(1)).max(10).default([]),
  expected: z.string().trim().max(1000).optional(),
  actual: z.string().trim().max(1000).optional(),
})

export type ReportedFinding = z.infer<typeof ReportedFindingSchema>

const reportFindingHandler: ToolHandler = async (input) => {
  const parsed = ReportedFindingSchema.safeParse(input ?? {})
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'invalid_finding',
        message: `reportFinding input is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')}`,
        retryable: true,
      },
    }
  }
  return { ok: true, output: { reportedFinding: parsed.data } }
}

export const reportFindingMetadata: ToolMetadata = {
  name: REPORT_FINDING_TOOL,
  description: 'Record a defect you observed in the application under test. Describe what was expected and what happened. '
    + 'To attach evidence, call captureScreenshot or collectDomSnippet in an earlier response than this one and pass the artifactId it returned '
    + 'in evidenceArtifactIds: an id exists only after that tool has run. The step ends as soon as its action produces the step artifacts, '
    + 'so report a defect before that action, or in the same response as it.',
  inputSchema: {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      title: { type: 'string', description: 'Short summary of the defect' },
      description: { type: 'string', description: 'What you did and what went wrong' },
      evidenceArtifactIds: { type: 'array', items: { type: 'string' }, description: 'artifactId values returned by captureScreenshot or collectDomSnippet in this step' },
      expected: { type: 'string' },
      actual: { type: 'string' },
    },
    required: ['severity', 'title', 'description'],
  },
  requiresBrowser: false,
  riskLevel: 'read',
  tags: ['finding'],
}

export function registerFindingTools(registry: ToolRegistry): void {
  registry.register(REPORT_FINDING_TOOL, reportFindingHandler, reportFindingMetadata)
}
