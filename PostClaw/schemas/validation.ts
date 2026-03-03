import { z } from "zod";

export const MemoryOptionsSchema = z.object({
    category: z.string().max(50).optional().nullable(),
    source_uri: z.string().url().max(512).optional().nullable(),
    volatility: z.enum(["low", "medium", "high"]).optional().nullable(),
    is_pointer: z.boolean().optional().nullable(),
    token_count: z.number().int().optional().nullable(),
    tier: z.enum(["volatile", "session", "daily", "stable", "permanent"]).optional().nullable(),
    confidence: z.number().min(0).max(1).optional().nullable(),
    usefulness_score: z.number().optional().nullable(),
    expires_at: z.date().optional().nullable(),
    metadata: z.record(z.string(), z.any()).optional().nullable(),
});

export type MemoryOptions = z.infer<typeof MemoryOptionsSchema>;

export const StoreMemoryInputSchema = z.object({
    content: z.string().min(1),
    scope: z.enum(["private", "shared", "global"]).default("private"),
    options: MemoryOptionsSchema.optional(),
});

export const UpdateMemoryInputSchema = z.object({
    oldMemoryId: z.string().uuid(),
    newFact: z.string().min(1),
    options: MemoryOptionsSchema.optional(),
});
