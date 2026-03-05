/**
 * Tests for dashboard Zod schemas — validates all API input schemas
 * with both valid and invalid inputs.
 */

import { describe, it, expect } from "vitest";
import {
  PersonaCreateSchema,
  PersonaUpdateSchema,
  DashboardMemoryCreateSchema,
  DashboardMemoryUpdateSchema,
  MemoryImportSchema,
  GraphEdgeCreateSchema,
  ScriptRunSchema,
  MemoryListQuerySchema,
  PersonaEdgeCreateSchema,
  WorkspaceImportSchema,
} from "../schemas/validation.js";

// =============================================================================
// PERSONA SCHEMAS
// =============================================================================

describe("PersonaCreateSchema", () => {
  it("accepts valid input", () => {
    const result = PersonaCreateSchema.parse({
      category: "communication_style",
      content: "Be concise and direct.",
    });
    expect(result.category).toBe("communication_style");
    expect(result.is_always_active).toBe(false);
    expect(result.access_scope).toBe("private");
  });

  it("applies defaults", () => {
    const result = PersonaCreateSchema.parse({
      category: "test",
      content: "test content",
    });
    expect(result.is_always_active).toBe(false);
    expect(result.access_scope).toBe("private");
  });

  it("rejects empty category", () => {
    expect(() => PersonaCreateSchema.parse({ category: "", content: "test" })).toThrow();
  });

  it("rejects missing content", () => {
    expect(() => PersonaCreateSchema.parse({ category: "test" })).toThrow();
  });

  it("rejects category over 50 chars", () => {
    expect(() => PersonaCreateSchema.parse({
      category: "a".repeat(51),
      content: "test",
    })).toThrow();
  });
});

describe("PersonaUpdateSchema", () => {
  it("accepts partial updates", () => {
    const result = PersonaUpdateSchema.parse({ content: "Updated content" });
    expect(result.content).toBe("Updated content");
    expect(result.category).toBeUndefined();
  });

  it("accepts empty object (no-op update)", () => {
    const result = PersonaUpdateSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts all fields", () => {
    const result = PersonaUpdateSchema.parse({
      category: "new_cat",
      content: "new content",
      is_always_active: true,
      access_scope: "shared",
    });
    expect(result.is_always_active).toBe(true);
    expect(result.access_scope).toBe("shared");
  });
});

// =============================================================================
// MEMORY SCHEMAS
// =============================================================================

describe("DashboardMemoryCreateSchema", () => {
  it("accepts valid input with defaults", () => {
    const result = DashboardMemoryCreateSchema.parse({ content: "A fact" });
    expect(result.scope).toBe("private");
    expect(result.tier).toBe("daily");
    expect(result.volatility).toBe("low");
  });

  it("accepts full input", () => {
    const result = DashboardMemoryCreateSchema.parse({
      content: "Important fact",
      scope: "global",
      category: "preference",
      tier: "permanent",
      volatility: "high",
      metadata: { source: "manual" },
    });
    expect(result.tier).toBe("permanent");
    expect(result.metadata).toEqual({ source: "manual" });
  });

  it("rejects empty content", () => {
    expect(() => DashboardMemoryCreateSchema.parse({ content: "" })).toThrow();
  });
});

describe("DashboardMemoryUpdateSchema", () => {
  it("accepts partial updates", () => {
    const result = DashboardMemoryUpdateSchema.parse({ tier: "permanent" });
    expect(result.tier).toBe("permanent");
  });

  it("accepts is_archived flag", () => {
    const result = DashboardMemoryUpdateSchema.parse({ is_archived: true });
    expect(result.is_archived).toBe(true);
  });
});

describe("MemoryImportSchema", () => {
  it("accepts markdown content with defaults", () => {
    const result = MemoryImportSchema.parse({ content: "# Heading\nSome content" });
    expect(result.tier).toBe("stable");
  });

  it("accepts source filename", () => {
    const result = MemoryImportSchema.parse({
      content: "Facts here",
      source_filename: "memory.md",
      tier: "permanent",
    });
    expect(result.source_filename).toBe("memory.md");
  });
});

// =============================================================================
// GRAPH SCHEMA
// =============================================================================

describe("GraphEdgeCreateSchema", () => {
  it("accepts valid memory-to-memory edge", () => {
    const result = GraphEdgeCreateSchema.parse({
      source_memory_id: "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d",
      target_memory_id: "f1e2d3c4-b5a6-4a5b-8c9d-0e1f2a3b4c5d",
      relationship_type: "related_to",
    });
    expect(result.weight).toBe(1.0);
  });

  it("accepts persona-to-memory edge", () => {
    const result = GraphEdgeCreateSchema.parse({
      source_persona_id: "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d",
      target_memory_id: "f1e2d3c4-b5a6-4a5b-8c9d-0e1f2a3b4c5d",
      relationship_type: "defines",
    });
    expect(result.source_persona_id).toBe("a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d");
  });

  it("rejects edge with no source or target", () => {
    expect(() => GraphEdgeCreateSchema.parse({
      relationship_type: "related_to",
    })).toThrow();
  });

  it("rejects invalid UUID", () => {
    expect(() => GraphEdgeCreateSchema.parse({
      source_memory_id: "not-a-uuid",
      target_memory_id: "also-not",
      relationship_type: "related_to",
    })).toThrow();
  });

  it("rejects empty relationship", () => {
    expect(() => GraphEdgeCreateSchema.parse({
      source_memory_id: "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d",
      target_memory_id: "f1e2d3c4-b5a6-4a5b-8c9d-0e1f2a3b4c5d",
      relationship_type: "",
    })).toThrow();
  });
});

// =============================================================================
// SCRIPT & QUERY SCHEMAS
// =============================================================================

describe("ScriptRunSchema", () => {
  it("applies default agentId", () => {
    const result = ScriptRunSchema.parse({});
    expect(result.agentId).toBe("main");
  });

  it("accepts file path", () => {
    const result = ScriptRunSchema.parse({ file: "/path/to/SOUL.md" });
    expect(result.file).toBe("/path/to/SOUL.md");
  });
});

describe("MemoryListQuerySchema", () => {
  it("applies defaults", () => {
    const result = MemoryListQuerySchema.parse({});
    expect(result.agentId).toBe("main");
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
    expect(result.archived).toBe("false");
  });

  it("coerces string numbers", () => {
    const result = MemoryListQuerySchema.parse({ limit: "25", offset: "10" });
    expect(result.limit).toBe(25);
    expect(result.offset).toBe(10);
  });

  it("rejects limit over 500", () => {
    expect(() => MemoryListQuerySchema.parse({ limit: "501" })).toThrow();
  });
});

// =============================================================================
// NEW: PERSONA EDGE & WORKSPACE IMPORT SCHEMAS
// =============================================================================

describe("PersonaEdgeCreateSchema", () => {
  it("accepts valid persona-memory link", () => {
    const result = PersonaEdgeCreateSchema.parse({
      persona_id: "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d",
      memory_id: "f1e2d3c4-b5a6-4a5b-8c9d-0e1f2a3b4c5d",
      relationship_type: "defines",
    });
    expect(result.weight).toBe(1.0);
    expect(result.relationship_type).toBe("defines");
  });

  it("rejects invalid persona UUID", () => {
    expect(() => PersonaEdgeCreateSchema.parse({
      persona_id: "not-valid",
      memory_id: "f1e2d3c4-b5a6-4a5b-8c9d-0e1f2a3b4c5d",
      relationship_type: "supports",
    })).toThrow();
  });

  it("rejects missing relationship", () => {
    expect(() => PersonaEdgeCreateSchema.parse({
      persona_id: "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d",
      memory_id: "f1e2d3c4-b5a6-4a5b-8c9d-0e1f2a3b4c5d",
    })).toThrow();
  });
});

describe("WorkspaceImportSchema", () => {
  it("accepts valid persona import", () => {
    const result = WorkspaceImportSchema.parse({
      filename: "SOUL.md",
      target: "persona",
    });
    expect(result.tier).toBe("stable");
    expect(result.target).toBe("persona");
  });

  it("accepts valid memory import with tier", () => {
    const result = WorkspaceImportSchema.parse({
      filename: "notes.md",
      target: "memory",
      tier: "permanent",
    });
    expect(result.tier).toBe("permanent");
  });

  it("rejects invalid target", () => {
    expect(() => WorkspaceImportSchema.parse({
      filename: "test.md",
      target: "invalid",
    })).toThrow();
  });

  it("rejects empty filename", () => {
    expect(() => WorkspaceImportSchema.parse({
      filename: "",
      target: "persona",
    })).toThrow();
  });
});
