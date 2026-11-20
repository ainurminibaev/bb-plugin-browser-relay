import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const statusSchema = z.object({
  platform: z.string(),
  supported: z.boolean(),
  /** Service answered an MCP initialize on 127.0.0.1 (does not touch Chrome). */
  serviceUp: z.boolean(),
  serviceError: z.string().nullable(),
  installed: z.boolean(),
  running: z.boolean(),
  legacyLabels: z.array(z.string()),
  codexPointsHere: z.boolean(),
  serverVersion: z.string().nullable(),
});
export type RelayStatus = z.infer<typeof statusSchema>;

export const callResultSchema = z.object({
  ok: z.boolean(),
  text: z.string(),
  /** Images saved on the target machine (absolute paths there). */
  images: z.array(z.string()),
});

export const toolInfoSchema = z.object({ name: z.string(), description: z.string() });

export const setupResultSchema = z.object({ ok: z.boolean(), log: z.string() });

/** RPC from the BB server to this plugin's host worker on the target machine. */
export const hostContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema, experimental_retryable: true },
  tools: { input: z.null(), output: z.array(toolInfoSchema), experimental_retryable: true },
  call: {
    input: z.object({ tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), args: z.record(z.string(), z.unknown()), maxChars: z.number().int().min(1000).max(2_000_000) }),
    output: callResultSchema,
  },
  service: {
    input: z.object({ action: z.enum(['install', 'remove']) }),
    output: setupResultSchema,
  },
});
