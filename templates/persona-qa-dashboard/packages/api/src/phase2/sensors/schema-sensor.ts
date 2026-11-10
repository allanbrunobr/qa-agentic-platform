import { z } from 'zod';
import type { SensorFn } from '../services/sensor-runner.js';

const objectOutputSchema = z.record(z.string(), z.unknown());

export const schemaSensor: SensorFn = async (context) => {
  const { stepOutput, step } = context;
  const errors: string[] = [];

  try {
    objectOutputSchema.parse(stepOutput.output);
  } catch (error) {
    errors.push(`Step output failed schema validation — ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const toolCall of stepOutput.toolCalls) {
    if (toolCall.result === undefined) continue;

    try {
      objectOutputSchema.parse(toolCall.result);
    } catch (error) {
      errors.push(
        `Tool "${toolCall.tool}": output failed schema validation — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    sensor: 'schema',
    status: errors.length === 0 ? 'pass' : 'fail',
    details: {
      toolCallsChecked: stepOutput.toolCalls.length,
      errors,
    },
  };
};
