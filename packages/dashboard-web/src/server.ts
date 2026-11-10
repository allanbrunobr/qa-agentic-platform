import { createServer } from 'node:http'
import path from 'node:path'
import { CONTROL_PLANE_HOST, ensureControlPlaneToken, isLoopbackHost } from '../../dashboard-api/src/control-plane-guard.ts'

const WEB_PORT = Number(process.env.AGENTIC_PLATFORM_WEB_PORT ?? 4177)
const API_PORT = Number(process.env.AGENTIC_PLATFORM_API_PORT ?? 3101)
const DEFAULT_REPO = process.env.AGENTIC_PLATFORM_DEFAULT_REPO ?? process.cwd()

function escapeHtmlText(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function buildDashboardHtml(input: {
  apiPort: number
  webPort: number
  defaultRepo: string
  token: string
}) {
  const API_PORT = input.apiPort
  const DEFAULT_REPO = escapeHtmlText(input.defaultRepo)
  const CONTROL_PLANE_TOKEN_JS = JSON.stringify(input.token)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agentic Platform</title>
    <style>
      :root {
        --bg-primary: #0f1117;
        --bg-secondary: #141821;
        --bg-card: #171a22;
        --bg-hover: #1f2631;
        --border: #2b3242;
        --text-primary: #f5f7fa;
        --text-secondary: #d0d5dd;
        --text-muted: #98a2b3;
        --accent: #2dd4bf;
      }
      body { margin: 0; font-family: Arial, sans-serif; background: var(--bg-primary); color: var(--text-primary); }
      .app-shell { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
      .sidebar {
        position: relative;
        display: flex;
        flex-direction: column;
        border-right: 1px solid var(--border);
        background: var(--bg-secondary);
      }
      .sidebar-header {
        display: flex;
        align-items: center;
        height: 56px;
        padding: 0 14px;
        border-bottom: 1px solid var(--border);
        gap: 10px;
      }
      .sidebar-logo {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 6px;
        background: rgba(45, 212, 191, 0.12);
        color: var(--accent);
        font-size: 14px;
        font-weight: 700;
      }
      .sidebar-title { font-size: 14px; font-weight: 700; }
      .sidebar-title span { color: var(--accent); }
      .sidebar-nav { flex: 1; padding: 12px 8px; }
      .sidebar-nav button {
        position: relative;
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        margin-bottom: 4px;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--text-secondary);
        text-align: left;
        font-weight: 600;
        white-space: nowrap;
      }
      .sidebar-nav button.active {
        background: rgba(45, 212, 191, 0.10);
        color: var(--accent);
        border-color: rgba(45, 212, 191, 0.18);
      }
      .sidebar-nav button.active::before {
        content: '';
        position: absolute;
        left: -8px;
        top: 8px;
        bottom: 8px;
        width: 3px;
        border-radius: 0 999px 999px 0;
        background: var(--accent);
      }
      .sidebar-nav button:hover { background: var(--bg-hover); color: var(--text-primary); }
      .nav-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 4px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.02);
        color: var(--text-muted);
        font-size: 10px;
        font-weight: 700;
        flex: 0 0 auto;
      }
      .sidebar-nav button.active .nav-icon {
        border-color: rgba(45, 212, 191, 0.25);
        color: var(--accent);
      }
      .nav-label {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sidebar-footer {
        border-top: 1px solid var(--border);
        padding: 12px 10px;
      }
      .sidebar-footer button {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--text-secondary);
        font-weight: 600;
        text-align: left;
      }
      .sidebar-footer button:hover { background: var(--bg-hover); color: var(--text-primary); }
      .sidebar-version { margin-top: 10px; padding: 0 12px; color: var(--text-muted); font-size: 11px; }
      .main {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        height: 56px;
        padding: 0 20px;
        border-bottom: 1px solid var(--border);
        background: var(--bg-secondary);
      }
      .header-title { font-size: 18px; font-weight: 700; }
      .health-strip {
        display: flex;
        align-items: center;
        gap: 12px;
        border: 1px solid var(--border);
        background: var(--bg-card);
        border-radius: 10px;
        padding: 8px 12px;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .health-strip span { display: inline-flex; align-items: center; gap: 6px; }
      .health-separator { width: 1px; height: 14px; background: var(--border); }
      .health-dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; }
      .health-dot.ok { background: #4ade80; }
      .health-dot.warn { background: #fbbf24; }
      .health-dot.bad { background: #f87171; }
      .shell { padding: 20px; }
      .layout { display: grid; grid-template-columns: 1fr; gap: 16px; align-items: start; }
      .hidden { display: none !important; }
      .card { background: #171a22; border: 1px solid #2b3242; border-radius: 8px; padding: 16px; min-width: 0; }
      h1, h2, h3, p { margin-top: 0; }
      label { display: block; font-size: 12px; color: #98a2b3; margin-bottom: 6px; }
      input, select, button { width: 100%; box-sizing: border-box; border-radius: 6px; border: 1px solid #394150; background: #10131a; color: #f5f7fa; padding: 10px 12px; }
      button { background: #0ea5a4; color: #041313; font-weight: 600; cursor: pointer; }
      button.secondary { background: #1f2937; color: #f5f7fa; }
      button:disabled { opacity: 0.45; cursor: not-allowed; }
      .stack > * + * { margin-top: 12px; }
      .actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
      .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 16px; }
      .metric { background: #10131a; border: 1px solid #2b3242; border-radius: 8px; padding: 12px; }
      .metric-label { color: #98a2b3; font-size: 12px; margin-bottom: 8px; text-transform: uppercase; }
      .metric-value { font-size: 24px; font-weight: 700; }
      .review-gates { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-bottom: 16px; }
      .review-gate { border: 1px solid #2b3242; border-radius: 8px; padding: 12px; background: #10131a; }
      .review-gate strong { display: block; margin-bottom: 6px; }
      .review-gate.success { border-color: rgba(52, 211, 153, 0.45); }
      .review-gate.warning { border-color: rgba(251, 191, 36, 0.45); }
      .review-gate.blocker { border-color: rgba(248, 113, 113, 0.45); }
      .review-domain { display: grid; grid-template-columns: 1.3fr 1fr; gap: 12px; margin-bottom: 16px; }
      .candidate-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
      .candidate-card { border: 1px solid #2b3242; border-radius: 8px; padding: 12px; background: #10131a; }
      .candidate-card-title { font-weight: 700; margin-bottom: 8px; }
      .candidate-meta { color: #98a2b3; font-size: 12px; line-height: 1.5; }
      .candidate-status { display: inline-block; margin-bottom: 8px; padding: 2px 8px; border-radius: 999px; background: rgba(148, 163, 184, 0.16); color: #cbd5e1; font-size: 11px; font-weight: 700; text-transform: uppercase; }
      .candidate-status.runnable_candidate { background: rgba(52, 211, 153, 0.16); color: #34d399; }
      .candidate-status.needs_human_mapping { background: rgba(251, 191, 36, 0.16); color: #fbbf24; }
      .candidate-status.restricted { background: rgba(248, 113, 113, 0.16); color: #f87171; }
      .status { margin-bottom: 12px; color: #7dd3fc; }
      pre { white-space: pre-wrap; word-break: break-word; background: #0b0e13; border: 1px solid #2b3242; border-radius: 8px; padding: 12px; overflow: auto; }
      .lists { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      ul { padding-left: 20px; }
      iframe { width: 100%; height: 520px; border: 1px solid #2b3242; border-radius: 8px; background: white; }
      .muted { color: #98a2b3; }
      .execution-list { display: grid; gap: 8px; min-width: 0; }
      .execution-item { border: 1px solid #2b3242; border-radius: 8px; padding: 14px; background: #10131a; cursor: pointer; min-width: 0; max-width: 100%; overflow: hidden; }
      .execution-item.active { border-color: #0ea5a4; box-shadow: inset 0 0 0 1px #0ea5a4; }
      .execution-item strong { display: block; margin-bottom: 6px; }
      .execution-item:hover { border-color: #3b4558; }
      .project-badge { display: inline-block; margin-top: 6px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; background: rgba(125, 211, 252, 0.12); color: #7dd3fc; }
      .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
      .pill.complete { background: rgba(16, 185, 129, 0.16); color: #34d399; }
      .pill.running { background: rgba(14, 165, 164, 0.16); color: #5eead4; }
      .pill.pending, .pill.initialized { background: rgba(148, 163, 184, 0.16); color: #cbd5e1; }
      .pill.failed { background: rgba(239, 68, 68, 0.16); color: #f87171; }
      .pill.multi-agent { background: rgba(139, 92, 246, 0.16); color: #c4b5fd; }
      .pill.single-agent { background: rgba(59, 130, 246, 0.16); color: #93c5fd; }
      .pill.contract_compliant { background: rgba(16, 185, 129, 0.16); color: #34d399; }
      .pill.contract_drift { background: rgba(245, 158, 11, 0.16); color: #fbbf24; }
      .pill.contract_violated { background: rgba(239, 68, 68, 0.16); color: #f87171; }
      .pill.contract_evaluating { background: rgba(14, 165, 164, 0.16); color: #5eead4; }
      .pill.no_contract { background: rgba(113, 113, 122, 0.16); color: #d4d4d8; }
      .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-top: 16px; min-width: 0; }
      .detail-grid .card { padding: 12px; }
      .detail-summary { display: grid; gap: 12px; }
      .detail-meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .detail-meta {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 12px;
        background: #10131a;
      }
      .detail-meta-label {
        color: var(--text-muted);
        font-size: 11px;
        text-transform: uppercase;
        margin-bottom: 6px;
      }
      .detail-meta-value {
        color: var(--text-primary);
        font-size: 14px;
        font-weight: 600;
        line-height: 1.4;
        word-break: break-word;
      }
      .detail-raw-toggle {
        color: var(--accent);
        font-size: 12px;
        cursor: pointer;
        user-select: none;
      }
      .detail-raw.hidden { display: none; }
      .event-list { display: grid; gap: 8px; }
      .event-item { border: 1px solid #2b3242; border-radius: 8px; padding: 10px; background: #10131a; }
      .event-item strong { display: block; margin-bottom: 4px; }
      .event-item.failed { border-color: #7f1d1d; background: #1b1113; }
      .event-item.completed { border-color: #064e3b; background: #0f1917; }
      .event-meta { color: #98a2b3; font-size: 12px; margin-top: 6px; }
      .hint { color: #98a2b3; font-size: 12px; line-height: 1.4; }
      textarea { width: 100%; min-height: 420px; box-sizing: border-box; border-radius: 6px; border: 1px solid #394150; background: #10131a; color: #f5f7fa; padding: 10px 12px; font-family: monospace; font-size: 12px; }
      .tabbar { display: none; }
      .tabbar button { width: auto; min-width: 140px; }
      .tabbar button.active { background: #0ea5a4; color: #041313; }
      .panel.hidden { display: none; }
      .setup-grid { display: grid; grid-template-columns: 380px 1fr; gap: 16px; align-items: start; }
      .runs-grid { display: grid; grid-template-columns: minmax(320px, 360px) minmax(0, 1fr); gap: 16px; align-items: start; }
      .runs-sidebar { display: grid; gap: 12px; min-width: 0; }
      .run-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
      .run-header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 16px; }
      .run-title { font-size: 28px; font-weight: 700; margin: 0; }
      .run-subtitle { color: #98a2b3; font-size: 13px; margin-top: 6px; }
      .run-stack { display: grid; gap: 16px; min-width: 0; }
      .empty-run-state {
        border: 1px dashed var(--border);
        border-radius: 8px;
        padding: 20px;
        background: rgba(255, 255, 255, 0.02);
        color: var(--text-muted);
      }
      .run-split { display: grid; grid-template-columns: 1fr; gap: 16px; align-items: start; }
      .run-column { display: grid; gap: 16px; min-width: 0; }
      .section-title { margin-bottom: 12px; font-size: 18px; }
      .artifact-list, .finding-list, .contract-list { display: grid; gap: 8px; }
      .artifact-item, .finding-item, .contract-item {
        border: 1px solid #2b3242;
        border-radius: 8px;
        padding: 10px;
        background: #10131a;
      }
      .artifact-key, .finding-title, .contract-key { font-weight: 700; margin-bottom: 4px; }
      .artifact-meta, .finding-meta, .contract-meta { color: #98a2b3; font-size: 12px; margin-top: 6px; }
      .contract-verdict {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }
      .contract-verdict.contract_compliant { background: rgba(16, 185, 129, 0.16); color: #34d399; }
      .contract-verdict.contract_drift { background: rgba(245, 158, 11, 0.16); color: #fbbf24; }
      .contract-verdict.contract_violated { background: rgba(239, 68, 68, 0.16); color: #f87171; }
      .contract-verdict.contract_evaluating { background: rgba(14, 165, 164, 0.16); color: #5eead4; }
      .mini-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
      .mini-metric { background: #10131a; border: 1px solid #2b3242; border-radius: 8px; padding: 10px; }
      .mini-metric .metric-label { margin-bottom: 4px; }
      .run-card-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: flex-start; gap: 10px; margin-bottom: 10px; min-width: 0; }
      .run-card-title { font-size: 15px; font-weight: 700; line-height: 1.3; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .run-card-badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: flex-end; min-width: 0; }
      .run-card-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
      .run-card-stat { color: var(--text-muted); font-size: 12px; min-width: 0; }
      .run-card-stat strong { display: block; margin-bottom: 2px; color: var(--text-secondary); font-size: 11px; font-weight: 600; text-transform: uppercase; }
      .run-card-footer { margin-top: 10px; color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .run-card-error { margin-top: 10px; color: #fca5a5; font-size: 13px; }
      .run-overview-card { padding: 18px; }
      .run-overview-card .metric-value { font-size: 18px; }
      .run-overview-card .metric-label { margin-bottom: 6px; }
      .code-inline {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        background: #0b0e13;
        border: 1px solid #2b3242;
        color: #d0d5dd;
        font-family: monospace;
        font-size: 12px;
      }
      .project-filter { margin-bottom: 8px; }
      .session-summary-badges, .session-filter-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .filter-chip {
        width: auto;
        border-radius: 8px;
        padding: 6px 10px;
        border: 1px solid var(--border);
        background: #10131a;
        color: var(--text-secondary);
        font-size: 12px;
        font-weight: 600;
      }
      .filter-chip.active {
        border-color: rgba(45, 212, 191, 0.3);
        background: rgba(45, 212, 191, 0.10);
        color: var(--accent);
      }
      .summary-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 8px;
        padding: 6px 10px;
        border: 1px solid var(--border);
        background: #10131a;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }
      .summary-chip.violated { border-color: rgba(239,68,68,.3); color: #f87171; background: rgba(239,68,68,.10); }
      .summary-chip.drift { border-color: rgba(245,158,11,.3); color: #fbbf24; background: rgba(245,158,11,.10); }
      .summary-chip.compliant { border-color: rgba(16,185,129,.3); color: #34d399; background: rgba(16,185,129,.10); }
      .summary-chip.evaluating { border-color: rgba(14,165,164,.3); color: #5eead4; background: rgba(14,165,164,.10); }
      .summary-chip.neutral { border-color: rgba(113,113,122,.3); color: #d4d4d8; background: rgba(113,113,122,.10); }
      .secondary-list {
        margin-top: 14px;
        border-top: 1px solid var(--border);
        padding-top: 14px;
      }
      .secondary-list summary {
        cursor: pointer;
        color: var(--text-secondary);
        font-weight: 700;
        margin-bottom: 12px;
      }
      .scenario-overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
      .spec-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-top: 12px; }
      .spec-column {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 12px;
        background: #10131a;
        min-width: 0;
      }
      .spec-badges { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .spec-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 8px;
        padding: 6px 10px;
        border: 1px solid var(--border);
        background: #10131a;
        font-size: 11px;
        font-weight: 700;
      }
      .workflow-panel pre { max-height: 360px; width: 100%; box-sizing: border-box; }
      @media (max-width: 1100px) {
        .app-shell { grid-template-columns: 1fr; }
        .sidebar { display: none; }
        .setup-grid, .runs-grid { grid-template-columns: 1fr; }
        .run-split { grid-template-columns: 1fr; }
        .mini-summary { grid-template-columns: 1fr; }
        .header { padding: 0 16px; }
        .health-strip { display: none; }
      }
    </style>
  </head>
  <body>
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="sidebar-logo">A</div>
          <div class="sidebar-title">Agentic <span>Platform</span></div>
        </div>
        <nav class="sidebar-nav">
          <button id="overviewNav" class="active"><span class="nav-icon">OV</span><span class="nav-label">Agentic overview</span></button>
          <button id="runsNav"><span class="nav-icon">AR</span><span class="nav-label">Agentic runs</span></button>
          <button id="adaptersNav"><span class="nav-icon">AD</span><span class="nav-label">Adapters</span></button>
          <button id="insightsNav"><span class="nav-icon">IN</span><span class="nav-label">Insights</span></button>
        </nav>
        <div class="sidebar-footer">
          <button id="settingsNav"><span class="nav-icon">ST</span><span class="nav-label">Settings</span></button>
          <div class="sidebar-version">v0.1.0-alpha</div>
        </div>
      </aside>
      <main class="main">
        <header class="header">
          <div class="header-title" id="pageTitle">Agentic overview</div>
          <div class="health-strip" id="healthStrip">
            <span>API <span class="health-dot ok"></span> up</span>
            <span class="health-separator"></span>
            <span>DB <span class="health-dot ok"></span> ok</span>
            <span class="health-separator"></span>
            <span>Activity <span id="healthActivity">n/a</span></span>
            <span class="health-separator"></span>
            <span>Run <span id="healthRun">none</span></span>
          </div>
        </header>
        <div class="shell">
      <div class="layout">
        <div id="setupPanel" class="panel">
          <div class="setup-grid">
        <div class="card stack">
          <div>
            <h2>Start agentic session</h2>
            <label for="repoPath">Repository path</label>
            <input id="repoPath" value="${DEFAULT_REPO}" />
          </div>
          <div>
            <label for="adapterSelect">Adapter</label>
            <select id="adapterSelect"></select>
          </div>
          <div id="adapterHint" class="hint">Select an adapter to continue.</div>
          <div>
            <label for="scenarioSelect">Scenario</label>
            <select id="scenarioSelect"></select>
          </div>
          <div>
            <label for="simulateRetryStep">Simulate retry on step</label>
            <input id="simulateRetryStep" placeholder="example: register_customer" />
          </div>
          <div class="actions">
            <button id="initializeBtn">Start Run</button>
            <button id="installBtn" class="secondary">Install .agentic-qa</button>
            <button id="discoverBtn" class="secondary">Discover</button>
            <button id="reviewBtn" class="secondary">Review</button>
          </div>
          <div class="actions">
            <button id="markReviewedBtn" class="secondary">Mark Reviewed</button>
            <button id="promoteCertifiedBtn" class="secondary">Promote Certified</button>
            <div></div>
          </div>
          <div class="status" id="status">Loading adapters...</div>
          <pre id="executionOutput">No execution initialized yet.</pre>
          <h3>Raw API Output</h3>
          <pre id="rawOutput">No data yet.</pre>
        </div>
        <div id="reviewPanel" class="card panel">
          <h2>Bootstrap Review</h2>
          <div class="summary" id="summary"></div>
          <div id="reviewGates" class="review-gates"></div>
          <div id="domainReview" class="review-domain"></div>
          <div class="lists" style="margin-bottom: 16px;">
            <div><h3>Candidate Status</h3><ul id="candidateStatus"></ul></div>
            <div><h3>Host Notes</h3><ul id="hostNotes"></ul></div>
          </div>
          <div class="lists">
            <div><h3>Roles</h3><ul id="roles"></ul></div>
            <div><h3>Surfaces</h3><ul id="surfaces"></ul></div>
          </div>
          <div class="lists" style="margin-top: 16px;">
            <div><h3>Personas</h3><ul id="personas"></ul></div>
            <div><h3>Scenarios</h3><ul id="scenarios"></ul></div>
          </div>
          <div class="lists" style="margin-top: 16px;">
            <div><h3>Capability Candidates</h3><ul id="capabilities"></ul></div>
            <div><h3>Risks</h3><ul id="risks"></ul></div>
          </div>
          <div style="margin-top: 16px;">
            <h3>Domain Candidate Details</h3>
            <div id="candidateDetails" class="candidate-grid"></div>
          </div>
          <div style="margin-top: 16px;">
            <h3>Rendered Review</h3>
            <iframe id="reviewFrame" sandbox=""></iframe>
          </div>
          <div style="margin-top: 16px;">
            <h3>Generated Adapter Editor</h3>
            <div class="hint" id="editorHint">Select a draft adapter to edit generated files.</div>
            <div class="actions" style="margin-bottom: 8px;">
              <select id="generatedFileSelect"></select>
              <button id="loadGeneratedFileBtn" class="secondary">Load File</button>
              <button id="saveGeneratedFileBtn" class="secondary">Save File</button>
            </div>
            <textarea id="generatedFileEditor" placeholder="Generated file content will appear here."></textarea>
          </div>
        </div>
          </div>
        </div>
        <div id="runsPanel" class="panel hidden">
          <div class="runs-grid">
            <div class="runs-sidebar">
              <div class="card">
                <h2>Agentic sessions</h2>
                <p class="muted">Multi-agent runs with handoffs and persisted events.</p>
                <div id="sessionSummaryBadges" class="session-summary-badges"></div>
                <div id="sessionTypeFilters" class="session-filter-row"></div>
                <div id="contractFilters" class="session-filter-row"></div>
                <div id="sortFilters" class="session-filter-row"></div>
                <div class="project-filter">
                  <label for="projectFilter">Project</label>
                  <select id="projectFilter"></select>
                </div>
                <h3>Sessions</h3>
                <div id="sessionList" class="execution-list"></div>
                <details class="secondary-list">
                  <summary>Executions</summary>
                  <div id="executionList" class="execution-list"></div>
                </details>
              </div>
            </div>
            <div id="agenticRunsSection" class="run-stack">
              <div class="run-summary" id="runSummary"></div>
              <div class="card">
                <div class="run-header">
                  <div>
                    <h2 class="run-title" id="runTitle">No run selected</h2>
                    <div class="run-subtitle" id="runSubtitle">Select an execution or session to inspect details.</div>
                  </div>
                </div>
                <div id="runEmptyState" class="empty-run-state">Select a run from the left to inspect execution, contract, artifacts and findings.</div>
                <div id="runScenarioOverview" class="scenario-overview-grid hidden"></div>
              </div>
              <div id="workflowPanel" class="card workflow-panel hidden">
                <h3 class="section-title">Workflow contract</h3>
                <p class="muted">Deterministic spec expected for this run.</p>
                <pre id="workflowContractPre"></pre>
              </div>
              <div id="specPanel" class="card hidden">
                <h3 class="section-title">Spec vs run real</h3>
                <p class="muted">Comparison between expected contract and observed execution.</p>
                <div id="specVsRunReal"></div>
              </div>
              <details id="diagnosticsPanel" class="secondary-list hidden">
                <summary>Diagnostics</summary>
                <div class="run-split">
                  <div class="run-column">
                    <div class="card">
                      <h3>Execution Detail</h3>
                      <div id="executionDetail"></div>
                    </div>
                    <div class="card">
                      <h3>Session Detail</h3>
                      <div id="sessionDetail"></div>
                    </div>
                  </div>
                  <div class="run-column">
                    <div class="card">
                      <h3 class="section-title">Artifacts</h3>
                      <div id="artifactList" class="artifact-list"></div>
                    </div>
                    <div class="card">
                      <h3 class="section-title">Findings</h3>
                      <div id="findingList" class="finding-list"></div>
                    </div>
                  </div>
                </div>
              </details>
              <div class="card">
                <h3 class="section-title">Session Timeline</h3>
                <div id="sessionTimeline" class="event-list"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
        </div>
      </main>
    </div>
    <script>
      const controlPlaneToken = ${CONTROL_PLANE_TOKEN_JS}
      const apiBase = 'http://127.0.0.1:${API_PORT}'
      const repoPath = document.getElementById('repoPath')
      const adapterSelect = document.getElementById('adapterSelect')
      const adapterHint = document.getElementById('adapterHint')
      const scenarioSelect = document.getElementById('scenarioSelect')
      const simulateRetryStep = document.getElementById('simulateRetryStep')
      const rawOutput = document.getElementById('rawOutput')
      const executionOutput = document.getElementById('executionOutput')
      const setupTab = document.getElementById('setupTab')
      const runsTab = document.getElementById('runsTab')
      const reviewTab = document.getElementById('reviewTab')
      const overviewNav = document.getElementById('overviewNav')
      const runsNav = document.getElementById('runsNav')
      const adaptersNav = document.getElementById('adaptersNav')
      const insightsNav = document.getElementById('insightsNav')
      const settingsNav = document.getElementById('settingsNav')
      const pageTitle = document.getElementById('pageTitle')
      const healthActivity = document.getElementById('healthActivity')
      const healthRun = document.getElementById('healthRun')
      const setupPanel = document.getElementById('setupPanel')
      const runsPanel = document.getElementById('runsPanel')
      const reviewPanel = document.getElementById('reviewPanel')
      const projectFilter = document.getElementById('projectFilter')
      const sessionSummaryBadges = document.getElementById('sessionSummaryBadges')
      const sessionTypeFilters = document.getElementById('sessionTypeFilters')
      const contractFilters = document.getElementById('contractFilters')
      const sortFilters = document.getElementById('sortFilters')
      const agenticRunsSection = document.getElementById('agenticRunsSection')
      const executionList = document.getElementById('executionList')
      const sessionList = document.getElementById('sessionList')
      const runSummary = document.getElementById('runSummary')
      const runTitle = document.getElementById('runTitle')
      const runSubtitle = document.getElementById('runSubtitle')
      const runEmptyState = document.getElementById('runEmptyState')
      const runScenarioOverview = document.getElementById('runScenarioOverview')
      const workflowPanel = document.getElementById('workflowPanel')
      const workflowContractPre = document.getElementById('workflowContractPre')
      const specPanel = document.getElementById('specPanel')
      const specVsRunReal = document.getElementById('specVsRunReal')
      const diagnosticsPanel = document.getElementById('diagnosticsPanel')
      const executionDetail = document.getElementById('executionDetail')
      const sessionDetail = document.getElementById('sessionDetail')
      const sessionTimeline = document.getElementById('sessionTimeline')
      const contractEvaluation = document.getElementById('contractEvaluation')
      const artifactList = document.getElementById('artifactList')
      const findingList = document.getElementById('findingList')
      const status = document.getElementById('status')
      const summary = document.getElementById('summary')
      const roles = document.getElementById('roles')
      const surfaces = document.getElementById('surfaces')
      const personas = document.getElementById('personas')
      const scenarios = document.getElementById('scenarios')
      const capabilities = document.getElementById('capabilities')
      const risks = document.getElementById('risks')
      const reviewGates = document.getElementById('reviewGates')
      const domainReview = document.getElementById('domainReview')
      const candidateStatus = document.getElementById('candidateStatus')
      const hostNotes = document.getElementById('hostNotes')
      const candidateDetails = document.getElementById('candidateDetails')
      const reviewFrame = document.getElementById('reviewFrame')
      const generatedFileSelect = document.getElementById('generatedFileSelect')
      const generatedFileEditor = document.getElementById('generatedFileEditor')
      const generatedFileBtn = document.getElementById('loadGeneratedFileBtn')
      const saveGeneratedFileBtn = document.getElementById('saveGeneratedFileBtn')
      const editorHint = document.getElementById('editorHint')
      const initializeBtn = document.getElementById('initializeBtn')
      const discoverBtn = document.getElementById('discoverBtn')
      const reviewBtn = document.getElementById('reviewBtn')
      const installBtn = document.getElementById('installBtn')
      const markReviewedBtn = document.getElementById('markReviewedBtn')
      const promoteCertifiedBtn = document.getElementById('promoteCertifiedBtn')
      let adaptersById = {}
      let selectedExecutionId = null
      let selectedSessionId = null
      let activePanel = 'setup'
      let projectFilterValue = 'all'
      let sessionTypeFilter = 'all'
      let contractFilterValue = 'all'
      let sortMode = 'recent'
      let currentExecution = null
      let currentSession = null
      let installedLocalPackagePath = null

      function requestPayload() {
        return { repoPath: repoPath.value, adapterHint: adapterSelect.value }
      }

      function setRaw(value) { rawOutput.textContent = JSON.stringify(value, null, 2) }
      function setExecution(value) { executionOutput.textContent = JSON.stringify(value, null, 2) }
      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;')
      }
      function list(target, items) {
        target.innerHTML = ''
        for (const item of items || []) {
          const li = document.createElement('li')
          li.textContent = item
          target.appendChild(li)
        }
      }

      function statusPill(statusValue) {
        const safe = escapeHtml(statusValue)
        return '<span class="pill ' + safe + '">' + safe + '</span>'
      }

      function contractPill(verdict) {
        if (!verdict) return '<span class="pill no_contract">no contract</span>'
        const safe = escapeHtml(verdict)
        const label = escapeHtml(String(verdict).replace('contract_', '').replaceAll('_', ' '))
        return '<span class="pill ' + safe + '">' + label + '</span>'
      }

      function sessionModePill(personaCount) {
        const mode = Number(personaCount || 0) > 1 ? 'multi-agent' : 'single-agent'
        return '<span class="pill ' + mode + '">' + mode.replace('-', ' ') + '</span>'
      }

      function switchPanel(panel) {
        activePanel = panel
        setupPanel.classList.toggle('hidden', panel !== 'setup')
        runsPanel.classList.toggle('hidden', panel !== 'runs')
        reviewPanel.classList.toggle('hidden', panel !== 'review')
        if (setupTab) setupTab.classList.toggle('active', panel === 'setup')
        if (runsTab) runsTab.classList.toggle('active', panel === 'runs')
        if (reviewTab) reviewTab.classList.toggle('active', panel === 'review')
        overviewNav.classList.toggle('active', panel === 'setup')
        runsNav.classList.toggle('active', panel === 'runs')
        adaptersNav.classList.toggle('active', panel === 'review')
        insightsNav.classList.remove('active')
        settingsNav.classList.remove('active')
        pageTitle.textContent = panel === 'runs' ? 'Agentic runs' : panel === 'review' ? 'Adapters' : 'Agentic overview'
      }

      function projectLabel(projectPath) {
        if (!projectPath) return 'unknown-project'
        const normalized = String(projectPath).replace(/\\\\/g, '/')
        const parts = normalized.split('/').filter(Boolean)
        return parts[parts.length - 1] || normalized
      }

      function formatDuration(startedAt, completedAt, statusValue) {
        if (!startedAt) return 'n/a'
        const start = new Date(startedAt).getTime()
        const end = completedAt ? new Date(completedAt).getTime() : Date.now()
        const totalSeconds = Math.max(0, Math.floor((end - start) / 1000))
        const minutes = Math.floor(totalSeconds / 60)
        const seconds = totalSeconds % 60
        const label = minutes > 0 ? (minutes + 'm ' + seconds + 's') : (seconds + 's')
        return statusValue === 'running' || statusValue === 'pending' ? label + ' live' : label
      }

      function shortId(value) {
        return value ? String(value).slice(0, 8) : 'n/a'
      }

      function renderSummary(model) {
        summary.innerHTML = ''
        const metrics = [
          ['Framework', model.summary.framework],
          ['Repo', model.summary.repositoryKind || 'unknown'],
          ['Domain', model.summary.domain || 'unknown'],
          ['Roles', model.summary.rolesDetected],
          ['Surfaces', model.summary.surfacesDetected],
          ['Scenarios', model.summary.scenariosGenerated],
          ['Evidence', model.summary.evidenceItems || 0],
          ['Mapping', model.summary.mappingRequired || 0],
          ['Runnable', model.summary.runnableCandidates || 0],
        ]
        for (const [label, value] of metrics) {
          const el = document.createElement('div')
          el.className = 'metric'
          el.innerHTML = '<div class="metric-label">' + escapeHtml(label) + '</div><div class="metric-value">' + escapeHtml(value) + '</div>'
          summary.appendChild(el)
        }
      }

      function renderReviewGates(model) {
        reviewGates.innerHTML = (model.reviewGates || []).map((gate) =>
          '<div class="review-gate ' + escapeHtml(gate.severity) + '">' +
            '<strong>' + escapeHtml(gate.title) + '</strong>' +
            '<div class="muted">' + escapeHtml(gate.message) + '</div>' +
          '</div>'
        ).join('') || '<div class="review-gate"><strong>No review gates</strong><div class="muted">Run discovery to populate review signals.</div></div>'
      }

      function renderDomainReview(model) {
        const domain = model.domainReview || {}
        domainReview.innerHTML =
          '<div class="metric">' +
            '<div class="metric-label">Domain</div>' +
            '<div class="metric-value">' + escapeHtml(domain.label || domain.domain || 'unknown') + '</div>' +
            '<div class="muted">' + escapeHtml(domain.summary || 'No domain summary available.') + '</div>' +
          '</div>' +
          '<div class="metric">' +
            '<div class="metric-label">Discovery Governance</div>' +
            '<div>' +
              '<span class="candidate-status ' + escapeHtml(domain.status || '') + '">' + escapeHtml(domain.status || 'unavailable') + '</span> ' +
              '<span class="candidate-status ' + escapeHtml(domain.auditStatus || '') + '">' + escapeHtml(domain.auditStatus || 'audit unavailable') + '</span>' +
            '</div>' +
            '<div class="muted">confidence ' + Math.round(Number(domain.confidence || 0) * 100) + '% · audit findings ' + ((domain.auditFindings || []).length) + '</div>' +
          '</div>'
      }

      function renderCandidateStatus(model) {
        const counts = model.statusCounts || {}
        list(candidateStatus, [
          'runnable candidates: ' + (counts.runnable_candidate || 0),
          'needs human mapping: ' + (counts.needs_human_mapping || 0),
          'draft: ' + (counts.draft || 0),
          'restricted: ' + (counts.restricted || 0),
        ])
      }

      function renderCandidateDetails(model) {
        const sections = [
          ['Personas', model.candidatePersonas || []],
          ['Scenarios', model.candidateScenarios || []],
          ['Capabilities', model.candidateCapabilities || []],
        ]
        candidateDetails.innerHTML = sections.map(([title, items]) => {
          const cards = items.length ? items.map((item) =>
            '<div class="candidate-card">' +
              '<span class="candidate-status ' + escapeHtml(item.status) + '">' + escapeHtml(item.status) + '</span>' +
              '<div class="candidate-card-title">' + escapeHtml(item.title) + '</div>' +
              '<div class="candidate-meta">id: ' + escapeHtml(item.id) + '</div>' +
              '<div class="candidate-meta">confidence: ' + Math.round(Number(item.confidence || 0) * 100) + '%</div>' +
              '<div class="candidate-meta">evidence: ' + escapeHtml((item.evidenceRefs || []).slice(0, 4).join(', ') || 'none') + '</div>' +
              '<div class="candidate-meta">risks: ' + escapeHtml((item.risks || []).slice(0, 2).join(' | ') || 'none') + '</div>' +
            '</div>'
          ).join('') : '<div class="candidate-card"><div class="muted">No ' + escapeHtml(String(title).toLowerCase()) + ' candidates.</div></div>'
          return '<div><h4>' + escapeHtml(title) + '</h4>' + cards + '</div>'
        }).join('')
      }

      function currentAdapter() {
        return adaptersById[adapterSelect.value] || null
      }

      function renderProjectFilter(executions) {
        const projects = ['all', ...new Set((executions || []).map((execution) => execution.hostProjectPath).filter(Boolean))]
        projectFilter.innerHTML = ''
        for (const project of projects) {
          const option = document.createElement('option')
          option.value = project
          option.textContent = project === 'all' ? 'All projects' : projectLabel(project)
          if (project === projectFilterValue) option.selected = true
          projectFilter.appendChild(option)
        }
      }

      function severityRank(verdict) {
        switch (verdict) {
          case 'contract_violated': return 0
          case 'contract_drift': return 1
          case 'contract_evaluating': return 2
          case 'contract_compliant': return 3
          default: return 4
        }
      }

      function renderSessionFilters(sessions) {
        const summary = (sessions || []).reduce((acc, session) => {
          const verdict = session.contractEvaluation?.verdict || 'no_contract'
          if (verdict === 'contract_violated') acc.violated += 1
          else if (verdict === 'contract_drift') acc.drift += 1
          else if (verdict === 'contract_compliant') acc.compliant += 1
          else if (verdict === 'contract_evaluating') acc.evaluating += 1
          else acc.noContract += 1
          return acc
        }, { violated: 0, drift: 0, compliant: 0, evaluating: 0, noContract: 0 })

        sessionSummaryBadges.innerHTML =
          '<span class="summary-chip violated">violated ' + summary.violated + '</span>' +
          '<span class="summary-chip drift">drift ' + summary.drift + '</span>' +
          '<span class="summary-chip compliant">compliant ' + summary.compliant + '</span>' +
          '<span class="summary-chip evaluating">evaluating ' + summary.evaluating + '</span>' +
          '<span class="summary-chip neutral">no contract ' + summary.noContract + '</span>'

        const typeOptions = [
          ['all', 'All'],
          ['single', 'Single-agent'],
          ['multi', 'Multi-agent'],
        ]
        sessionTypeFilters.innerHTML = typeOptions.map(([id, label]) =>
          '<button class="filter-chip ' + (sessionTypeFilter === id ? 'active' : '') + '" onclick="setSessionTypeFilter(&quot;' + id + '&quot;)">' + label + '</button>'
        ).join('')

        const contractOptions = [
          ['all', 'All contracts'],
          ['contract_evaluating', 'Evaluating'],
          ['contract_compliant', 'Compliant'],
          ['contract_drift', 'Drift'],
          ['contract_violated', 'Violated'],
        ]
        contractFilters.innerHTML = contractOptions.map(([id, label]) =>
          '<button class="filter-chip ' + (contractFilterValue === id ? 'active' : '') + '" onclick="setContractFilter(&quot;' + id + '&quot;)">' + label + '</button>'
        ).join('')

        const sortOptions = [
          ['recent', 'Most recent'],
          ['contract_severity', 'Contract severity'],
        ]
        sortFilters.innerHTML = sortOptions.map(([id, label]) =>
          '<button class="filter-chip ' + (sortMode === id ? 'active' : '') + '" onclick="setSortModeValue(&quot;' + id + '&quot;)">' + label + '</button>'
        ).join('')
      }

      function formatRelativeTime(timestamp) {
        if (!timestamp) return 'n/a'
        const diffMs = Date.now() - new Date(timestamp).getTime()
        const diffMinutes = Math.max(0, Math.floor(diffMs / 60000))
        if (diffMinutes < 1) return 'just now'
        if (diffMinutes < 60) return diffMinutes + 'm ago'
        const diffHours = Math.floor(diffMinutes / 60)
        if (diffHours < 24) return diffHours + 'h ago'
        return Math.floor(diffHours / 24) + 'd ago'
      }

      function updateHealthStrip(executions, sessions) {
        const latestExecution = (executions || [])[0]
        const latestSession = (sessions || [])[0]
        const latestTimestamp = latestSession?.startedAt || latestExecution?.createdAt || null
        const activeExecution = (executions || []).find((execution) => execution.status === 'running' || execution.status === 'pending')
        healthActivity.textContent = formatRelativeTime(latestTimestamp)
        if (activeExecution) {
          healthRun.textContent = activeExecution.scenarioId + ' live'
        } else {
          healthRun.textContent = 'none'
        }
      }

      function updateActionState() {
        const adapter = currentAdapter()
        const hasAdapter = !!adapter
        const hasScenario = !!scenarioSelect.value
        const hasRepoPath = !!repoPath.value.trim()
        const selectedScenarioOption = scenarioSelect.options[scenarioSelect.selectedIndex]
        const selectedScenarioGate = selectedScenarioOption ? selectedScenarioOption.dataset.gateStatus : ''
        initializeBtn.disabled = !(hasAdapter && hasScenario) || selectedScenarioGate === 'restricted'
        reviewBtn.disabled = !hasAdapter

        const isCertified = adapter?.status === 'certified'
        installBtn.disabled = !hasRepoPath
        discoverBtn.disabled = !!isCertified || !installedLocalPackagePath
        markReviewedBtn.disabled = !!isCertified
        promoteCertifiedBtn.disabled = !!isCertified || adapter?.promotionState !== 'certified_candidate'
        generatedFileSelect.disabled = !!isCertified
        generatedFileBtn.disabled = !!isCertified
        saveGeneratedFileBtn.disabled = !!isCertified

        if (!adapter) {
          adapterHint.textContent = 'Select an adapter to continue.'
          editorHint.textContent = 'Select a draft adapter to edit generated files.'
          return
        }

        if (isCertified) {
          adapterHint.textContent = 'Certified adapter selected. Promotion: ' + adapter.promotionState + '. ' + adapter.promotionReason
          editorHint.textContent = 'Certified adapter selected. Generated file editing is only available for draft adapters.'
          return
        }

        adapterHint.textContent = (installedLocalPackagePath ? 'Local package installed at ' + installedLocalPackagePath + '. ' : 'Install .agentic-qa before Discover. ') + 'Draft adapter selected. Promotion: ' + adapter.promotionState + '. ' + adapter.promotionReason
        editorHint.textContent = 'Draft adapter selected. Load and edit generated model files below.'
      }

      function renderReview(result) {
        const model = result.report || result
        renderSummary(model)
        renderReviewGates(model)
        renderDomainReview(model)
        renderCandidateStatus(model)
        list(roles, (model.roles || []).map((role) => role.id + ' — confidence ' + role.confidence))
        list(surfaces, (model.surfaces || []).map((surface) => surface.id + ' — ' + surface.kind))
        list(personas, (model.personas || []).map((persona) => persona.id + ' — ' + persona.title))
        list(scenarios, (model.scenarios || []).map((scenario) => scenario.id + ' — ' + ((scenario.participatingRoles || scenario.roles || []).join(', '))))
        list(capabilities, model.capabilityCandidates || [])
        list(risks, model.risks || [])
        list(hostNotes, model.hostNotes || [])
        renderCandidateDetails(model)
        if (result.html) reviewFrame.srcdoc = result.html
      }

      function renderExecutionList(result) {
        executionList.innerHTML = ''
        const executions = (result.executions || []).filter((execution) => projectFilterValue === 'all' || execution.hostProjectPath === projectFilterValue)
        for (const execution of executions) {
          const card = document.createElement('div')
          card.className = 'execution-item' + (execution.executionId === selectedExecutionId ? ' active' : '')
          const personaCount = execution.personas?.length || 0
          card.innerHTML =
            '<div class="run-card-header">' +
              '<div class="run-card-title">' + escapeHtml(execution.scenarioId) + '</div>' +
              '<div class="run-card-badges">' + sessionModePill(personaCount) + statusPill(execution.status) + '</div>' +
            '</div>' +
            '<div class="project-badge">' + escapeHtml(projectLabel(execution.hostProjectPath)) + '</div>' +
            '<div class="run-card-stats">' +
              '<div class="run-card-stat"><strong>Adapter</strong>' + escapeHtml(execution.adapterId) + '</div>' +
              '<div class="run-card-stat"><strong>Steps</strong>' + escapeHtml(execution.steps?.length || 0) + '</div>' +
              '<div class="run-card-stat"><strong>Session</strong>' + escapeHtml(shortId(execution.sessionId)) + '</div>' +
            '</div>' +
            '<div class="run-card-footer">' + escapeHtml(formatRelativeTime(execution.createdAt)) + ' • ' + escapeHtml(execution.hostProjectPath || 'unknown-project') + '</div>'
          card.onclick = async () => {
            selectedExecutionId = execution.executionId
            selectedSessionId = execution.sessionId || null
            renderExecutionList(result)
            if (selectedSessionId) {
              await Promise.all([loadExecutionDetail(selectedExecutionId), loadSessionDetail(selectedSessionId)])
              return
            }
            await loadExecutionDetail(selectedExecutionId)
          }
          executionList.appendChild(card)
        }
      }

      function renderSessionList(result, executions) {
        sessionList.innerHTML = ''
        const executionBySession = Object.fromEntries((executions || []).map((execution) => [execution.sessionId, execution]))
        renderSessionFilters(result.sessions || [])
        const sessions = (result.sessions || []).filter((session) => {
          if (projectFilterValue === 'all') return true
          const execution = executionBySession[session.id]
          if (execution?.hostProjectPath !== projectFilterValue) return false
          return true
        }).filter((session) => {
          const isMulti = session.scenarioId.includes('multi_role')
          if (sessionTypeFilter === 'multi') return isMulti
          if (sessionTypeFilter === 'single') return !isMulti
          return true
        }).filter((session) => {
          if (contractFilterValue === 'all') return true
          return (session.contractEvaluation?.verdict || 'no_contract') === contractFilterValue
        }).sort((a, b) => {
          if (sortMode === 'contract_severity') {
            const diff = severityRank(a.contractEvaluation?.verdict || 'no_contract') - severityRank(b.contractEvaluation?.verdict || 'no_contract')
            if (diff !== 0) return diff
          }
          return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
        })
        for (const session of sessions) {
          const card = document.createElement('div')
          card.className = 'execution-item' + (session.id === selectedSessionId ? ' active' : '')
          const contractVerdict = session.contractEvaluation?.verdict || 'no_contract_evaluation'
          const hostProjectPath = executionBySession[session.id]?.hostProjectPath || session.events?.[0]?.data?.hostProjectPath || ''
          const execution = executionBySession[session.id]
          const lastFailedEvent = [...(session.events || [])].reverse().find((event) => event.type === 'step_failed')
          const failedStep = lastFailedEvent?.data?.stepId || lastFailedEvent?.data?.step || null
          card.innerHTML =
            '<div class="run-card-header">' +
              '<div class="run-card-title">' + escapeHtml(session.scenarioId) + '</div>' +
              '<div class="run-card-badges">' + sessionModePill(execution?.personas?.length || 0) + statusPill(session.status) + '</div>' +
            '</div>' +
            '<div class="run-card-badges">' + contractPill(contractVerdict === 'no_contract_evaluation' ? null : contractVerdict) + '</div>' +
            '<div class="run-card-stats">' +
              '<div class="run-card-stat"><strong>Events</strong>' + escapeHtml(session.events?.length || 0) + '</div>' +
              '<div class="run-card-stat"><strong>Artifacts</strong>' + escapeHtml(Object.keys(session.artifacts || {}).length) + '</div>' +
              '<div class="run-card-stat"><strong>Findings</strong>' + escapeHtml((session.findings || []).length) + '</div>' +
            '</div>' +
            (failedStep ? '<div class="run-card-error">Failed at ' + escapeHtml(failedStep) + '</div>' : '') +
            '<div class="run-card-footer">' + escapeHtml(formatRelativeTime(session.startedAt)) + '</div>'
          card.onclick = async () => {
            selectedSessionId = session.id
            if (execution?.executionId) {
              selectedExecutionId = execution.executionId
            }
            renderSessionList(result, executions)
            if (selectedExecutionId) {
              renderExecutionList({ executions })
              await Promise.all([
                loadExecutionDetail(selectedExecutionId),
                loadSessionDetail(selectedSessionId),
              ])
              return
            }
            await loadSessionDetail(selectedSessionId)
          }
          sessionList.appendChild(card)
        }
      }

      function setSessionTypeFilter(value) {
        sessionTypeFilter = value
        void loadSessions()
      }

      function setContractFilter(value) {
        contractFilterValue = value
        void loadSessions()
      }

      function setSortModeValue(value) {
        sortMode = value
        void loadSessions()
      }

      function renderExecutionDetail(result) {
        const execution = result.execution
        currentExecution = execution
        runEmptyState.classList.add('hidden')
        diagnosticsPanel.classList.remove('hidden')
        runTitle.textContent = execution.scenarioId
        runSubtitle.textContent = projectLabel(execution.hostProjectPath) + ' • ' + execution.hostProjectPath
        executionDetail.innerHTML =
          '<div class="detail-summary">' +
            '<div class="detail-meta-grid">' +
              '<div class="detail-meta"><div class="detail-meta-label">Execution ID</div><div class="detail-meta-value">' + escapeHtml(shortId(execution.executionId)) + '</div></div>' +
              '<div class="detail-meta"><div class="detail-meta-label">Adapter</div><div class="detail-meta-value">' + escapeHtml(execution.adapterId) + '</div></div>' +
              '<div class="detail-meta"><div class="detail-meta-label">Status</div><div class="detail-meta-value">' + escapeHtml(execution.status) + '</div></div>' +
              '<div class="detail-meta"><div class="detail-meta-label">Session</div><div class="detail-meta-value">' + escapeHtml(shortId(execution.sessionId)) + '</div></div>' +
              '<div class="detail-meta"><div class="detail-meta-label">Steps</div><div class="detail-meta-value">' + escapeHtml(execution.steps?.join(', ') || 'none') + '</div></div>' +
              '<div class="detail-meta"><div class="detail-meta-label">Events</div><div class="detail-meta-value">' + escapeHtml(execution.events?.length || 0) + '</div></div>' +
            '</div>' +
            '<div class="detail-raw-toggle" onclick="toggleDetailRaw(&quot;executionRaw&quot;)">Toggle raw payload</div>' +
            '<pre id="executionRaw" class="detail-raw hidden">' + escapeHtml(JSON.stringify({
              executionId: execution.executionId,
              status: execution.status,
              adapterId: execution.adapterId,
              hostProjectPath: execution.hostProjectPath,
              scenarioId: execution.scenarioId,
              sessionId: execution.sessionId,
              steps: execution.steps,
              eventCount: execution.events?.length || 0,
            }, null, 2)) + '</pre>' +
          '</div>'
      }

      function renderSessionDetail(result) {
        const session = result.session
        currentSession = session
        runEmptyState.classList.add('hidden')
        diagnosticsPanel.classList.remove('hidden')
        if (!selectedExecutionId) {
          runTitle.textContent = session.scenarioId
          const hostProjectPath = session.events?.[0]?.data?.hostProjectPath || 'unknown-project'
          runSubtitle.textContent = projectLabel(hostProjectPath) + ' • ' + hostProjectPath
        }
        runSummary.innerHTML = ''
        const hostProjectPath = session.events?.[0]?.data?.hostProjectPath || null
        const metrics = [
          ['Status', session.status],
          ['Duration', formatDuration(session.startedAt, session.completedAt, session.status)],
          ['Events', String(session.events?.length || 0)],
          ['Findings', String((session.findings || []).length)],
        ]
        for (const [label, value] of metrics) {
          const el = document.createElement('div')
          el.className = 'metric run-overview-card'
          el.innerHTML = '<div class="metric-label">' + escapeHtml(label) + '</div><div class="metric-value">' + escapeHtml(value) + '</div>'
          runSummary.appendChild(el)
        }
        const checkpoint = session.checkpoint
          ? 'step ' + String(session.checkpoint.lastCompletedStep ?? 'n/a') + ' / cursor ' + String(session.checkpoint.cursor ?? 'n/a')
          : 'n/a'
        const verdict = session.contractEvaluation?.verdict || 'n/a'
        runScenarioOverview.classList.remove('hidden')
        runScenarioOverview.innerHTML =
          '<div class="detail-meta"><div class="detail-meta-label">Started</div><div class="detail-meta-value">' + escapeHtml(formatRelativeTime(session.startedAt)) + '</div></div>' +
          '<div class="detail-meta"><div class="detail-meta-label">Checkpoint</div><div class="detail-meta-value">' + escapeHtml(checkpoint) + '</div></div>' +
          '<div class="detail-meta"><div class="detail-meta-label">Artifacts</div><div class="detail-meta-value">' + escapeHtml(Object.keys(session.artifacts || {}).length) + '</div></div>'
        sessionDetail.innerHTML =
          '<div class="detail-summary">' +
            '<div class="detail-meta-grid">' +
              '<div class="detail-meta"><div class="detail-meta-label">Session ID</div><div class="detail-meta-value">' + escapeHtml(shortId(session.id)) + '</div></div>' +
              '<div class="detail-meta"><div class="detail-meta-label">Started</div><div class="detail-meta-value">' + escapeHtml(formatRelativeTime(session.startedAt)) + '</div></div>' +
              '<div class="detail-meta"><div class="detail-meta-label">Checkpoint</div><div class="detail-meta-value">' + escapeHtml(checkpoint) + '</div></div>' +
              '<div class="detail-meta"><div class="detail-meta-label">Contract</div><div class="detail-meta-value">' + escapeHtml(verdict) + '</div></div>' +
              '<div class="detail-meta"><div class="detail-meta-label">Adapter</div><div class="detail-meta-value">' + escapeHtml(session.adapterId || 'n/a') + '</div></div>' +
              '<div class="detail-meta"><div class="detail-meta-label">Project</div><div class="detail-meta-value">' + escapeHtml(hostProjectPath || 'unknown-project') + '</div></div>' +
            '</div>' +
            '<div class="detail-raw-toggle" onclick="toggleDetailRaw(&quot;sessionRaw&quot;)">Toggle raw payload</div>' +
            '<pre id="sessionRaw" class="detail-raw hidden">' + escapeHtml(JSON.stringify({
              sessionId: session.id,
              status: session.status,
              adapterId: session.adapterId,
              executionId: session.executionId,
              hostProjectPath,
              scenarioId: session.scenarioId,
              checkpoint: session.checkpoint,
              eventCount: session.events?.length || 0,
              contractEvaluation: session.contractEvaluation || null,
              lastEvent: session.events?.[session.events.length - 1] || null,
            }, null, 2)) + '</pre>' +
          '</div>'
        renderWorkflowContract(session.contractEvaluation, currentExecution)
        renderSpecVsRunReal(session.contractEvaluation)
        renderArtifacts(session.artifacts || {})
        renderFindings(session.findings || [])
        renderSessionTimeline(session.events || [])
      }

      function toggleDetailRaw(id) {
        const element = document.getElementById(id)
        if (!element) return
        element.classList.toggle('hidden')
      }

      function renderWorkflowContract(evaluation, execution) {
        if (!evaluation) {
          workflowPanel.classList.remove('hidden')
          workflowContractPre.textContent = 'No workflow contract available for this run.'
          return
        }

        workflowPanel.classList.remove('hidden')
        const lines = [
          'version: 1.0',
          'deterministic: true',
          'steps:',
        ]
        for (const step of evaluation.stepChecks || []) {
          lines.push('  - id: ' + step.stepId)
          lines.push('    order: ' + step.expectedOrder)
          lines.push('    roleId: ' + step.roleId)
          lines.push('    capabilityId: ' + step.expectedCapability)
          lines.push('    expectedArtifacts:')
          if ((step.expectedArtifacts || []).length) {
            for (const artifact of step.expectedArtifacts) {
              lines.push('      - ' + artifact)
            }
          } else {
            lines.push('      - none')
          }
        }
        if (execution?.steps?.length) {
          lines.push('')
          lines.push('executionSteps:')
          for (const stepId of execution.steps) {
            lines.push('  - ' + stepId)
          }
        }
        workflowContractPre.textContent = lines.join('\\n')
      }

      function renderSpecVsRunReal(evaluation) {
        if (!evaluation) {
          specPanel.classList.remove('hidden')
          specVsRunReal.innerHTML = '<div class="muted">No contract evaluation available for this session.</div>'
          return
        }

        specPanel.classList.remove('hidden')
        specVsRunReal.innerHTML =
          '<div><span class="contract-verdict ' + escapeHtml(evaluation.verdict) + '">' + escapeHtml(String(evaluation.verdict).replaceAll('_', ' ')) + '</span>' +
          ' <span class="muted">hard violations: ' + escapeHtml(evaluation.hardViolations) + ' • drift signals: ' + escapeHtml(evaluation.driftSignals) + '</span></div>' +
          '<div class="spec-badges">' +
            '<span class="spec-badge">steps not started: ' + (evaluation.stepChecks || []).filter((step) => step.neverStarted).length + '</span>' +
            '<span class="spec-badge">steps incomplete: ' + (evaluation.stepChecks || []).filter((step) => step.incomplete).length + '</span>' +
            '<span class="spec-badge">steps failed: ' + (evaluation.stepChecks || []).filter((step) => step.status === 'failed').length + '</span>' +
            '<span class="spec-badge">missing artifacts: ' + (evaluation.missingArtifacts || []).length + '</span>' +
            '<span class="spec-badge">unexpected artifacts: ' + (evaluation.unexpectedArtifacts || []).length + '</span>' +
            '<span class="spec-badge">order mismatches: ' + (evaluation.stepChecks || []).filter((step) => step.outOfOrder).length + '</span>' +
            '<span class="spec-badge">capability mismatches: ' + (evaluation.stepChecks || []).filter((step) => step.capabilityMismatch).length + '</span>' +
          '</div>' +
          '<div class="spec-grid">' +
            '<div class="spec-column"><div class="metric-label">Expected Order</div><div class="contract-list">' +
              (evaluation.expectedStepOrder || []).map((stepId, index) => '<div class="contract-item"><div class="contract-key">' + escapeHtml((index + 1) + '. ' + stepId) + '</div></div>').join('') +
            '</div></div>' +
            '<div class="spec-column"><div class="metric-label">Observed Order</div><div class="contract-list">' +
              (evaluation.observedStepOrder || []).map((stepId, index) => '<div class="contract-item"><div class="contract-key">' + escapeHtml((index + 1) + '. ' + stepId) + '</div></div>').join('') +
            '</div></div>' +
          '</div>'
      }

      function renderArtifacts(artifacts) {
        const entries = Object.entries(artifacts || {})
        if (!entries.length) {
          artifactList.innerHTML = '<div class="muted">No artifacts produced for this session.</div>'
          return
        }

        artifactList.innerHTML = entries.map(([key, value]) => {
          const payload = typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value)
          return '<div class="artifact-item">' +
            '<div class="artifact-key">' + escapeHtml(key) + '</div>' +
            '<pre>' + escapeHtml(payload) + '</pre>' +
          '</div>'
        }).join('')
      }

      function renderFindings(findings) {
        if (!findings.length) {
          findingList.innerHTML = '<div class="muted">No findings recorded for this session.</div>'
          return
        }

        findingList.innerHTML = findings.map((finding, index) => {
          const severity = finding.severity || 'info'
          const code = finding.code || ('finding_' + (index + 1))
          const message = finding.message || JSON.stringify(finding)
          return '<div class="finding-item">' +
            '<div class="finding-title">' + escapeHtml(code) + '</div>' +
            '<div>' + escapeHtml(message) + '</div>' +
            '<div class="finding-meta">' + escapeHtml(severity) + '</div>' +
          '</div>'
        }).join('')
      }

      function renderSessionTimeline(events) {
        sessionTimeline.innerHTML = ''
        for (const event of events) {
          const item = document.createElement('div')
          const stateClass = event.type === 'step_failed' ? ' failed' : event.type === 'step_completed' || event.type === 'run_completed' ? ' completed' : ''
          item.className = 'event-item' + stateClass
          item.innerHTML =
            '<strong>' + escapeHtml(event.type) + '</strong>' +
            '<div>' + escapeHtml(JSON.stringify(event.data || {}, null, 2)) + '</div>' +
            '<div class="event-meta">' + escapeHtml(event.agentRole || 'system') + ' • ' + escapeHtml(event.timestamp) + '</div>'
          sessionTimeline.appendChild(item)
        }
      }

      function focusAgenticRun() {
        if (agenticRunsSection) {
          agenticRunsSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      }

      function authHeaders(extra) {
        const headers = { authorization: 'Bearer ' + controlPlaneToken }
        if (extra) {
          for (const key of Object.keys(extra)) headers[key] = extra[key]
        }
        return headers
      }

      async function getJson(path) {
        const response = await fetch(apiBase + path, { headers: authHeaders() })
        const json = await response.json()
        setRaw(json)
        if (!response.ok) {
          throw new Error(json.message || json.error || ('Request failed: ' + response.status))
        }
        return json
      }

      async function postJson(path, body) {
        const response = await fetch(apiBase + path, {
          method: 'POST',
          headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify(body),
        })
        const json = await response.json()
        setRaw(json)
        if (!response.ok) {
          throw new Error(json.message || json.error || ('Request failed: ' + response.status))
        }
        return json
      }

      async function loadAdapters() {
        const result = await getJson('/api/adapters')
        adaptersById = {}
        adapterSelect.innerHTML = ''
        for (const adapter of result.adapters) {
          adaptersById[adapter.id] = adapter
          const option = document.createElement('option')
          option.value = adapter.id
          option.textContent = adapter.label + ' — ' + adapter.status + ' — ' + adapter.promotionState
          adapterSelect.appendChild(option)
        }
        await loadScenarios(adapterSelect.value)
        updateActionState()
        if (currentAdapter()) {
          await loadReview()
        }
      }

      async function loadScenarios(adapterId) {
        status.textContent = 'Loading scenarios for ' + adapterId + ' ...'
        const result = await getJson('/api/adapters/' + encodeURIComponent(adapterId) + '/scenarios')
        scenarioSelect.innerHTML = ''
        for (const scenario of result.scenarios) {
          const option = document.createElement('option')
          option.value = scenario.id
          option.textContent = scenario.title + ' — ' + scenario.qualityGate.status
          option.dataset.gateStatus = scenario.qualityGate.status
          option.dataset.gateReason = scenario.qualityGate.reason
          scenarioSelect.appendChild(option)
        }
        status.textContent = 'Adapter and scenarios loaded.'
        updateActionState()
        if (currentAdapter()?.status === 'draft') {
          await loadGeneratedFiles()
        } else {
          generatedFileSelect.innerHTML = ''
          generatedFileEditor.value = ''
        }
      }

      async function loadExecutions() {
        const result = await getJson('/api/executions')
        renderProjectFilter(result.executions || [])
        renderExecutionList(result)
        updateHealthStrip(result.executions || [], [])
        if (!selectedExecutionId && result.executions?.length) {
          selectedExecutionId = result.executions[0].executionId
          selectedSessionId = result.executions[0].sessionId
          await Promise.all([loadExecutionDetail(selectedExecutionId), loadSessionDetail(selectedSessionId)])
        }
        if (selectedExecutionId) {
          const selectedExecution = (result.executions || []).find((item) => item.executionId === selectedExecutionId)
          if (selectedExecution) {
            selectedSessionId = selectedExecution.sessionId
            await loadExecutionDetail(selectedExecutionId)
          }
        }
      }

      async function loadSessions() {
        const result = await getJson('/api/sessions')
        const executionResult = await getJson('/api/executions')
        renderSessionList(result, executionResult.executions || [])
        updateHealthStrip(executionResult.executions || [], result.sessions || [])
        if (!selectedSessionId && result.sessions?.length) {
          selectedSessionId = result.sessions[0].id
          const selectedExecution = (executionResult.executions || []).find((item) => item.sessionId === selectedSessionId)
          if (selectedExecution) selectedExecutionId = selectedExecution.executionId
          if (selectedExecutionId) {
            renderExecutionList(executionResult)
            await Promise.all([loadExecutionDetail(selectedExecutionId), loadSessionDetail(selectedSessionId)])
            return
          }
          await loadSessionDetail(selectedSessionId)
        }
        if (selectedSessionId) {
          const selectedSession = (result.sessions || []).find((item) => item.id === selectedSessionId)
          if (selectedSession) {
            const selectedExecution = (executionResult.executions || []).find((item) => item.sessionId === selectedSessionId)
            if (selectedExecution) {
              selectedExecutionId = selectedExecution.executionId
              renderExecutionList(executionResult)
              await Promise.all([loadExecutionDetail(selectedExecutionId), loadSessionDetail(selectedSessionId)])
              return
            }
            await loadSessionDetail(selectedSessionId)
          }
        }
      }

      projectFilter.addEventListener('change', async () => {
        projectFilterValue = projectFilter.value
        await loadExecutions()
        await loadSessions()
      })

      if (setupTab) setupTab.onclick = () => switchPanel('setup')
      if (runsTab) runsTab.onclick = () => switchPanel('runs')
      if (reviewTab) reviewTab.onclick = () => switchPanel('review')
      overviewNav.onclick = () => switchPanel('setup')
      runsNav.onclick = () => switchPanel('runs')
      adaptersNav.onclick = () => switchPanel('review')
      insightsNav.onclick = () => switchPanel('runs')
      settingsNav.onclick = () => switchPanel('setup')

      async function loadExecutionDetail(executionId) {
        const result = await getJson('/api/executions/' + encodeURIComponent(executionId))
        renderExecutionDetail(result)
      }

      async function loadSessionDetail(sessionId) {
        const result = await getJson('/api/sessions/' + encodeURIComponent(sessionId))
        renderSessionDetail(result)
      }

      adapterSelect.addEventListener('change', async () => {
        await loadScenarios(adapterSelect.value)
        await loadReview()
      })

      scenarioSelect.addEventListener('change', () => {
        const selectedScenarioOption = scenarioSelect.options[scenarioSelect.selectedIndex]
        if (selectedScenarioOption?.dataset.gateStatus === 'restricted') {
          status.textContent = 'Selected scenario is restricted by quality gate: ' + selectedScenarioOption.dataset.gateReason
        }
        updateActionState()
      })

      async function loadReview() {
        status.textContent = 'Reviewing ...'
        const result = await postJson('/api/review', requestPayload())
        renderReview(result)
        status.textContent = 'Review loaded.'
      }

      async function loadGeneratedFiles() {
        const adapter = currentAdapter()
        if (!adapter || adapter.status !== 'draft') return
        const result = await getJson('/api/adapters/' + encodeURIComponent(adapter.id) + '/generated-files')
        generatedFileSelect.innerHTML = ''
        for (const file of result.files || []) {
          const option = document.createElement('option')
          option.value = file
          option.textContent = file
          generatedFileSelect.appendChild(option)
        }
        if (generatedFileSelect.value) {
          await loadGeneratedFile()
        }
      }

      async function loadGeneratedFile() {
        const adapter = currentAdapter()
        if (!adapter || adapter.status !== 'draft' || !generatedFileSelect.value) return
        const result = await getJson(
          '/api/adapters/' + encodeURIComponent(adapter.id) + '/generated-files/' + encodeURIComponent(generatedFileSelect.value),
        )
        generatedFileEditor.value = result.content
      }

      initializeBtn.onclick = async () => {
        try {
          status.textContent = 'Starting run ...'
          const result = await postJson('/api/executions', {
            adapterId: adapterSelect.value,
            scenarioId: scenarioSelect.value,
            repoPath: repoPath.value,
            runtimeFlags: {
              simulateRetryStep: simulateRetryStep.value || undefined,
            },
          })
          setExecution(result)
          await loadExecutions()
          await loadSessions()
          selectedExecutionId = result.execution.executionId
          selectedSessionId = result.execution.sessionId
          await Promise.all([loadExecutionDetail(selectedExecutionId), loadSessionDetail(selectedSessionId)])
          switchPanel('runs')
          focusAgenticRun()
          status.textContent = 'Run started.'
        } catch (error) {
          status.textContent = 'Execution blocked: ' + error.message
        }
      }

      installBtn.onclick = async () => {
        if (installBtn.disabled) return
        status.textContent = 'Installing .agentic-qa ...'
        const result = await postJson('/api/install-local', { repoPath: repoPath.value })
        installedLocalPackagePath = result.installedPath
        setExecution(result)
        updateActionState()
        status.textContent = '.agentic-qa installed.'
      }

      discoverBtn.onclick = async () => {
        if (discoverBtn.disabled) return
        status.textContent = 'Discovering host and generating local adapter draft ...'
        const result = await postJson('/api/discover-local', requestPayload())
        installedLocalPackagePath = result.localPackagePath
        renderReview({ report: result.report, draft: result.draft })
        setExecution({
          localPackagePath: result.localPackagePath,
          adapterRoot: result.adapterRoot,
          files: result.files,
        })
        status.textContent = 'Discovery draft written into .agentic-qa/adapter.'
      }

      reviewBtn.onclick = loadReview

      markReviewedBtn.onclick = async () => {
        const adapter = currentAdapter()
        if (!adapter || adapter.status === 'certified') return
        status.textContent = 'Marking adapter as reviewed ...'
        const result = await postJson('/api/adapters/' + encodeURIComponent(adapter.id) + '/promotion', {
          targetState: 'reviewed',
        })
        setExecution(result)
        await loadAdapters()
        status.textContent = 'Adapter marked as reviewed.'
      }

      promoteCertifiedBtn.onclick = async () => {
        const adapter = currentAdapter()
        if (!adapter || adapter.status === 'certified') return
        try {
          status.textContent = 'Promoting adapter to certified ...'
          const result = await postJson('/api/adapters/' + encodeURIComponent(adapter.id) + '/promotion', {
            targetState: 'certified',
          })
          setExecution(result)
          await loadAdapters()
          status.textContent = 'Adapter promoted to certified.'
        } catch (error) {
          status.textContent = 'Promotion blocked: ' + error.message
        }
      }

      generatedFileBtn.onclick = loadGeneratedFile
      saveGeneratedFileBtn.onclick = async () => {
        const adapter = currentAdapter()
        if (!adapter || adapter.status !== 'draft' || !generatedFileSelect.value) return
        status.textContent = 'Saving generated file ...'
        await postJson(
          '/api/adapters/' + encodeURIComponent(adapter.id) + '/generated-files/' + encodeURIComponent(generatedFileSelect.value),
          { content: generatedFileEditor.value },
        )
        status.textContent = 'Generated file saved.'
      }

      Promise.all([loadAdapters(), loadExecutions(), loadSessions()]).catch((error) => {
        status.textContent = 'Failed to load dashboard state: ' + error.message
      })

      setInterval(() => {
        loadExecutions().catch(() => {})
        loadSessions().catch(() => {})
      }, 3000)
    </script>
  </body>
</html>`
}

export async function createPlatformWebServer(options: {
  apiPort?: number
  webPort?: number
  defaultRepo?: string
  token?: string
} = {}) {
  const apiPort = options.apiPort ?? API_PORT
  const webPort = options.webPort ?? WEB_PORT
  const token = options.token ?? await ensureControlPlaneToken()
  const html = buildDashboardHtml({
    apiPort,
    webPort,
    defaultRepo: options.defaultRepo ?? DEFAULT_REPO,
    token,
  })
  const server = createServer((request, response) => {
    // The page embeds the control-plane token: never serve anything under a non-loopback Host, or a
    // DNS-rebinding page could read the token under its own domain (S-15).
    if (!isLoopbackHost(request.headers.host)) {
      response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'host_not_allowed' }))
      return
    }

    if ((request.method ?? 'GET') === 'GET' && (request.url ?? '/') === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
      return
    }

    if ((request.method ?? 'GET') === 'GET' && (request.url ?? '/') === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true, service: 'agentic-platform-dashboard-web', port: webPort, apiPort }, null, 2))
      return
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: 'not_found' }, null, 2))
  })
  return { server, html, token, apiPort, webPort }
}

/** Creates the dashboard and binds it the way production does. Exported so the bind can be tested (T-02). */
export async function startPlatformWeb(options: Parameters<typeof createPlatformWebServer>[0] = {}) {
  const created = await createPlatformWebServer(options)
  await new Promise<void>((resolve, reject) => {
    created.server.once('error', reject)
    created.server.listen(created.webPort, CONTROL_PLANE_HOST, () => {
      created.server.off('error', reject)
      resolve()
    })
  })
  console.log(`agentic-platform dashboard-web listening on http://${CONTROL_PLANE_HOST}:${created.webPort}`)
  return created
}

if (path.basename(process.argv[1] ?? '') === 'server.ts') {
  void startPlatformWeb()
}
