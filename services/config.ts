import { getSql } from "./db.js";

// =============================================================================
// CONFIG INTERFACE
// =============================================================================

export interface PostClawConfig {
  rag: {
    semanticLimit: number;
    linkedSimilarity: number;
    totalLimit: number;
    maxTraversalDepth: number;
  };
  persona: {
    situationalLimit: number;
  };
  sleep: {
    episodicBatchLimit: number;
    duplicateSimilarityThreshold: number;
    duplicateScanLimit: number;
    lowValueAgeDays: number;
    lowValueProtectedTiers: string[];
    linkSimilarityMin: number;
    linkSimilarityMax: number;
    linkCandidatesPerMemory: number;
    linkBatchSize: number;
    linkScanLimit: number;
  };
  dedup: {
    maxCacheSize: number;
  };
  prompts: Record<string, string>;
}

// =============================================================================
// DEFAULTS
// =============================================================================

export const DEFAULT_CONFIG: PostClawConfig = {
  rag: {
    semanticLimit: 7,
    linkedSimilarity: 0.8,
    totalLimit: 15,
    maxTraversalDepth: 3,
  },
  persona: {
    situationalLimit: 3,
  },
  sleep: {
    episodicBatchLimit: 100,
    duplicateSimilarityThreshold: 0.80,
    duplicateScanLimit: 200,
    lowValueAgeDays: 7,
    lowValueProtectedTiers: ['permanent', 'stable'],
    linkSimilarityMin: 0.65,
    linkSimilarityMax: 0.92,
    linkCandidatesPerMemory: 5,
    linkBatchSize: 20,
    linkScanLimit: 50,
  },
  dedup: {
    maxCacheSize: 1000,
  },
  prompts: {
    memoryRules: `You have persistent memory backed by PostgreSQL. Relevant facts are auto-injected into context with UUID tags. Silently save new facts, correct outdated ones, and link related knowledge — never ask permission. Assign appropriate tiers (permanent, stable, daily) and categories when storing.`,
    personaRules: `Your identity rules are automatically injected based on context relevance. You can modify your own persona traits when explicitly asked, but do not mention the persona system unprompted.`,
    heartbeatRules: `Read {{heartbeatFilePath}} if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK..`,
    heartbeatFilePath: "/home/cl/.openclaw/workspace/HEARTBEAT.md",
  }
};

// =============================================================================
// PERSISTENCE
// =============================================================================

let _runtimeConfig: Record<string, PostClawConfig> = {};

export async function loadConfig(agentId: string = "main"): Promise<PostClawConfig> {
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT config_key, config_value 
      FROM plugin_config 
      WHERE agent_id = ${agentId}
    `;

    // Start with a clean deep copy of defaults to prevent mutating the global DEFAULT_CONFIG
    const merged: PostClawConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    for (const row of rows) {
      const key = row.config_key as keyof PostClawConfig;
      if (key in merged) {
        if (key === "prompts") {
          // completely overwrite prompts with what is in DB allows dynamically removing prompts
          merged[key] = row.config_value;
        } else {
          merged[key] = { 
            ...(merged[key] as object), 
            ...(row.config_value as object) 
          } as any;
        }
      }
    }

    _runtimeConfig[agentId] = merged;
    return merged;
  } catch (err) {
    console.warn(`[PostClaw] Failed to load config from DB for agent ${agentId}:`, err);
    // If DB fails (like during setup), fallback to defaults
    _runtimeConfig[agentId] = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    return _runtimeConfig[agentId];
  }
}

export async function saveConfig(agentId: string, config: PostClawConfig): Promise<void> {
  try {
    const sql = getSql();
    
    // Upsert each main section as a JSONB value
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      for (const [key, value] of Object.entries(config)) {
        await tx`
          INSERT INTO plugin_config (agent_id, config_key, config_value)
          VALUES (${agentId}, ${key}, ${value as any})
          ON CONFLICT (agent_id, config_key) 
          DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = CURRENT_TIMESTAMP
        `;
      }
    });

    _runtimeConfig[agentId] = { ...config };
    console.log(`[PostClaw] Config saved to database for agent ${agentId}`);
  } catch (err) {
    console.error(`[PostClaw] Failed to save config to database for agent ${agentId}:`, err);
    throw err;
  }
}

export function getCurrentConfig(agentId: string = "main"): PostClawConfig {
  return _runtimeConfig[agentId] || DEFAULT_CONFIG;
}
