import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  describeDbTarget,
  getEmbeddingRuntimeInfo,
  validateEmbeddingDimension,
} from "./db.js";
import {
  getPostClawMemoryCounts,
  probePostgresVectorSearch,
  readMemoryByPath,
  searchPostgresStructured,
} from "./memoryService.js";

type RuntimeParams = {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
};

type RuntimeSearchResult = Awaited<ReturnType<typeof searchPostgresStructured>>;

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveWorkspaceDir(cfg: OpenClawConfig | undefined): string | undefined {
  return (cfg as any)?.workspaceDir || (cfg as any)?.agents?.defaults?.workspace;
}

function resolvePluginConfig(cfg: OpenClawConfig | undefined): Record<string, unknown> {
  const pluginConfig = (cfg as any)?.plugins?.entries?.postclaw?.config;
  return pluginConfig && typeof pluginConfig === "object"
    ? pluginConfig as Record<string, unknown>
    : {};
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

async function createMemoryManager(params: RuntimeParams) {
  const counts = await getPostClawMemoryCounts(params.agentId);
  const embeddingInfo = getEmbeddingRuntimeInfo();
  const pluginConfig = resolvePluginConfig(params.cfg);
  const workspaceDir = resolveWorkspaceDir(params.cfg);
  const dbPath = describeDbTarget();
  const ragSemanticLimit = readPositiveInteger(pluginConfig.ragSemanticLimit, 7);
  const ragTotalLimit = readPositiveInteger(pluginConfig.ragTotalLimit, 15);

  let vectorAvailable: boolean | undefined;
  let vectorError: string | undefined;
  let vectorDims: number | undefined;
  let embeddingError: string | undefined;

  const runEmbeddingProbe = async () => {
    try {
      const result = await validateEmbeddingDimension(params.agentId);
      vectorDims = result.actual;

      if (!result.matches) {
        embeddingError = `Embedding dimension mismatch: model '${result.model}' returned ${result.actual}, expected ${result.expected}`;
        return {
          ok: false,
          error: embeddingError,
        };
      }

      embeddingError = undefined;
      return { ok: true as const };
    } catch (err) {
      embeddingError = formatError(err);
      return {
        ok: false,
        error: embeddingError,
      };
    }
  };

  const search = async (
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string }
  ): Promise<RuntimeSearchResult> => {
    const requestedMaxResults = readPositiveInteger(opts?.maxResults, ragTotalLimit);
    const semanticLimit = Math.min(ragSemanticLimit, requestedMaxResults);
    const totalLimit = Math.min(ragTotalLimit, requestedMaxResults);
    const minScore = typeof opts?.minScore === "number" ? opts.minScore : undefined;

    const results = await searchPostgresStructured(params.agentId, query, {
      semanticLimit,
      totalLimit,
      trackAs: "access",
    });

    return minScore === undefined
      ? results
      : results.filter((entry) => entry.score >= minScore);
  };

  return {
    search,
    async readFile(request: { relPath: string; from?: number; lines?: number }) {
      return await readMemoryByPath(params.agentId, request.relPath, {
        from: request.from,
        lines: request.lines,
      });
    },
    status() {
      return {
        backend: "builtin" as const,
        provider: embeddingInfo.provider,
        model: embeddingInfo.model,
        requestedProvider: embeddingInfo.requestedProvider ?? embeddingInfo.provider,
        files: counts.semantic,
        chunks: counts.semantic,
        dirty: false,
        workspaceDir,
        dbPath,
        sources: ["memory" as const],
        sourceCounts: [
          {
            source: "memory" as const,
            files: counts.semantic,
            chunks: counts.semantic,
          },
        ],
        cache: { enabled: false },
        fts: {
          enabled: false,
          available: false,
        },
        vector: {
          enabled: true,
          available: vectorAvailable,
          dims: vectorDims,
          loadError: vectorError,
        },
        custom: {
          engine: "postclaw",
          storage: "postgres",
          purpose: params.purpose ?? "default",
          archivedMemories: counts.archived,
          episodicEvents: counts.episodic,
          searchMode: "pgvector+graph",
          remoteBaseUrl: embeddingInfo.remoteBaseUrl,
          embeddingError,
        },
      };
    },
    async probeEmbeddingAvailability() {
      return await runEmbeddingProbe();
    },
    async probeVectorAvailability() {
      const embeddingProbe = await runEmbeddingProbe();
      if (!embeddingProbe.ok) {
        vectorAvailable = false;
        vectorError = embeddingProbe.error;
        return false;
      }

      try {
        await probePostgresVectorSearch(params.agentId);
        vectorAvailable = true;
        vectorError = undefined;
        return true;
      } catch (err) {
        vectorAvailable = false;
        vectorError = formatError(err);
        return false;
      }
    },
    async close() {
      // PostClaw uses a shared lazy postgres client; closing here would
      // disrupt the gateway's long-lived hooks and tool handlers.
    },
  };
}

export function createPostClawMemoryRuntime() {
  return {
    async getMemorySearchManager(params: RuntimeParams) {
      try {
        return {
          manager: await createMemoryManager(params),
        };
      } catch (err) {
        return {
          manager: null,
          error: formatError(err),
        };
      }
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" as const };
    },
    async closeAllMemorySearchManagers() {
      // Managers are lightweight and stateless per request.
    },
  };
}
