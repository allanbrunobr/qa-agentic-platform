/**
 * The runtime's schema and its numbered migrations, per component (A-03). Kept free of database
 * drivers so that both the runtime (db/index.ts, SessionService) and the control plane's
 * upgrade-local can use it. Migration 1 of each component is a baseline and never changes; a later
 * schema change is a new entry at the end of its list.
 */
import { baselineMigration, type Migration, type SqliteLike } from './migrations.js';

// Dashboard tables (db/index.ts).
export const DASHBOARD_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id TEXT NOT NULL,
      scenario_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER,
      total_tests INTEGER NOT NULL DEFAULT 0,
      passed INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      findings_count INTEGER NOT NULL DEFAULT 0,
      critical_count INTEGER NOT NULL DEFAULT 0,
      high_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      run_source TEXT DEFAULT 'unknown',
      artifacts TEXT,
      suite_type TEXT,
      clean_db_before_run INTEGER,
      started_by TEXT
    );

    CREATE TABLE IF NOT EXISTS findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id),
      finding_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      step TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      expected TEXT NOT NULL,
      actual TEXT NOT NULL,
      screenshot_path TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      step_count INTEGER NOT NULL DEFAULT 0,
      agent_count INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      last_status TEXT
    );

    CREATE TABLE IF NOT EXISTS pr_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id),
      pr_number INTEGER NOT NULL,
      gate_status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_scenario_id ON runs(scenario_id);
    CREATE INDEX IF NOT EXISTS idx_findings_run_id ON findings(run_id);
    CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
    CREATE INDEX IF NOT EXISTS idx_findings_agent ON findings(agent);
    CREATE INDEX IF NOT EXISTS idx_pr_links_run_id ON pr_links(run_id);
`;

// Phase 2 session tables (SessionService).
export const SESSION_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS p2_sessions (
        session_id TEXT PRIMARY KEY,
        run_id INTEGER,
        scenario_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS p2_session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES p2_sessions(session_id),
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        agent_role TEXT,
        data TEXT,
        UNIQUE(session_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS p2_session_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES p2_sessions(session_id),
        created_at TEXT NOT NULL,
        last_completed_step INTEGER NOT NULL,
        cursor INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_session_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES p2_sessions(session_id),
        artifact_key TEXT NOT NULL,
        artifact_type TEXT,
        agent_role TEXT,
        description TEXT,
        file_path TEXT,
        content TEXT,
        metadata TEXT,
        payload TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, artifact_key)
      );

      CREATE TABLE IF NOT EXISTS p2_session_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES p2_sessions(session_id),
        severity TEXT,
        title TEXT,
        description TEXT,
        evidence TEXT,
        agent_id TEXT,
        step_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_step_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES p2_sessions(session_id),
        scenario_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        success INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        error_category TEXT,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_adaptation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT REFERENCES p2_sessions(session_id),
        scenario_id TEXT NOT NULL,
        step_id TEXT,
        adaptation_type TEXT NOT NULL,
        previous_value TEXT,
        new_value TEXT,
        reason TEXT NOT NULL,
        confidence REAL NOT NULL,
        outcome TEXT,
        metadata TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_learning_proposals (
        proposal_id TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL UNIQUE,
        scenario_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        agent_id TEXT,
        proposal_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        patch_kind TEXT NOT NULL,
        target TEXT,
        patch_content TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        applied_at TEXT,
        rejected_at TEXT
      );

      CREATE TABLE IF NOT EXISTS p2_scenario_drafts (
        draft_id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        contract_json TEXT NOT NULL,
        gap_type TEXT NOT NULL,
        gap_evidence TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        reviewed_by TEXT,
        reviewed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_healing_actions (
        action_id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        target TEXT NOT NULL,
        reason TEXT NOT NULL,
        automatic INTEGER NOT NULL,
        status TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_governance_decisions (
        decision_id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        action TEXT NOT NULL,
        verdict TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor TEXT,
        requirements TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_l5_materializations (
        materialization_id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        file_path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        rolled_back_at TEXT,
        UNIQUE(subject_type, subject_id, kind, file_path)
      );

      CREATE TABLE IF NOT EXISTS p2_l5_closed_loop_runs (
        loop_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        scenario_id TEXT,
        queued_scenarios TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        verification_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        metadata TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_l5_independent_audit_reviews (
        review_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        actor TEXT,
        reason TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_knowledge_promotion_events (
        event_id TEXT PRIMARY KEY,
        source_run_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        candidate_version TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        promotion_type TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        actor TEXT,
        reason TEXT,
        target TEXT,
        result_json TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_l5_learning_signals (
        signal_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        source_run_id TEXT,
        subject_type TEXT,
        subject_id TEXT,
        scenario_id TEXT,
        step_id TEXT,
        agent_id TEXT,
        version TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS p2_tool_ledger_closures (
        session_id TEXT NOT NULL REFERENCES p2_sessions(session_id),
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        closed_at TEXT NOT NULL,
        original_started_at TEXT NOT NULL,
        PRIMARY KEY(session_id, tool_call_id)
      );

      CREATE TABLE IF NOT EXISTS p2_quality_gate_resets (
        id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        previous_status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_p2_quality_gate_resets_scenario ON p2_quality_gate_resets(scenario_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_sessions_scenario ON p2_sessions(scenario_id);
      CREATE INDEX IF NOT EXISTS idx_p2_events_session_sequence ON p2_session_events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_p2_findings_session_created ON p2_session_findings(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_step_perf_step ON p2_step_performance(scenario_id, step_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_adaptations_step ON p2_adaptation_events(scenario_id, step_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_p2_learning_proposals_status ON p2_learning_proposals(status, scenario_id);
      CREATE INDEX IF NOT EXISTS idx_p2_scenario_drafts_status ON p2_scenario_drafts(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_healing_actions_created ON p2_healing_actions(created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_governance_subject ON p2_governance_decisions(subject_type, subject_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_l5_materializations_subject ON p2_l5_materializations(subject_type, subject_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_l5_closed_loop_status ON p2_l5_closed_loop_runs(status, scenario_id, completed_at);
      CREATE INDEX IF NOT EXISTS idx_p2_l5_independent_audit_reviews_run ON p2_l5_independent_audit_reviews(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_knowledge_promotion_events_run ON p2_knowledge_promotion_events(source_run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_knowledge_promotion_events_subject ON p2_knowledge_promotion_events(subject_type, subject_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_l5_learning_signals_scope ON p2_l5_learning_signals(status, signal_type, scenario_id, step_id, agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_l5_learning_signals_source ON p2_l5_learning_signals(source_type, source_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_l5_learning_signals_subject ON p2_l5_learning_signals(subject_type, subject_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_p2_tool_ledger_closures_session ON p2_tool_ledger_closures(session_id, closed_at);
`;

export type RuntimeSchemaComponent = 'dashboard' | 'phase2-sessions';

/** Migrations of each component; openReference opens an empty in-memory database of the same driver. */
export function runtimeMigrations(
  openReference: () => SqliteLike & { close(): unknown },
): Record<RuntimeSchemaComponent, Migration[]> {
  return {
    dashboard: [baselineMigration(DASHBOARD_SCHEMA_SQL, openReference)],
    'phase2-sessions': [
      baselineMigration(SESSION_SCHEMA_SQL, openReference),
      {
        // The expected and actual behaviour an agent reports with a finding (reportFinding, B-04).
        version: 2,
        name: 'findings.expected_actual',
        up(db) {
          db.exec('ALTER TABLE p2_session_findings ADD COLUMN expected TEXT');
          db.exec('ALTER TABLE p2_session_findings ADD COLUMN actual TEXT');
        },
      },
    ],
  };
}
