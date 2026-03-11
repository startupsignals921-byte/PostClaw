/**
 * PostClaw Sleep Cycle — Knowledge Graph Maintenance Agent
 *
 * Runs 4 maintenance phases on the memory database:
 *   1. Episodic Consolidation — extract durable facts from short-term memory
 *   2. Duplicate Detection — find and merge near-duplicate semantic memories
 *   3. Low-Value Cleanup — archive stale, unaccessed memories
 *   4. Link Discovery — auto-discover and create knowledge graph edges
 *
 * Usage (via OpenClaw CLI):
 *   openclaw postclaw sleep [--agent-id <id>]
 *
 * Also runs as a background service on a configurable interval when the
 * gateway is running (default: every 6 hours).
 */

import { getSql, getEmbedding, LM_STUDIO_URL, validateEmbeddingDimension } from "../services/db.js";
import { ensureAgent } from "../services/memoryService.js";
import { loadConfig } from "../services/config.js";
import { callLLMviaAgent } from "../services/llm.js";
import { z } from "zod";
import {
  SleepCycleResultSchema,
  LinkClassificationSchema,
  type SleepCycleResult,
  type LinkClassification,
  type EpisodicRow,
  type MemorySemanticRow,
  type DuplicateCandidateRow,
  type StaleMemoryRow,
} from "../schemas/validation.js";

// =============================================================================
// CONFIGURATION — All thresholds are easily tunable here
// =============================================================================

// Phase 1: Episodic consolidation
const DEFAULT_EPISODIC_BATCH_LIMIT = 100;

// Phase 2: Duplicate detection
const DEFAULT_DUPLICATE_SIMILARITY_THRESHOLD = 0.80;
const DEFAULT_DUPLICATE_SCAN_LIMIT = 200;

// Phase 3: Low-value cleanup
const DEFAULT_LOW_VALUE_AGE_DAYS = 7;
const DEFAULT_LOW_VALUE_PROTECTED_TIERS = ['permanent', 'stable'];

// Phase 4: Link discovery
const DEFAULT_LINK_SIMILARITY_MIN = 0.65;
const DEFAULT_LINK_SIMILARITY_MAX = 0.92;
const DEFAULT_LINK_CANDIDATES_PER_MEMORY = 5;
const DEFAULT_LINK_BATCH_SIZE = 20;
const DEFAULT_LINK_SCAN_LIMIT = 50;

// Background service
const DEFAULT_INTERVAL_HOURS = 6;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Defensively extracts a JSON object from raw LLM output.
 * Handles markdown fences (```json ... ```) or conversational filler 
 * wrapping the actual { ... } block.
 */
function extractJsonFromLlmOutput(text: string): string {
  if (!text) return "";

  // 1. Try to find a fenced code block
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }

  // 2. Try to find the outermost curly braces
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.substring(firstBrace, lastBrace + 1).trim();
  }

  // 3. Fallback to just returning the trimmed string and letting JSON.parse try
  return text.trim();
}

// SleepCycleResult and LinkClassification types are now imported from schemas

export interface SleepCycleOptions {
  agentId?: string;
  config?: {
    episodicBatchLimit?: number;
    duplicateSimilarityThreshold?: number;
    duplicateScanLimit?: number;
    lowValueAgeDays?: number;
    lowValueProtectedTiers?: string[];
    linkSimilarityMin?: number;
    linkSimilarityMax?: number;
    linkCandidatesPerMemory?: number;
    linkBatchSize?: number;
    linkScanLimit?: number;
  };
}

export interface SleepCycleStats {
  factsExtracted: number;
  duplicatesMerged: number;
  staleArchived: number;
  expiredArchived: number;
  linksCreated: number;
}

// =============================================================================
// UTILITIES
// =============================================================================

// LLM calls now routed through OpenClaw's configured primary model via callLLMviaAgent

// =============================================================================
// PHASE 1: EPISODIC CONSOLIDATION
// =============================================================================

async function phaseConsolidateEpisodic(agentId: string, limit: number): Promise<number> {
  console.log(`\n[PHASE 1] Episodic Memory Consolidation`);
  console.log(`─────────────────────────────────────────`);

  const sql = getSql();

  const episodes = await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
    return await tx`
      SELECT id, event_type, event_summary, created_at
      FROM memory_episodic
      WHERE agent_id = ${agentId} AND is_archived = false
      ORDER BY created_at ASC
      LIMIT ${limit};
    `;
  });

  if (episodes.length === 0) {
    console.log(`[PHASE 1] No new episodic memories to process.`);
    return 0;
  }

  console.log(`[PHASE 1] Found ${episodes.length} episodic events to consolidate.`);

  const systemPrompt = `
You are the subconscious memory consolidation engine for an AI assistant.
Your job is to review the following chronological transcript of the agent's recent short-term memory (user prompts and tool executions).

Extract ONLY durable, long-term facts that the agent should remember forever.
- Ignore casual banter, specific temporary weather lookups, or transient errors.
- DO extract user preferences, API keys, infrastructure details, or new project rules.

Output your response EXCLUSIVELY as a JSON object matching this schema:
{
  "session_summary": "A brief 2-sentence summary of what happened during this timeframe.",
  "extracted_durable_facts": ["fact 1", "fact 2"]
}
Do not use markdown formatting.
`;

  async function processChunk(chunk: any[]): Promise<SleepCycleResult> {
    const transcript = chunk
      .map((e: Record<string, unknown>) => {
        const row = e as EpisodicRow;
        return `[${row.created_at}] [${row.event_type.toUpperCase()}]: ${row.event_summary}`;
      })
      .join("\n");

    let jsonString = "";
    try {
      jsonString = await callLLMviaAgent(`${systemPrompt}\n\nHere is the recent episodic transcript to analyze:\n\n${transcript}`, agentId);
    } catch (err: any) {
      if (err.message && err.message.includes('E2BIG') && chunk.length > 1) {
        console.warn(`[PHASE 1] ⚠️ E2BIG error (chunk size: ${chunk.length}). Halving chunk and retrying...`);
        const mid = Math.floor(chunk.length / 2);
        const res1 = await processChunk(chunk.slice(0, mid));
        const res2 = await processChunk(chunk.slice(mid));
        return {
          session_summary: (res1.session_summary || "") + (res2.session_summary ? " " + res2.session_summary : ""),
          extracted_durable_facts: [...res1.extracted_durable_facts, ...res2.extracted_durable_facts]
        };
      }
      throw err;
    }

    try {
      const cleanString = extractJsonFromLlmOutput(jsonString);
      return SleepCycleResultSchema.parse(JSON.parse(cleanString));
    } catch (err: any) {
      console.error(`\n[PHASE 1] ❌ FATAL PARSE ERROR`);
      console.error(`The internal LLM response could not be parsed as valid JSON.`);
      console.error(`This blocks the promotion of short-term memories into semantic facts.\n`);
      console.error(`=== RAW LLM OUTPUT ===`);
      console.error(jsonString);
      console.error(`======================\n`);
      throw new Error(`Episodic consolidation parsing failed: ${err.message}`);
    }
  }

  const result: SleepCycleResult = await processChunk(episodes);

  console.log(`[PHASE 1] Extracted ${result.extracted_durable_facts.length} permanent facts.`);
  console.log(`[PHASE 1] Session Summary: ${result.session_summary}`);

  await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

    for (const fact of result.extracted_durable_facts) {
      const embedding = await getEmbedding(fact);
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(fact));
      const contentHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      await tx`
        INSERT INTO memory_semantic (
          agent_id, access_scope, content, content_hash, embedding, embedding_model, tier
        ) VALUES (
          ${agentId}, 'private', ${fact}, ${contentHash}, ${JSON.stringify(embedding)}, 'nomic-embed-text-v2-moe', 'permanent'
        ) ON CONFLICT (agent_id, content_hash) DO NOTHING;
      `;
      console.log(`[PHASE 1] -> Saved durable fact: "${fact}"`);
    }

    const episodeIds = (episodes as EpisodicRow[]).map((e) => e.id);
    await tx`
      UPDATE memory_episodic
      SET is_archived = true
      WHERE id IN ${sql(episodeIds)}
    `;
  });

  console.log(`[PHASE 1] Archived ${episodes.length} short-term memories. Consolidation complete.`);
  return result.extracted_durable_facts.length;
}

// =============================================================================
// PHASE 2: DUPLICATE DETECTION & MERGE
// =============================================================================

async function phaseDuplicateDetection(agentId: string, options: { threshold: number; scanLimit: number }): Promise<number> {
  console.log(`\n[PHASE 2] Duplicate Detection & Merge`);
  console.log(`─────────────────────────────────────────`);
  console.log(`[PHASE 2] Similarity threshold: ${options.threshold}`);

  const sql = getSql();

  const memories = await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
    return await tx`
      SELECT id, content, embedding, usefulness_score, access_count, created_at
      FROM memory_semantic
      WHERE agent_id = ${agentId} AND is_archived = false
      ORDER BY created_at DESC
      LIMIT ${options.scanLimit};
    `;
  });

  if (memories.length < 2) {
    console.log(`[PHASE 2] Not enough memories to scan for duplicates (${memories.length}).`);
    return 0;
  }

  console.log(`[PHASE 2] Scanning ${memories.length} memories for duplicates...`);

  let mergedCount = 0;
  const archivedIds = new Set<string>();

  await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

    for (let i = 0; i < memories.length; i++) {
      const source = memories[i];
      if (archivedIds.has(source.id)) continue;

      const duplicates = await tx`
        SELECT id, content, usefulness_score, access_count, confidence, volatility, injection_count
        FROM memory_semantic
        WHERE agent_id = ${agentId}
          AND is_archived = false
          AND id != ${source.id}
          AND 1 - (embedding <=> ${source.embedding}) > ${options.threshold}
        ORDER BY usefulness_score DESC, access_count DESC
        LIMIT 10;
      `;

      if (duplicates.length === 0) continue;

      const allCandidates = [source, ...duplicates];
      // Score survivors using ALL relevant DB columns:
      // usefulness_score, access_count, confidence, injection_count, volatility
      allCandidates.sort((a, b) => {
        const rowA = a as DuplicateCandidateRow;
        const rowB = b as DuplicateCandidateRow;
        const volPenA = rowA.volatility === 'high' ? -0.5 : rowA.volatility === 'medium' ? -0.2 : 0;
        const volPenB = rowB.volatility === 'high' ? -0.5 : rowB.volatility === 'medium' ? -0.2 : 0;
        const scoreA = (rowA.usefulness_score || 0) + (rowA.access_count || 0) * 0.1
          + (rowA.confidence || 0.5) * 0.5 + (rowA.injection_count || 0) * 0.05 + volPenA;
        const scoreB = (rowB.usefulness_score || 0) + (rowB.access_count || 0) * 0.1
          + (rowB.confidence || 0.5) * 0.5 + (rowB.injection_count || 0) * 0.05 + volPenB;
        return scoreB - scoreA;
      });

      const survivor = allCandidates[0];
      const losers = allCandidates.slice(1);

      for (const loser of losers) {
        if (archivedIds.has(loser.id)) continue;

        await tx`
          UPDATE memory_semantic
          SET is_archived = true, superseded_by = ${survivor.id}
          WHERE id = ${loser.id} AND agent_id = ${agentId};
        `;
        archivedIds.add(loser.id);
        mergedCount++;
        console.log(`[PHASE 2] -> Merged duplicate: "${loser.content.substring(0, 60)}..." → survivor ${survivor.id.substring(0, 8)}`);
      }
    }
  });

  console.log(`[PHASE 2] Merged ${mergedCount} duplicate memories.`);
  return mergedCount;
}

// =============================================================================
// PHASE 3: LOW-VALUE ENTRY CLEANUP
// =============================================================================

async function phaseLowValueCleanup(agentId: string, options: { ageDays: number; protectedTiers: string[] }): Promise<number> {
  console.log(`\n[PHASE 3] Low-Value Entry Cleanup`);
  console.log(`─────────────────────────────────────────`);
  console.log(`[PHASE 3] Archiving memories with 0 access older than ${options.ageDays} days (protecting: ${options.protectedTiers.join(', ')})`);

  const sql = getSql();

  const result = await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

    // Also archive memories past their expires_at date
    const expiredRows = await tx`
      UPDATE memory_semantic
      SET is_archived = true
      WHERE agent_id = ${agentId}
        AND is_archived = false
        AND expires_at IS NOT NULL
        AND expires_at < NOW()
      RETURNING id, content, tier;
    `;
    if (expiredRows.length > 0) {
      for (const m of expiredRows) {
        console.log(`[PHASE 3] -> Archived expired: "${m.content.substring(0, 60)}..." (tier=${m.tier})`);
      }
      console.log(`[PHASE 3] Archived ${expiredRows.length} expired memories.`);
    }

    // Low-value cleanup: consider access_count, injection_count, and confidence
    const staleMemories = await tx`
      SELECT id, content, tier, access_count, injection_count, confidence, created_at
      FROM memory_semantic
      WHERE agent_id = ${agentId}
        AND is_archived = false
        AND access_count = 0
        AND injection_count = 0
        AND confidence < 0.3
        AND created_at < NOW() - INTERVAL '1 day' * ${options.ageDays}
        AND tier NOT IN ${sql(options.protectedTiers)}
      ORDER BY confidence ASC, created_at ASC;
    `;

    if (staleMemories.length === 0) {
      return 0;
    }

    const staleIds = staleMemories.map((m: { id: string }) => m.id);
    await tx`
      UPDATE memory_semantic
      SET is_archived = true
      WHERE id IN ${sql(staleIds)};
    `;

    for (const m of staleMemories as StaleMemoryRow[]) {
      console.log(`[PHASE 3] -> Archived stale: "${m.content.substring(0, 60)}..." (tier=${m.tier}, age=${Math.round((Date.now() - new Date(m.created_at).getTime()) / 86400000)}d)`);
    }

    return staleMemories.length + expiredRows.length;
  });

  console.log(`[PHASE 3] Archived ${result} total entries (low-value + expired).`);
  return result;
}

// =============================================================================
// PHASE 4: LINK CANDIDATE DISCOVERY & AUTO-LINKING
// =============================================================================

async function phaseLinkDiscovery(agentId: string, options: { min: number; max: number; candidatesPerMemory: number; batchSize: number; scanLimit: number }): Promise<number> {
  console.log(`\n[PHASE 4] Link Candidate Discovery & Auto-Linking`);
  console.log(`─────────────────────────────────────────`);
  console.log(`[PHASE 4] Similarity range: ${options.min}–${options.max}`);

  const sql = getSql();

  // Fetch both memories and persona traits
  const [sourceMemories, personaTraits] = await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
    const memories = await tx`
      SELECT id, content, embedding
      FROM memory_semantic
      WHERE agent_id = ${agentId} AND is_archived = false
      ORDER BY created_at DESC
      LIMIT ${options.scanLimit};
    `;
    const personas = await tx`
      SELECT id, category, content, embedding
      FROM agent_persona
      WHERE agent_id = ${agentId}
    `;
    return [memories, personas];
  });

  if (sourceMemories.length < 2 && personaTraits.length === 0) {
    console.log(`[PHASE 4] Not enough entries for link discovery (${sourceMemories.length} memories, ${personaTraits.length} persona traits).`);
    return 0;
  }

  console.log(`[PHASE 4] Scanning ${sourceMemories.length} memories + ${personaTraits.length} persona traits for link candidates...`);

  interface CandidatePair {
    source_id: string;
    source_content: string;
    source_type: "memory" | "persona";
    target_id: string;
    target_content: string;
    target_type: "memory" | "persona";
    similarity: number;
  }

  const candidatePairs: CandidatePair[] = [];
  const seenPairs = new Set<string>();

  await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

    // 1) Memory ↔ Memory candidates (original behavior)
    for (const source of sourceMemories) {
      const candidates = await tx`
        SELECT m.id, m.content, 1 - (m.embedding <=> ${source.embedding}) AS similarity
        FROM memory_semantic m
        WHERE m.agent_id = ${agentId}
          AND m.is_archived = false
          AND m.id != ${source.id}
          AND 1 - (m.embedding <=> ${source.embedding}) BETWEEN ${options.min} AND ${options.max}
          AND NOT EXISTS (
            SELECT 1 FROM entity_edges e
            WHERE e.agent_id = ${agentId}
              AND (
                (e.source_memory_id = ${source.id} AND e.target_memory_id = m.id)
                OR (e.source_memory_id = m.id AND e.target_memory_id = ${source.id})
              )
          )
        ORDER BY similarity DESC
        LIMIT ${options.candidatesPerMemory};
    `;

      for (const candidate of candidates) {
        const pairKey = [source.id, candidate.id].sort().join(":");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        candidatePairs.push({
          source_id: source.id,
          source_content: source.content,
          source_type: "memory",
          target_id: candidate.id,
          target_content: candidate.content,
          target_type: "memory",
          similarity: candidate.similarity,
        });
      }
    }

    // 2) Persona ↔ Memory cross-link candidates
    for (const persona of personaTraits) {
      if (!persona.embedding) continue; // skip personas without embeddings

      const candidates = await tx`
        SELECT m.id, m.content, 1 - (m.embedding <=> ${persona.embedding}) AS similarity
        FROM memory_semantic m
        WHERE m.agent_id = ${agentId}
          AND m.is_archived = false
          AND 1 - (m.embedding <=> ${persona.embedding}) BETWEEN ${options.min} AND ${options.max}
          AND NOT EXISTS (
            SELECT 1 FROM entity_edges e
            WHERE e.agent_id = ${agentId}
              AND (
                (e.source_persona_id = ${persona.id} AND e.target_memory_id = m.id)
                OR (e.source_memory_id = m.id AND e.target_persona_id = ${persona.id})
              )
          )
        ORDER BY similarity DESC
        LIMIT ${options.candidatesPerMemory};
      `;

      for (const candidate of candidates) {
        const pairKey = [persona.id, candidate.id].sort().join(":");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        candidatePairs.push({
          source_id: persona.id,
          source_content: `[Persona: ${persona.category}] ${persona.content}`,
          source_type: "persona",
          target_id: candidate.id,
          target_content: candidate.content,
          target_type: "memory",
          similarity: candidate.similarity,
        });
      }
    }
  });

  if (candidatePairs.length === 0) {
    console.log(`[PHASE 4] No new link candidates found.`);
    return 0;
  }

  const memMemCount = candidatePairs.filter(p => p.source_type === "memory" && p.target_type === "memory").length;
  const crossCount = candidatePairs.length - memMemCount;
  console.log(`[PHASE 4] Found ${candidatePairs.length} candidate pairs (${memMemCount} memory↔memory, ${crossCount} persona↔memory). Classifying relationships...`);

  let linksCreated = 0;

  const linkSystemPrompt = `
You are a knowledge graph relationship classifier.
Given pairs of memory entries and/or persona traits, classify the relationship between them.

Valid relationship types:
- "related_to" — general topical relation
- "elaborates" — B provides more detail about A
- "contradicts" — B conflicts with or corrects A
- "depends_on" — B depends on knowledge from A
- "part_of" — B is a component/subset of A
- "defines" — A (usually a persona trait) defines the context for B (a memory)
- "supports" — B provides evidence or backing for A
- "none" — no meaningful relationship worth linking

Output EXCLUSIVELY a JSON array of objects:
[{"source_id": "...", "target_id": "...", "relationship": "..."}]

Use "none" for pairs that don't have a meaningful relationship worth persisting.
Do not use markdown formatting.
`;

  async function processBatch(batch: CandidatePair[], batchIndexHuman: number): Promise<LinkClassification[]> {
    const pairsDescription = batch
      .map((p, idx) => `${idx + 1}. [A: ${p.source_type}/${p.source_id}] "${p.source_content}"\n   [B: ${p.target_type}/${p.target_id}] "${p.target_content}" (similarity: ${(p.similarity * 100).toFixed(1)}%)`)
      .join("\n\n");

    let jsonString = "";
    try {
      jsonString = await callLLMviaAgent(`${linkSystemPrompt}\n\nClassify the relationships between these pairs:\n\n${pairsDescription}`, agentId);
    } catch (err: any) {
      if (err.message && err.message.includes('E2BIG') && batch.length > 1) {
        console.warn(`[PHASE 4] ⚠️ E2BIG error (batch size: ${batch.length}). Halving batch and retrying...`);
        const mid = Math.floor(batch.length / 2);
        const res1 = await processBatch(batch.slice(0, mid), batchIndexHuman);
        const res2 = await processBatch(batch.slice(mid), batchIndexHuman);
        return [...res1, ...res2];
      }
      throw err;
    }

    try {
      const cleanString = extractJsonFromLlmOutput(jsonString);
      return z.array(LinkClassificationSchema).parse(JSON.parse(cleanString));
    } catch (err: any) {
      console.error(`\n[PHASE 4] ⚠️ Parsing skipped for batch ${batchIndexHuman} (or a fragment of it).`);
      console.error(`[PHASE 4] LLM response could not be parsed as a valid JSON array of relationships.`);
      console.error(`[PHASE 4] Raw LLM Output:\n${jsonString}\n`);
      return [];
    }
  }

  for (let i = 0; i < candidatePairs.length; i += options.batchSize) {
    const batch = candidatePairs.slice(i, i + options.batchSize);
    const batchIndexHuman = Math.floor(i / options.batchSize) + 1;

    const classifications = await processBatch(batch, batchIndexHuman);

    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

      for (const cls of classifications) {
        if (cls.relationship === "none" || !cls.relationship) continue;

        // Determine which FK columns to populate based on the original pair's types
        const originalPair = batch.find(p => p.source_id === cls.source_id && p.target_id === cls.target_id);
        if (!originalPair) continue;

        try {
          await tx`
            INSERT INTO entity_edges (
              agent_id,
              source_memory_id, target_memory_id,
              source_persona_id, target_persona_id,
              relationship_type, weight
            ) VALUES (
              ${agentId},
              ${originalPair.source_type === "memory" ? cls.source_id : null},
              ${originalPair.target_type === "memory" ? cls.target_id : null},
              ${originalPair.source_type === "persona" ? cls.source_id : null},
              ${originalPair.target_type === "persona" ? cls.target_id : null},
              ${cls.relationship}, ${originalPair.similarity}
            )
            ON CONFLICT DO NOTHING;
          `;
          linksCreated++;
          const linkLabel = `${originalPair.source_type}/${cls.source_id.substring(0, 8)} → ${originalPair.target_type}/${cls.target_id.substring(0, 8)}`;
          console.log(`[PHASE 4] -> Linked: ${linkLabel} as "${cls.relationship}"`);
        } catch (err) {
          console.error(`[PHASE 4] Failed to insert edge: ${err}`);
        }
      }
    });
  }

  console.log(`[PHASE 4] Created ${linksCreated} new knowledge graph edges.`);
  return linksCreated;
}

// =============================================================================
// MAIN: RUN ALL PHASES
// =============================================================================

export async function runSleepCycle(opts: SleepCycleOptions = {}): Promise<SleepCycleStats> {
  const agentId = opts.agentId || "main";

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  SLEEP CYCLE — Knowledge Graph Maintenance Agent    ║`);
  console.log(`║  Agent: ${agentId.padEnd(44)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝`);

  await ensureAgent(agentId);

  const stats: SleepCycleStats = {
    factsExtracted: 0,
    duplicatesMerged: 0,
    staleArchived: 0,
    expiredArchived: 0,
    linksCreated: 0,
  };

  try {
    // Pre-flight check: ensure embedding model matches DB schema
    // If we consolidate with the wrong dimensions, PGVector insertion will crash
    const dimValidation = await validateEmbeddingDimension(agentId);
    if (!dimValidation.matches) {
       throw new Error(`Dimension mismatch: Model '${dimValidation.model}' provides ${dimValidation.actual} dims, DB expects ${dimValidation.expected}. Aborting sleep cycle to prevent semantic insertion failures.`);
    }

    stats.factsExtracted = await phaseConsolidateEpisodic(agentId, opts.config?.episodicBatchLimit ?? DEFAULT_EPISODIC_BATCH_LIMIT);
    stats.duplicatesMerged = await phaseDuplicateDetection(agentId, {
      threshold: opts.config?.duplicateSimilarityThreshold ?? DEFAULT_DUPLICATE_SIMILARITY_THRESHOLD,
      scanLimit: opts.config?.duplicateScanLimit ?? DEFAULT_DUPLICATE_SCAN_LIMIT
    });
    stats.staleArchived = await phaseLowValueCleanup(agentId, {
      ageDays: opts.config?.lowValueAgeDays ?? DEFAULT_LOW_VALUE_AGE_DAYS,
      protectedTiers: opts.config?.lowValueProtectedTiers ?? DEFAULT_LOW_VALUE_PROTECTED_TIERS
    });
    stats.linksCreated = await phaseLinkDiscovery(agentId, {
      min: opts.config?.linkSimilarityMin ?? DEFAULT_LINK_SIMILARITY_MIN,
      max: opts.config?.linkSimilarityMax ?? DEFAULT_LINK_SIMILARITY_MAX,
      candidatesPerMemory: opts.config?.linkCandidatesPerMemory ?? DEFAULT_LINK_CANDIDATES_PER_MEMORY,
      batchSize: opts.config?.linkBatchSize ?? DEFAULT_LINK_BATCH_SIZE,
      scanLimit: opts.config?.linkScanLimit ?? DEFAULT_LINK_SCAN_LIMIT
    });

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  Sleep Cycle Complete 💤`);
    console.log(`  Facts extracted:   ${stats.factsExtracted}`);
    console.log(`  Duplicates merged: ${stats.duplicatesMerged}`);
    console.log(`  Stale/expired:     ${stats.staleArchived} (incl. expired)`);
    console.log(`  Links created:     ${stats.linksCreated}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  } catch (err) {
    console.error("[SLEEP CYCLE] Fatal error during maintenance:", err);
  }

  return stats;
}

// =============================================================================
// BACKGROUND SERVICE — runs on an interval while the gateway is up
// =============================================================================

let _serviceTimer: ReturnType<typeof setInterval> | null = null;

export function startService(opts: SleepCycleOptions & { intervalHours?: number } = {}): void {
  const intervalMs = (opts.intervalHours || DEFAULT_INTERVAL_HOURS) * 60 * 60 * 1000;
  const label = `${opts.intervalHours || DEFAULT_INTERVAL_HOURS}h`;

  console.log(`[SLEEP SERVICE] Started — first cycle in ${label}, then every ${label} for all active agents`);

  // Do NOT run immediately — this blocks plugin install/validation.
  // First cycle fires after the interval elapses.
  _serviceTimer = setInterval(async () => {
    console.log(`[SLEEP SERVICE] Interval tick — fetching active agents`);
    try {
      const sql = getSql();
      const agents = await sql`SELECT id FROM agents`;

      for (const agent of agents) {
        console.log(`[SLEEP SERVICE] Starting cycle for agent="${agent.id}"`);
        // Override opts.agentId for each cycle run so it doesn't default to 'main'
        const agentConfig = await loadConfig(agent.id);
        await runSleepCycle({ ...opts, agentId: agent.id, config: agentConfig.sleep }).catch((err) =>
          console.error(`[SLEEP SERVICE] Cycle failed for agent="${agent.id}":`, err)
        );
      }
    } catch (err) {
      console.error("[SLEEP SERVICE] Failed to fetch agents or run cycle:", err);
    }
  }, intervalMs);
}

export function stopService(): void {
  if (_serviceTimer) {
    clearInterval(_serviceTimer);
    _serviceTimer = null;
    console.log(`[SLEEP SERVICE] Stopped`);
  }
}

// =============================================================================
// STANDALONE CLI ENTRY POINT
// =============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);

  function getArg(name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx === -1) return undefined;
    return args[idx + 1];
  }

  const specificAgentId = getArg("--agent-id") || args.find((a) => !a.startsWith("--"));

  async function runStandalone() {
    try {
      if (specificAgentId) {
        console.log(`[SLEEP SERVICE] Running manual cycle for specific agent="${specificAgentId}"`);
        const agentConfig = await loadConfig(specificAgentId);
        await runSleepCycle({ agentId: specificAgentId, config: agentConfig.sleep });
      } else {
        console.log(`[SLEEP SERVICE] Running manual cycle for all active agents`);
        const sql = getSql();
        const agents = await sql`SELECT id FROM agents`;

        for (const agent of agents) {
          console.log(`[SLEEP SERVICE] Starting cycle for agent="${agent.id}"`);
          const agentConfig = await loadConfig(agent.id);
          await runSleepCycle({ agentId: agent.id, config: agentConfig.sleep }).catch((err) =>
            console.error(`[SLEEP SERVICE] Cycle failed for agent="${agent.id}":`, err)
          );
        }
      }
    } finally {
      getSql().end();
    }
  }

  runStandalone().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error("[SLEEP SERVICE] Standalone run failed:", err);
    process.exit(1);
  });
}