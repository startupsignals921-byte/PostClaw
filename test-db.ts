/**
 * Quick smoke test — verifies the plugin can connect to PostgreSQL
 * and run a vector search end-to-end.
 *
 * Usage:  npm run build && node dist/test-db.js
 */

import { sql, POSTCLAW_DB_URL, setEmbeddingConfig } from "./services/db.js";
import { searchPostgres } from "./services/memoryService.js";

async function main() {
  console.log("=== Database Connection Test ===\n");
  console.log(`  Target: ${POSTCLAW_DB_URL}`);
  setEmbeddingConfig("http://127.0.0.1:1234", "text-embedding-nomic-embed-text-v2-moe");

  const TEST_AGENT_ID = "test-agent";
  console.log(`  Agent:  ${TEST_AGENT_ID}\n`);

  // ------------------------------------------------------------------
  // 1. Basic connectivity check
  // ------------------------------------------------------------------
  console.log("[TEST 1] SELECT 1 health check...");
  try {
    const rows = await sql`SELECT 1 AS ok`;
    if (rows[0]?.ok === 1) {
      console.log("  ✅  Connection OK\n");
    } else {
      throw new Error("Unexpected result from SELECT 1");
    }
  } catch (err) {
    console.error("  ❌  Connection FAILED:", err);
    await sql.end();
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // 2. Table existence check
  // ------------------------------------------------------------------
  console.log("[TEST 2] Checking required tables exist...");
  try {
    const tables = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('memory_semantic', 'entity_edges', 'memory_episodic', 'agent_persona', 'context_environment')
      ORDER BY table_name;
    `;
    const found = tables.map((t: any) => t.table_name);
    console.log(`  Found tables: ${found.join(", ")}`);

    const required = ["memory_semantic", "entity_edges"];
    const missing = required.filter((t) => !found.includes(t));
    if (missing.length > 0) {
      console.error(`  ❌  Missing required tables: ${missing.join(", ")}`);
      await sql.end();
      process.exit(1);
    }
    console.log("  ✅  All required tables present\n");
  } catch (err) {
    console.error("  ❌  Table check FAILED:", err);
    await sql.end();
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // 3. End-to-end vector search
  // ------------------------------------------------------------------
  console.log("[TEST 3] Running searchPostgres('test query')...");
  try {
    const result = await searchPostgres(TEST_AGENT_ID, "test query");
    if (result) {
      console.log(`  ✅  Got ${result.split("\n").length} result(s):`);
      // Print first 3 lines max for brevity
      result.split("\n").slice(0, 3).forEach((line: string) => console.log(`     ${line}`));
      if (result.split("\n").length > 3) console.log("     ...");
    } else {
      console.log("  ⚠️  No results returned (table may be empty — this is OK for a fresh DB)");
    }
    console.log();
  } catch (err) {
    console.error("  ❌  Search FAILED:", err);
    await sql.end();
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // Done
  // ------------------------------------------------------------------
  console.log("=== All tests passed ===");
  await sql.end();
  process.exit(0);
}

main();
