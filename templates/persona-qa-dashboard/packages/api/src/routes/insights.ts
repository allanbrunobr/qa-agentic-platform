import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '../db/index.js';
import type { Finding, Scenario } from '../db/schema.js';

interface Insight {
  id: string;
  specialist: 'frontend' | 'test' | 'backend';
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  category: string;
  recommendation: string;
}

const FRONTEND_KEYWORDS = ['ui', 'screenshot', 'form', 'button', 'modal', 'layout', 'css', 'style', 'render', 'display'];
const BACKEND_KEYWORDS = ['api', 'schema', 'endpoint', 'validation', 'request', 'response', 'status', 'server', 'database'];

function matchesKeywords(title: string, keywords: readonly string[]): boolean {
  const lower = title.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function buildFrontendInsights(findings: Finding[]): Insight[] {
  const uiFindings = findings.filter((f) =>
    matchesKeywords(f.title, FRONTEND_KEYWORDS)
  );

  const insights: Insight[] = [];

  if (uiFindings.length === 0) {
    insights.push({
      id: 'fe-no-issues',
      specialist: 'frontend',
      title: 'No UI issues detected',
      description: 'No findings related to UI components were found in recent test runs.',
      severity: 'info',
      category: 'UI Quality',
      recommendation: 'Continue monitoring UI interactions across all personas.',
    });
    return insights;
  }

  // Group by severity
  const critical = uiFindings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  const minor = uiFindings.filter((f) => f.severity === 'medium' || f.severity === 'low');

  if (critical.length > 0) {
    insights.push({
      id: 'fe-critical-ui',
      specialist: 'frontend',
      title: `${critical.length} critical/high UI issue${critical.length > 1 ? 's' : ''} detected`,
      description: `Found ${critical.length} severe UI-related finding${critical.length > 1 ? 's' : ''}: ${critical.slice(0, 3).map((f) => f.title).join(', ')}`,
      severity: 'critical',
      category: 'UI Quality',
      recommendation: 'Prioritize fixing broken UI components and form validations. Check screenshot evidence for each finding.',
    });
  }

  if (minor.length > 0) {
    insights.push({
      id: 'fe-minor-ui',
      specialist: 'frontend',
      title: `${minor.length} minor UI improvement${minor.length > 1 ? 's' : ''} suggested`,
      description: `Found ${minor.length} low/medium UI finding${minor.length > 1 ? 's' : ''} that could improve user experience.`,
      severity: 'warning',
      category: 'UI Polish',
      recommendation: 'Schedule UI polish work to address layout issues, missing visual feedback, and form UX improvements.',
    });
  }

  return insights;
}

function buildTestInsights(
  findings: Finding[],
  scenarios: Scenario[]
): Insight[] {
  const insights: Insight[] = [];

  // Check for scenarios without recent runs
  const staleScenarios = scenarios.filter((s) => {
    if (!s.last_run_at) return true;
    const lastRun = new Date(s.last_run_at).getTime();
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return lastRun < oneDayAgo;
  });

  if (staleScenarios.length > 0) {
    insights.push({
      id: 'test-stale-scenarios',
      specialist: 'test',
      title: `${staleScenarios.length} scenario${staleScenarios.length > 1 ? 's' : ''} without recent runs`,
      description: `The following scenarios have not been run in over 24 hours: ${staleScenarios.slice(0, 3).map((s) => s.name).join(', ')}${staleScenarios.length > 3 ? ` and ${staleScenarios.length - 3} more` : ''}.`,
      severity: 'warning',
      category: 'Test Coverage',
      recommendation: 'Run all scenarios regularly to maintain test coverage confidence. Consider scheduling automated runs.',
    });
  }

  // High failure rate detection
  const failedScenarios = scenarios.filter((s) => s.last_status === 'failed');
  if (failedScenarios.length > 0) {
    const failRate = Math.round(
      (failedScenarios.length / Math.max(scenarios.length, 1)) * 100
    );
    insights.push({
      id: 'test-high-failure',
      specialist: 'test',
      title: `${failRate}% scenario failure rate`,
      description: `${failedScenarios.length} out of ${scenarios.length} scenarios failed in their last run.`,
      severity: failRate > 50 ? 'critical' : 'warning',
      category: 'Test Stability',
      recommendation: 'Investigate failing scenarios. Check if failures are due to flaky tests, environment issues, or genuine regressions.',
    });
  }

  // Finding density
  if (findings.length > 20) {
    insights.push({
      id: 'test-finding-density',
      specialist: 'test',
      title: 'High finding density detected',
      description: `There are ${findings.length} total findings across all runs. Consider triaging and resolving older findings.`,
      severity: 'warning',
      category: 'Finding Management',
      recommendation: 'Review and close resolved findings. Prioritize critical and high severity items for immediate action.',
    });
  }

  if (insights.length === 0) {
    insights.push({
      id: 'test-healthy',
      specialist: 'test',
      title: 'Test suite is healthy',
      description: 'All scenarios are up to date and failure rates are within acceptable thresholds.',
      severity: 'info',
      category: 'Test Health',
      recommendation: 'Maintain current testing cadence and continue adding new scenarios for new features.',
    });
  }

  return insights;
}

function buildBackendInsights(findings: Finding[]): Insight[] {
  const apiFindings = findings.filter((f) =>
    matchesKeywords(f.title, BACKEND_KEYWORDS)
  );

  const insights: Insight[] = [];

  if (apiFindings.length === 0) {
    insights.push({
      id: 'be-no-issues',
      specialist: 'backend',
      title: 'No API issues detected',
      description: 'No findings related to backend/API issues were found in recent test runs.',
      severity: 'info',
      category: 'API Quality',
      recommendation: 'Continue monitoring API responses and validation behavior across all personas.',
    });
    return insights;
  }

  const critical = apiFindings.filter((f) => f.severity === 'critical' || f.severity === 'high');

  if (critical.length > 0) {
    insights.push({
      id: 'be-critical-api',
      specialist: 'backend',
      title: `${critical.length} critical API issue${critical.length > 1 ? 's' : ''} found`,
      description: `Detected ${critical.length} severe API-related finding${critical.length > 1 ? 's' : ''}: ${critical.slice(0, 3).map((f) => f.title).join(', ')}`,
      severity: 'critical',
      category: 'API Reliability',
      recommendation: 'Investigate API endpoint failures, schema mismatches, and validation errors. Check server logs for additional context.',
    });
  }

  const validationFindings = apiFindings.filter(
    (f) =>
      f.title.toLowerCase().includes('validation') ||
      f.title.toLowerCase().includes('schema')
  );

  if (validationFindings.length > 0) {
    insights.push({
      id: 'be-validation',
      specialist: 'backend',
      title: `${validationFindings.length} validation/schema issue${validationFindings.length > 1 ? 's' : ''}`,
      description: 'API validation or schema mismatches detected. These may cause data integrity issues.',
      severity: 'warning',
      category: 'Data Validation',
      recommendation: 'Review API request/response schemas. Ensure frontend and backend validation rules are synchronized.',
    });
  }

  return insights;
}

export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/insights - returns AI-generated insights from 3 specialist perspectives
  app.get('/api/insights', async (_request, reply) => {
    const db = getDb();

    // Fetch all findings and scenarios for analysis
    const allFindings = await db.select().from(schema.findings);
    const allScenarios = await db.select().from(schema.scenarios);

    const insights: Insight[] = [
      ...buildFrontendInsights(allFindings),
      ...buildTestInsights(allFindings, allScenarios),
      ...buildBackendInsights(allFindings),
    ];

    return reply.send(insights);
  });
}
