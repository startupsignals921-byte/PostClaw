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

import { getSql, getEmbedding, LM_STUDIO_URL } from "../services/db.js";
import { ensureAgent } from "../services/memoryService.js";
import { callLLMviaAgent } from "../services/llm.js";

// =============================================================================
// CONFIGURATION — All thresholds are easily tunable here
// =============================================================================

// Phase 1: Episodic consolidation
const EPISODIC_BATCH_LIMIT = 100;

// Phase 2: Duplicate detection
const DUPLICATE_SIMILARITY_THRESHOLD = 0.80;
const DUPLICATE_SCAN_LIMIT = 200;

// Phase 3: Low-value cleanup
const LOW_VALUE_AGE_DAYS = 7;
const LOW_VALUE_PROTECTED_TIERS = ['permanent', 'stable'];

// Phase 4: Link discovery
const LINK_SIMILARITY_MIN = 0.65;
const LINK_SIMILARITY_MAX = 0.92;
const LINK_CANDIDATES_PER_MEMORY = 5;
const LINK_BATCH_SIZE = 20;
const LINK_SCAN_LIMIT = 50;

// Background service
const DEFAULT_INTERVAL_HOURS = 6;

// =============================================================================
// TYPES
// =============================================================================

interface SleepCycleResult {
  session_summary: string;
  extracted_durable_facts: string[];
}

interface LinkClassification {
  source_id: string;
  target_id: string;
  relationship: string;
}

export interface SleepCycleOptions {
  agentId?: string;
}

export interface SleepCycleStats {
  factsExtracted: number;
  duplicatesMerged: number;
  staleArchived: number;
  linksCreated: number;
}

// =============================================================================
// UTILITIES
// =============================================================================

// LLM calls now routed through OpenClaw's configured primary model via callLLMviaAgent

// =============================================================================
// PHASE 1: EPISODIC CONSOLIDATION
// =============================================================================

async function phaseConsolidateEpisodic(agentId: string): Promise<number> {
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
      LIMIT ${EPISODIC_BATCH_LIMIT};
    `;
  });

  if (episodes.length === 0) {
    console.log(`[PHASE 1] No new episodic memories to process.`);
    return 0;
  }

  console.log(`[PHASE 1] Found ${episodes.length} episodic events to consolidate.`);

  const transcript = episodes
    .map((e: any) => `[${e.created_at}] [${e.event_type.toUpperCase()}]: ${e.event_summary}`)
    .join("\n");

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

  const jsonString = await callLLMviaAgent(`${systemPrompt}\n\nHere is the recent episodic transcript to analyze:\n\n${transcript}`);
  const result: SleepCycleResult = JSON.parse(jsonString);

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

    const episodeIds = episodes.map((e: any) => e.id);
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

async function phaseDuplicateDetection(agentId: string): Promise<number> {
  console.log(`\n[PHASE 2] Duplicate Detection & Merge`);
  console.log(`─────────────────────────────────────────`);
  console.log(`[PHASE 2] Similarity threshold: ${DUPLICATE_SIMILARITY_THRESHOLD}`);

  const sql = getSql();

  const memories = await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
    return await tx`
      SELECT id, content, embedding, usefulness_score, access_count, created_at
      FROM memory_semantic
      WHERE agent_id = ${agentId} AND is_archived = false
      ORDER BY created_at DESC
      LIMIT ${DUPLICATE_SCAN_LIMIT};
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
        SELECT id, content, usefulness_score, access_count
        FROM memory_semantic
        WHERE agent_id = ${agentId}
          AND is_archived = false
          AND id != ${source.id}
          AND 1 - (embedding <=> ${source.embedding}) > ${DUPLICATE_SIMILARITY_THRESHOLD}
        ORDER BY usefulness_score DESC, access_count DESC
        LIMIT 10;
      `;

      if (duplicates.length === 0) continue;

      const allCandidates = [source, ...duplicates];
      allCandidates.sort((a: any, b: any) => {
        const scoreA = (a.usefulness_score || 0) + (a.access_count || 0) * 0.1;
        const scoreB = (b.usefulness_score || 0) + (b.access_count || 0) * 0.1;
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

async function phaseLowValueCleanup(agentId: string): Promise<number> {
  console.log(`\n[PHASE 3] Low-Value Entry Cleanup`);
  console.log(`─────────────────────────────────────────`);
  console.log(`[PHASE 3] Archiving memories with 0 access older than ${LOW_VALUE_AGE_DAYS} days (protecting: ${LOW_VALUE_PROTECTED_TIERS.join(', ')})`);

  const sql = getSql();

  const result = await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

    const staleMemories = await tx`
      SELECT id, content, tier, access_count, created_at
      FROM memory_semantic
      WHERE agent_id = ${agentId}
        AND is_archived = false
        AND access_count = 0
        AND created_at < NOW() - INTERVAL '1 day' * ${LOW_VALUE_AGE_DAYS}
        AND tier NOT IN ('permanent', 'stable')
      ORDER BY created_at ASC;
    `;

    if (staleMemories.length === 0) {
      return 0;
    }

    const staleIds = staleMemories.map((m: any) => m.id);
    await tx`
      UPDATE memory_semantic
      SET is_archived = true
      WHERE id IN ${sql(staleIds)};
    `;

    for (const m of staleMemories) {
      console.log(`[PHASE 3] -> Archived stale: "${m.content.substring(0, 60)}..." (tier=${m.tier}, age=${Math.round((Date.now() - new Date(m.created_at).getTime()) / 86400000)}d)`);
    }

    return staleMemories.length;
  });

  console.log(`[PHASE 3] Archived ${result} low-value memories.`);
  return result;
}

// =============================================================================
// PHASE 4: LINK CANDIDATE DISCOVERY & AUTO-LINKING
// =============================================================================

async function phaseLinkDiscovery(agentId: string): Promise<number> {
  console.log(`\n[PHASE 4] Link Candidate Discovery & Auto-Linking`);
  console.log(`─────────────────────────────────────────`);
  console.log(`[PHASE 4] Similarity range: ${LINK_SIMILARITY_MIN}–${LINK_SIMILARITY_MAX}`);

  const sql = getSql();

  const sourceMemories = await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
    return await tx`
      SELECT id, content, embedding
      FROM memory_semantic
      WHERE agent_id = ${agentId} AND is_archived = false
      ORDER BY created_at DESC
      LIMIT ${LINK_SCAN_LIMIT};
    `;
  });

  if (sourceMemories.length < 2) {
    console.log(`[PHASE 4] Not enough memories for link discovery (${sourceMemories.length}).`);
    return 0;
  }

  console.log(`[PHASE 4] Scanning ${sourceMemories.length} memories for link candidates...`);

  interface CandidatePair {
    source_id: string;
    source_content: string;
    target_id: string;
    target_content: string;
    similarity: number;
  }

  const candidatePairs: CandidatePair[] = [];
  const seenPairs = new Set<string>();

  await sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

    for (const source of sourceMemories) {
      const candidates = await tx`
        SELECT m.id, m.content, 1 - (m.embedding <=> ${source.embedding}) AS similarity
        FROM memory_semantic m
        WHERE m.agent_id = ${agentId}
          AND m.is_archived = false
          AND m.id != ${source.id}
          AND 1 - (m.embedding <=> ${source.embedding}) BETWEEN ${LINK_SIMILARITY_MIN} AND ${LINK_SIMILARITY_MAX}
          AND NOT EXISTS (
            SELECT 1 FROM entity_edges e
            WHERE e.agent_id = ${agentId}
              AND (
                (e.source_memory_id = ${source.id} AND e.target_memory_id = m.id)
                OR (e.source_memory_id = m.id AND e.target_memory_id = ${source.id})
              )
          )
        ORDER BY similarity DESC
        LIMIT ${LINK_CANDIDATES_PER_MEMORY};
      `;

      for (const candidate of candidates) {
        const pairKey = [source.id, candidate.id].sort().join(":");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        candidatePairs.push({
          source_id: source.id,
          source_content: source.content,
          target_id: candidate.id,
          target_content: candidate.content,
          similarity: candidate.similarity,
        });
      }
    }
  });

  if (candidatePairs.length === 0) {
    console.log(`[PHASE 4] No new link candidates found.`);
    return 0;
  }

  console.log(`[PHASE 4] Found ${candidatePairs.length} candidate pairs. Classifying relationships...`);

  let linksCreated = 0;

  for (let i = 0; i < candidatePairs.length; i += LINK_BATCH_SIZE) {
    const batch = candidatePairs.slice(i, i + LINK_BATCH_SIZE);

    const pairsDescription = batch
      .map((p, idx) => `${idx + 1}. [A: ${p.source_id}] "${p.source_content}"\n   [B: ${p.target_id}] "${p.target_content}" (similarity: ${(p.similarity * 100).toFixed(1)}%)`)
      .join("\n\n");

    const systemPrompt = `
You are a knowledge graph relationship classifier.
Given pairs of memory entries, classify the relationship between them.

Valid relationship types:
- "related_to" — general topical relation
- "elaborates" — B provides more detail about A
- "contradicts" — B conflicts with or corrects A
- "depends_on" — B depends on knowledge from A
- "part_of" — B is a component/subset of A
- "none" — no meaningful relationship worth linking

Output EXCLUSIVELY a JSON array of objects:
[{"source_id": "...", "target_id": "...", "relationship": "..."}]

Use "none" for pairs that don't have a meaningful relationship worth persisting.
Do not use markdown formatting.
`;

    const jsonString = await callLLMviaAgent(`${systemPrompt}\n\nClassify the relationships between these memory pairs:\n\n${pairsDescription}`);

    let classifications: LinkClassification[];
    try {
      classifications = JSON.parse(jsonString);
    } catch {
      console.error(`[PHASE 4] Failed to parse LLM response for batch ${Math.floor(i / LINK_BATCH_SIZE) + 1}. Skipping.`);
      continue;
    }

    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

      for (const cls of classifications) {
        if (cls.relationship === "none" || !cls.relationship) continue;

        try {
          await tx`
            INSERT INTO entity_edges (agent_id, source_memory_id, target_memory_id, relationship_type, weight)
            VALUES (${agentId}, ${cls.source_id}, ${cls.target_id}, ${cls.relationship}, 1.0)
            ON CONFLICT (source_memory_id, target_memory_id, relationship_type) DO NOTHING;
          `;
          linksCreated++;
          console.log(`[PHASE 4] -> Linked: ${cls.source_id.substring(0, 8)} → ${cls.target_id.substring(0, 8)} as "${cls.relationship}"`);
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
    linksCreated: 0,
  };

  try {
    stats.factsExtracted = await phaseConsolidateEpisodic(agentId);
    stats.duplicatesMerged = await phaseDuplicateDetection(agentId);
    stats.staleArchived = await phaseLowValueCleanup(agentId);
    stats.linksCreated = await phaseLinkDiscovery(agentId);

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  Sleep Cycle Complete 💤`);
    console.log(`  Facts extracted:   ${stats.factsExtracted}`);
    console.log(`  Duplicates merged: ${stats.duplicatesMerged}`);
    console.log(`  Stale archived:    ${stats.staleArchived}`);
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

  console.log(`[SLEEP SERVICE] Started — first cycle in ${label}, then every ${label} for agent="${opts.agentId || "main"}"`);

  // Do NOT run immediately — this blocks plugin install/validation.
  // First cycle fires after the interval elapses.
  _serviceTimer = setInterval(() => {
    console.log(`[SLEEP SERVICE] Interval tick — starting cycle`);
    runSleepCycle(opts).catch((err) => console.error("[SLEEP SERVICE] Cycle failed:", err));
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

  runSleepCycle({
    agentId: getArg("--agent-id") || args.find((a) => !a.startsWith("--")),
  })
    .then(() => {
      getSql().end();
      process.exit(0);
    })
    .catch(() => {
      getSql().end();
      process.exit(1);
    });
}