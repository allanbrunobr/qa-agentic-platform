import type { SensorFn } from '../services/sensor-runner.js';
import { STEP_SUPPORT_TOOLS } from '../services/step-support-tools.js';

const TOOL_CATEGORY_MAP: Record<string, string> = {
  navigate: 'browser',
  click: 'browser',
  type: 'browser',
  screenshot: 'browser',
  wait: 'browser',
  evaluate: 'browser',
  fetch: 'api',
  httpRequest: 'api',
  apiCall: 'api',
  query: 'database',
  insert: 'database',
  update: 'database',
  delete: 'database',
  readFile: 'file',
  writeFile: 'file',
  listDir: 'file',
};

export const toolPolicySensor: SensorFn = async (context) => {
  const { stepOutput, agentId, scenario } = context;
  const violations: string[] = [];

  if (stepOutput.agentId !== agentId) {
    violations.push(`Step output agentId "${stepOutput.agentId}" does not match delegated agent "${agentId}"`);
  }

  if (scenario.allowedTools.length > 0) {
    for (const toolCall of stepOutput.toolCalls) {
      const toolName = toolCall.tool ?? toolCall.name;
      if (!toolName) {
        violations.push('Tool call is missing a tool/name identifier');
        continue;
      }
      // The step's support tools (evidence, findings) are offered with every step capability (B-04).
      if (!scenario.allowedTools.includes(toolName) && !STEP_SUPPORT_TOOLS.has(toolName)) {
        violations.push(`Tool "${toolName}" is not allowed by scenario policy`);
      }
    }
  }

  return {
    sensor: 'tool_policy',
    status: violations.length === 0 ? 'pass' : 'fail',
    details: {
      agentId,
      toolCallsChecked: stepOutput.toolCalls.length,
      violations,
    },
  };
};

export function checkToolPolicy(
  toolCalls: Array<{ tool: string }>,
  policy: Record<string, boolean>,
): string[] {
  const violations: string[] = [];

  for (const toolCall of toolCalls) {
    const category = TOOL_CATEGORY_MAP[toolCall.tool];
    if (category && policy[category] === false) {
      violations.push(`Tool "${toolCall.tool}" (category: ${category}) violates policy — ${category} is disabled`);
    }
  }

  return violations;
}
