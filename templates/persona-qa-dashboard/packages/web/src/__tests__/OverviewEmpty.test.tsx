import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// A-02 (docs/analise-20261109.md): with no agentic sessions yet, the Overview read
// orderedSessions[0]!.startedAt and the page crashed. The installer used to patch this in the
// installed copy only; the fix now lives here, in the source CI tests.
vi.mock('@/lib/api', () => {
  const empty: Record<string, () => Promise<unknown>> = {
    getPhase2Sessions: async () => [],
    getPhase2Scenarios: async () => [],
    getStats: async () => null,
    getPhase2GovernanceDecisions: async () => [],
    getPhase2IndependentAuditReviews: async () => [],
    getPhase2IndependentAuditReviewQueue: async () => [],
    getPhase2L5LearningSignals: async () => [],
  }
  return {
    api: new Proxy(empty, {
      get: (target, name: string) => target[name] ?? (async () => null),
    }),
  }
})

describe('Overview with no sessions', () => {
  it('renders the session trend card instead of crashing', async () => {
    // jsdom has no ResizeObserver; the trend chart's ResponsiveContainer needs one.
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    const { Overview } = await import('@/pages/Overview')
    render(<Overview />)

    expect(await screen.findByText(/no activity yet/)).toBeTruthy()
    expect(screen.getByText('Agentic session trend')).toBeTruthy()
  })
})
