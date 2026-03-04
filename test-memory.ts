import { getSql, POSTCLAW_DB_URL, setEmbeddingConfig } from "./services/db.js";
import { storeMemory, updateMemory, searchPostgres } from "./services/memoryService.js";

const TEST_AGENT_ID = "test-agent";

async function main() {
    console.log("=== Testing new memory_semantic columns ===\n");
    console.log(`  Target: ${POSTCLAW_DB_URL}`);
    setEmbeddingConfig("http://127.0.0.1:1234", "text-embedding-nomic-embed-text-v2-moe");

    try {
        const testContent = `This is a test fact created at ${Date.now()}`;
        console.log("[TEST 1] Creating a memory with additional options...");
        const { id, status } = await storeMemory(TEST_AGENT_ID, testContent, "private", {
            category: "test_category",
            volatility: "high",
            token_count: 42,
            confidence: 0.99,
            tier: "session",
            usefulness_score: 5.5,
            metadata: { test_key: "test_value" }
        });

        if (id && status === "stored") {
            console.log(`  ✅  Stored memory successfully: ${id}`);
        } else {
            console.error(`  ❌  Failed to store memory: ${status}`);
            process.exit(1);
        }

        console.log("\n[TEST 2] Verifying columns in database...");
        let rows = await getSql().begin(async (tx: any) => {
            await tx`SELECT set_config('app.current_agent_id', ${TEST_AGENT_ID}, true)`;
            return tx`
              SELECT category, volatility, token_count, confidence, tier, usefulness_score, metadata, access_count, last_accessed_at, injection_count
              FROM memory_semantic
              WHERE id = ${id}
            `;
        });
        let memory = rows[0];
        console.log("  Memory state after creation:");
        console.log(memory);

        console.log("\n[TEST 3] Searching for the memory to trigger access tracking...");
        const searchResult = await searchPostgres(TEST_AGENT_ID, testContent);
        if (searchResult && searchResult.includes(testContent)) {
            console.log(`  ✅  Search returned the memory.`);
        } else {
            console.error(`  ❌  Search did not return the memory.`);
            process.exit(1);
        }

        console.log("\n[TEST 4] Verifying access_count and last_accessed_at were updated...");
        rows = await getSql().begin(async (tx: any) => {
            await tx`SELECT set_config('app.current_agent_id', ${TEST_AGENT_ID}, true)`;
            return tx`
              SELECT access_count, injection_count, last_accessed_at
              FROM memory_semantic
              WHERE id = ${id}
            `;
        });
        memory = rows[0];
        console.log("  Memory state after search:");
        console.log(memory);

        if (memory.access_count === 1 && memory.last_accessed_at !== null) {
            console.log(`  ✅  Tracking columns updated successfully.`);
        } else {
            console.error(`  ❌  Tracking columns not updated properly.`);
            process.exit(1);
        }

        console.log("\n=== All tests passed ===");
    } catch (err) {
        console.error("  ❌  Test FAILED:", err);
    } finally {
        await getSql().end();
    }
}

main();
