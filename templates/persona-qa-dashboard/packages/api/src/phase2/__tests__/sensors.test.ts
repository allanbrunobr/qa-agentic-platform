import { describe, it, expect } from 'vitest';
import { SensorRunner, type SensorContext } from '../services/sensor-runner.js';
import { schemaSensor } from '../sensors/schema-sensor.js';
import { outputSensor } from '../sensors/output-sensor.js';
import type { ScenarioContract, ScenarioStep } from '../types/scenario-types.js';
import type { AgentStepOutput } from '../types/agent-types.js';
import type { Session } from '../types/session-types.js';

function makeContext(overrides?: Partial<SensorContext>): SensorContext {
  const step: ScenarioStep = {
    id: 'step_1',
    name: 'Create Customer',
    agentId: 'sales_associate',
    order: 0,
    requiredArtifacts: [],
    producedArtifacts: ['customerId'],
  };

  const stepOutput: AgentStepOutput = {
    stepIndex: 0,
    agentId: 'sales_associate',
    output: { customerId: '123' },
    toolCalls: [],
    findings: [],
    durationMs: 100,
    success: true,
  };

  const session: Session = {
    id: 'session_1',
    scenarioId: 'test',
    status: 'running',
    startedAt: new Date().toISOString(),
    events: [],
    artifacts: {},
    findings: [],
    checkpoint: { lastCompletedStep: -1, cursor: 0 },
  };

  const scenario: ScenarioContract = {
    id: 'test',
    name: 'Test',
    steps: [step],
    roles: [],
    requiredArtifacts: ['customerId'],
    allowedTools: [],
  };

  return {
    sessionId: 'session_1',
    step,
    agentId: 'sales_associate',
    stepOutput,
    session,
    scenario,
    ...overrides,
  };
}

describe('SchemaSensor', () => {
  it('should pass when tool results are valid objects', async () => {
    const context = makeContext({
      stepOutput: {
        stepIndex: 0,
        agentId: 'sales_associate',
        output: { customerId: '123' },
        toolCalls: [
          { tool: 'registerCustomer', args: { name: 'Alex' }, result: { id: '123', name: 'Alex' } },
        ],
        findings: [],
        durationMs: 100,
        success: true,
      },
    });

    const result = await schemaSensor(context);
    expect(result.sensor).toBe('schema');
    expect(result.status).toBe('pass');
    expect(result.details['toolCallsChecked']).toBe(1);
  });

  it('should pass when no tool calls exist', async () => {
    const context = makeContext();
    const result = await schemaSensor(context);
    expect(result.status).toBe('pass');
    expect(result.details['toolCallsChecked']).toBe(0);
  });

  it('should pass when tool call has no result', async () => {
    const context = makeContext({
      stepOutput: {
        stepIndex: 0,
        agentId: 'sales_associate',
        output: {},
        toolCalls: [{ tool: 'noop', args: {} }],
        findings: [],
        durationMs: 50,
        success: true,
      },
    });

    const result = await schemaSensor(context);
    expect(result.status).toBe('pass');
  });
});

describe('OutputSensor', () => {
  it('should pass when output contains all produced artifacts', async () => {
    const context = makeContext();
    const result = await outputSensor(context);

    expect(result.sensor).toBe('output');
    expect(result.status).toBe('pass');
  });

  it('should fail when success=true but missing produced artifact', async () => {
    const context = makeContext({
      stepOutput: {
        stepIndex: 0,
        agentId: 'sales_associate',
        output: {}, // missing customerId
        toolCalls: [],
        findings: [],
        durationMs: 100,
        success: true,
      },
    });

    const result = await outputSensor(context);
    expect(result.status).toBe('fail');
    const errors = result.details['errors'] as string[];
    expect(errors.some((e: string) => e.includes('customerId'))).toBe(true);
  });

  it('should pass when retry output is satisfied by a persisted session artifact', async () => {
    const context = makeContext({
      stepOutput: {
        stepIndex: 0,
        agentId: 'sales_associate',
        output: { artifactId: 'artifact_1', type: 'customerId' },
        toolCalls: [],
        findings: [],
        durationMs: 100,
        success: true,
      },
      session: {
        id: 'session_1',
        scenarioId: 'test',
        status: 'running',
        startedAt: new Date().toISOString(),
        events: [],
        artifacts: { customerId: '123' },
        findings: [],
        checkpoint: { lastCompletedStep: -1, cursor: 0 },
      },
    });

    const result = await outputSensor(context);

    expect(result.status).toBe('pass');
    expect(result.details['satisfiedBySessionArtifacts']).toEqual(['customerId']);
  });

  it('should pass when persisted artifact is stored under a generated artifact key', async () => {
    const context = makeContext({
      stepOutput: {
        stepIndex: 0,
        agentId: 'sales_associate',
        output: {},
        toolCalls: [],
        findings: [],
        durationMs: 100,
        success: true,
      },
      session: {
        id: 'session_1',
        scenarioId: 'test',
        status: 'running',
        startedAt: new Date().toISOString(),
        events: [],
        artifacts: {
          artifact_uuid: {
            content: JSON.stringify({ customerId: '123' }),
            metadata: { artifactType: 'customerId' },
            description: 'Domain artifact: customerId',
          },
        },
        findings: [],
        checkpoint: { lastCompletedStep: -1, cursor: 0 },
      },
    });

    const result = await outputSensor(context);

    expect(result.status).toBe('pass');
    expect(result.details['satisfiedBySessionArtifacts']).toEqual(['customerId']);
  });

  it('should fail when failure has no error message', async () => {
    const context = makeContext({
      stepOutput: {
        stepIndex: 0,
        agentId: 'sales_associate',
        output: {},
        toolCalls: [],
        findings: [],
        durationMs: 50,
        success: false,
        // no error field
      },
    });

    const result = await outputSensor(context);
    expect(result.status).toBe('fail');
    const errors = result.details['errors'] as string[];
    expect(errors.some((e: string) => e.includes('error message'))).toBe(true);
  });

  it('should pass when failure has error message and no artifact expectations', async () => {
    const context = makeContext({
      step: {
        id: 'step_1',
        name: 'Test',
        agentId: 'sales_associate',
        order: 0,
        requiredArtifacts: [],
        producedArtifacts: [],
      },
      stepOutput: {
        stepIndex: 0,
        agentId: 'sales_associate',
        output: {},
        toolCalls: [],
        findings: [],
        durationMs: 50,
        success: false,
        error: 'Something went wrong',
      },
    });

    const result = await outputSensor(context);
    expect(result.status).toBe('pass');
  });
});

describe('SensorRunner', () => {
  it('should register and run multiple sensors', async () => {
    const runner = new SensorRunner();
    runner.registerSensor('schema', schemaSensor);
    runner.registerSensor('output', outputSensor);

    const context = makeContext();
    const results = await runner.runAll(context);

    expect(results).toHaveLength(2);
    expect(results.map(r => r.sensor)).toContain('schema');
    expect(results.map(r => r.sensor)).toContain('output');
  });

  it('should handle sensor errors gracefully', async () => {
    const runner = new SensorRunner();
    runner.registerSensor('broken', async () => {
      throw new Error('Sensor crashed');
    });

    const context = makeContext();
    const results = await runner.runAll(context);

    expect(results).toHaveLength(1);
    expect(results[0]!.sensor).toBe('broken');
    expect(results[0]!.status).toBe('fail');
    expect(results[0]!.details['error']).toBe('Sensor crashed');
  });
});
