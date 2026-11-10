/**
 * The first message of a scenario step is a JSON envelope (scenarioStep, producedArtifacts, ...) on
 * its first line. When earlier steps produced artifacts, their values follow it in an untrusted-data
 * block (S-04): they are tool output too, copied into the session. Readers of the envelope parse the
 * first line; a message that is JSON as a whole is read as before.
 */
export function parseStepEnvelope(content: string): Record<string, unknown> | undefined {
  for (const candidate of [content, content.split('\n', 1)[0] ?? '']) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // not JSON: try the next form
    }
  }
  return undefined
}
