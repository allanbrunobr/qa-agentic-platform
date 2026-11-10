import type { Session, SessionArtifact, SessionEvent, SessionFinding, SessionRecord } from '../contracts/session-types.ts'

// A-01 (docs/analise-20261109.md): ToolRegistry, AgentRegistry, ScenarioRegistry, RuntimeContext and
// Orchestrator were declared here with no implementation and no user anywhere in the platform or the
// runtime template. They were removed; SessionStore is the contract the core actually uses.
export interface SessionStore {
  createSession(session: SessionRecord): Promise<void>
  getSession(sessionId: string): Promise<Session | null>
  listSessions(limit?: number): Promise<Session[]>
  appendEvent(event: SessionEvent): Promise<void>
  appendArtifact(artifact: SessionArtifact): Promise<void>
  appendFinding(finding: SessionFinding): Promise<void>
  updateSession(sessionId: string, patch: Partial<SessionRecord>): Promise<void>
}
