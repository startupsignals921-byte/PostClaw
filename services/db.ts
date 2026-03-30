import postgres from "postgres";
import { createHash } from "node:crypto";
import "dotenv/config";
import { EmbeddingApiResponseSchema } from "../schemas/validation.js";
import {
  DEFAULT_LOCAL_MODEL,
  createLocalEmbeddingProvider,
  type MemoryEmbeddingProvider,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";


// =============================================================================
// CONFIG
// =============================================================================

export let LM_STUDIO_URL = process.env.LM_STUDIO_URL;
export let POSTCLAW_DB_URL = process.env.POSTCLAW_DB_URL;
export let EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-nomic-embed-text-v2-moe";

type PostClawEmbeddingConfig = {
  provider?: string;
  model?: string;
  remote?: {
    baseUrl?: string;
    apiKey?: unknown;
    headers?: Record<string, string>;
  };
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
};

let _embeddingConfig: PostClawEmbeddingConfig | null = null;
let _openClawConfig: any = null;
let _localEmbeddingProviderPromise: Promise<MemoryEmbeddingProvider> | null = null;

export function getEmbeddingRuntimeInfo(): {
  provider: string;
  requestedProvider?: string;
  model: string;
  local: boolean;
  remoteBaseUrl?: string;
} {
  const requestedProvider = _embeddingConfig?.provider;
  const provider = requestedProvider === "local"
    ? "local"
    : requestedProvider || "remote";

  return {
    provider,
    requestedProvider,
    model: EMBEDDING_MODEL,
    local: provider === "local",
    remoteBaseUrl: provider === "local" ? undefined : LM_STUDIO_URL,
  };
}

export function describeDbTarget(): string | undefined {
  if (!POSTCLAW_DB_URL) return undefined;

  try {
    const parsed = new URL(POSTCLAW_DB_URL);
    const host = parsed.hostname || "localhost";
    const port = parsed.port ? `:${parsed.port}` : "";
    const database = parsed.pathname || "";
    return `${parsed.protocol}//${host}${port}${database}`;
  } catch {
    return "postgres";
  }
}

/**
 * Set the database connection URL. Called by the plugin register() if the user
 * supplies `dbUrl` in the plugin config. Falls back to env var POSTCLAW_DB_URL.
 */
export function setDbUrl(url: string) {
  POSTCLAW_DB_URL = url;
}

/**
 * Configure the embedding provider settings. Usually called by index.ts during OpenClaw initialization.
 */
export function setEmbeddingConfig(configOrUrl: PostClawEmbeddingConfig | string, modelOrHostConfig?: string | any) {
  _localEmbeddingProviderPromise = null;

  if (typeof configOrUrl === "string") {
    const model = typeof modelOrHostConfig === "string"
      ? modelOrHostConfig
      : process.env.EMBEDDING_MODEL || "text-embedding-nomic-embed-text-v2-moe";

    _embeddingConfig = {
      provider: "remote",
      model,
      remote: { baseUrl: configOrUrl },
    };
    _openClawConfig = null;
    LM_STUDIO_URL = configOrUrl;
    EMBEDDING_MODEL = model;
    console.log(`[EMBED] Configured via OpenClaw -> Base: ${configOrUrl} | Model: ${model}`);
    return;
  }

  _embeddingConfig = configOrUrl;
  _openClawConfig = modelOrHostConfig ?? null;

  if (_embeddingConfig?.provider === "local") {
    LM_STUDIO_URL = undefined;
    EMBEDDING_MODEL = _embeddingConfig.local?.modelPath || _embeddingConfig.model || DEFAULT_LOCAL_MODEL;
    console.log(`[EMBED] Configured via OpenClaw -> Provider: local | Model: ${EMBEDDING_MODEL}`);
    return;
  }

  const baseUrl = _embeddingConfig?.remote?.baseUrl || "http://127.0.0.1:1234/v1";
  const model = _embeddingConfig?.model || process.env.EMBEDDING_MODEL || "text-embedding-nomic-embed-text-v2-moe";

  LM_STUDIO_URL = baseUrl;
  EMBEDDING_MODEL = model;
  console.log(`[EMBED] Configured via OpenClaw -> Base: ${baseUrl} | Model: ${model}`);
}

async function getLocalEmbeddingProvider(): Promise<MemoryEmbeddingProvider> {
  if (!_embeddingConfig || _embeddingConfig.provider !== "local") {
    throw new Error("[EMBED] Local embedding provider requested without local memorySearch config.");
  }

  if (!_localEmbeddingProviderPromise) {
    _localEmbeddingProviderPromise = createLocalEmbeddingProvider({
      config: _openClawConfig ?? {},
      provider: "local",
      fallback: "none",
      model: _embeddingConfig.model || _embeddingConfig.local?.modelPath || DEFAULT_LOCAL_MODEL,
      local: _embeddingConfig.local,
    });
  }

  return await _localEmbeddingProviderPromise;
}

// =============================================================================
// DATABASE CLIENT — Lazily initialized
// =============================================================================

let _sql: ReturnType<typeof postgres> | null = null;

/**
 * Returns the shared postgres client, creating it on first use. This allows the
 * plugin config (`dbUrl`) to be applied before the connection is opened.
 */
export function getSql(): ReturnType<typeof postgres> {
  if (_sql) return _sql;

  if (!POSTCLAW_DB_URL) {
    throw new Error(
      "Missing database URL. Set 'dbUrl' in plugins.entries.postclaw.config or the POSTCLAW_DB_URL environment variable."
    );
  }

  _sql = postgres(POSTCLAW_DB_URL);
  console.log(`[PostClaw] Database connection established`);
  return _sql;
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Generate a vector embedding for a given text string via LM Studio.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  if (_embeddingConfig?.provider === "local") {
    if (!text || typeof text !== "string" || !text.trim()) {
      throw new Error(`[EMBED] Refusing to embed empty/undefined text (received: ${JSON.stringify(text)})`);
    }

    const provider = await getLocalEmbeddingProvider();
    const embedding = await provider.embedQuery(text);

    console.log(`[EMBED] Generated ${embedding.length}-dim vector via OpenClaw local provider for: "${text.substring(0, 50)}..."`);
    return embedding;
  }

  if (!LM_STUDIO_URL) {
    throw new Error(`[EMBED] Cannot get embedding. Configuration not injected.`);
  }

  if (!text || typeof text !== "string" || !text.trim()) {
    throw new Error(`[EMBED] Refusing to embed empty/undefined text (received: ${JSON.stringify(text)})`);
  }

  const body = JSON.stringify({ input: text, model: EMBEDDING_MODEL });
  console.log(`[EMBED] Request body preview: ${body.substring(0, 200)}`);

  // Strip any trailing /v1 or /v1/ from the base URL to avoid doubling
  // Replace 'localhost' with '127.0.0.1' to prevent Node 18+ IPv6 fetch failures
  const baseUrl = LM_STUDIO_URL!.replace(/\/v1\/?$/, "").replace("localhost", "127.0.0.1");
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Embedding API error: ${res.status} ${res.statusText}`);
  }

  const raw: unknown = await res.json();
  const parsed = EmbeddingApiResponseSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(`[EMBED] Unexpected API response. URL: ${baseUrl}/v1/embeddings — Errors: ${parsed.error.message}`);
  }

  const embedding = parsed.data.data[0].embedding;

  console.log(`[EMBED] Generated ${embedding.length}-dim vector for: "${text.substring(0, 50)}..."`);
  return embedding;
}

/**
 * Validates the currently configured embedding model against the dimensions
 * expected by the Postgres schema for this agent. Returns a compatibility status.
 */
export async function validateEmbeddingDimension(agentId: string): Promise<{
  model: string;
  expected: number;
  actual: number;
  matches: boolean;
}> {
  try {
    const sql = getSql();
    
    // 1. Get expected dimensions from schema
    const agents = await sql`
      SELECT embedding_dimensions 
      FROM agents 
      WHERE id = ${agentId}
    `;
    
    // Default to 768 if entirely missing (e.g. older schema version before columns added)
    const expected = agents.length > 0 && agents[0].embedding_dimensions 
      ? agents[0].embedding_dimensions 
      : 768;

    // 2. Generate a tiny test embedding to find actual dimensions
    const testEmbedding = await getEmbedding("test dimension check");
    const actual = testEmbedding.length;
    
    const matches = expected === actual;
    const model = EMBEDDING_MODEL;

    if (!matches) {
       console.error(`[EMBED] DIMENSION MISMATCH ERROR! Model '${model}' returned ${actual} dimensions, but database schema expects ${expected}. Semantic writes will fail.`);
    } else {
       console.log(`[EMBED] Model '${model}' verified: ${actual} dimensions.`);
    }

    return { model, expected, actual, matches };
  } catch (err) {
    console.error(`[EMBED] Failed to validate dimensions:`, err);
    throw err;
  }
}

/**
 * SHA-256 content hash for deduplication.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
