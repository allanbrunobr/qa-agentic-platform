import { REPORT_FINDING_TOOL } from '../tools/finding-tools.js'

/**
 * Tools that help a step report what it saw without performing it (B-04). The runtime offers them next
 * to the step's capability and does not count them as performing the step; the tool-policy sensor
 * accepts them alongside the scenario's allowed tools. One list for both.
 */
export const STEP_SUPPORT_TOOLS: ReadonlySet<string> = new Set(['captureScreenshot', 'collectDomSnippet', REPORT_FINDING_TOOL])
