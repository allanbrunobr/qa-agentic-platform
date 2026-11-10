import { z } from 'zod';

export const SensorStatusSchema = z.enum(['pass', 'fail']);
export type SensorStatus = z.infer<typeof SensorStatusSchema>;

export const SensorResultSchema = z.object({
  sensor: z.string(),
  status: SensorStatusSchema,
  details: z.record(z.string(), z.unknown()),
});
export type SensorResult = z.infer<typeof SensorResultSchema>;
