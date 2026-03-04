import postgres from "postgres";
import { createHash } from "node:crypto";
import "dotenv/config";

// =============================================================================
// CONFIG
// =============================================================================

export let LM_STUDIO_URL = process.env.LM_STUDIO_URL;
export const POSTCLAW_DB_URL = process.env.POSTCLAW_DB_URL;
export let EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-nomic-embed-text-v2-moe";

if (!POSTCLAW_DB_URL) {
  throw new Error("Missing required 'POSTCLAW_DB_URL' environment variable. Please check your .env file.");
}

/**
 * Configure the embedding provider settings. Usually called by index.ts during OpenClaw initialization.
 */
export function setEmbeddingConfig(url: string, model: string) {
  LM_STUDIO_URL = url;
  EMBEDDING_MODEL = model;
  console.log(`[EMBED] Configured via OpenClaw -> Base: ${url} | Model: ${model}`);
}

// =============================================================================
// DATABASE CLIENT
// =============================================================================

export const sql = postgres(POSTCLAW_DB_URL);

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Generate a vector embedding for a given text string via LM Studio.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  if (!LM_STUDIO_URL) {
    throw new Error(`[EMBED] Cannot get embedding. Configuration not injected.`);
  }

  if (!text || typeof text !== "string" || !text.trim()) {
    throw new Error(`[EMBED] Refusing to embed empty/undefined text (received: ${JSON.stringify(text)})`);
  }

  const body = JSON.stringify({ input: text, model: EMBEDDING_MODEL });
  console.log(`[EMBED] Request body preview: ${body.substring(0, 200)}`);

  // Strip any trailing /v1 or /v1/ from the base URL to avoid doubling
  const baseUrl = LM_STUDIO_URL!.replace(/\/v1\/?$/, "");
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Embedding API error: ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json();

  if (!data?.data?.[0]?.embedding) {
    throw new Error(`[EMBED] Unexpected API response (missing data.data[0].embedding). URL: ${baseUrl}/v1/embeddings — Response: ${JSON.stringify(data).substring(0, 300)}`);
  }

  const embedding: number[] = data.data[0].embedding;

  console.log(`[EMBED] Generated ${embedding.length}-dim vector for: "${text.substring(0, 50)}..."`);
  return embedding;
}

/**
 * SHA-256 content hash for deduplication.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
