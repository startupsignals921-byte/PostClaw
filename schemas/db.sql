CREATE USER openclaw WITH LOGIN PASSWORD '6599';

GRANT CONNECT ON DATABASE memorydb TO openclaw;

-- 1. Core Extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Enumerated Types
CREATE TYPE access_scope_enum AS ENUM ('private', 'shared', 'global');
CREATE TYPE memory_tier_enum AS ENUM ('volatile', 'session', 'daily', 'stable', 'permanent');
CREATE TYPE volatility_enum AS ENUM ('low', 'medium', 'high');

-- ==========================================
-- LAYER 0: IDENTITY & TRIGGERS (NEW)
-- ==========================================

-- Trigger to automatically handle updated_at
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Function to enforce global record ownership while allowing superceding memories
CREATE OR REPLACE FUNCTION enforce_immutable_ownership()
RETURNS TRIGGER AS $$
BEGIN
    -- Prevent identity spoofing or stealing global memories
    IF NEW.agent_id <> OLD.agent_id THEN
        RAISE EXCEPTION 'Epistemic violation: Cannot change the original author (agent_id) of a memory.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Core Agents Table (Prevents orphaned memories)
CREATE TABLE agents (
    id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    default_embedding_model VARCHAR(100) DEFAULT 'nomic-embed-text-v2-moe',
    embedding_dimensions INT DEFAULT 768,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT true
);

-- ==========================================
-- LAYER 1: THE CONSTITUTION & PROTOCOLS
-- ==========================================

CREATE TABLE agent_persona (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id VARCHAR(100) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    access_scope access_scope_enum DEFAULT 'private',
    category VARCHAR(50) NOT NULL, 
    content TEXT NOT NULL,
    is_always_active BOOLEAN DEFAULT false,
    
    -- Removed hardcoded dimensions to support model swapping
    embedding vector, 
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_id, category)
);

CREATE TABLE context_environment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id VARCHAR(100) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    access_scope access_scope_enum DEFAULT 'private',
    tool_name VARCHAR(100) NOT NULL,
    context_data TEXT NOT NULL, 
    embedding vector,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_id, tool_name) -- NEW: Prevents duplicate tool definitions
);

-- ==========================================
-- LAYER 2: THE ACTIVE BRAIN (With Drift Protection)
-- ==========================================

CREATE TABLE memory_semantic (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id VARCHAR(100) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    access_scope access_scope_enum DEFAULT 'private',
    
    content TEXT NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    category VARCHAR(50), 
    
    source_uri VARCHAR(512),             
    volatility volatility_enum DEFAULT 'low', 
    is_pointer BOOLEAN DEFAULT false,    
    
    -- AI Operations 
    embedding vector,
    embedding_model VARCHAR(100) NOT NULL, -- Required to group vectors for HNSW
    token_count INT NOT NULL DEFAULT 0,
    
    -- FTS switched to 'simple' dictionary to preserve exact code/JSON tokens
    fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
    
    confidence REAL DEFAULT 0.5,
    tier memory_tier_enum DEFAULT 'daily',
    usefulness_score REAL DEFAULT 0.0, 
    
    injection_count INT DEFAULT 0, 
    access_count INT DEFAULT 0,    
    last_injected_at TIMESTAMPTZ,
    last_accessed_at TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ,
    is_archived BOOLEAN DEFAULT false,
    
    -- AI Metadata & Reasoning Trace
    metadata JSONB DEFAULT '{}'::jsonb,
    superseded_by UUID REFERENCES memory_semantic(id) ON DELETE SET NULL,
    
    UNIQUE(agent_id, content_hash)
);

CREATE TRIGGER update_memory_semantic_modtime 
BEFORE UPDATE ON memory_semantic 
FOR EACH ROW EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER trg_immutable_memory_owner
BEFORE UPDATE ON memory_semantic
FOR EACH ROW EXECUTE FUNCTION enforce_immutable_ownership();

CREATE TABLE memory_episodic (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id VARCHAR(100) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id VARCHAR(100) NOT NULL,
    
    event_summary TEXT NOT NULL,
    event_type VARCHAR(50), 
    source_uri VARCHAR(512), 
    
    embedding vector,
    embedding_model VARCHAR(100) NOT NULL,
    token_count INT NOT NULL DEFAULT 0,
    
    fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, event_summary)) STORED,
    
    usefulness_score REAL DEFAULT 0.0,
    metadata JSONB DEFAULT '{}'::jsonb,
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    is_archived BOOLEAN DEFAULT false 
);

-- ==========================================
-- LAYER 3: ADVANCED FACULTIES
-- ==========================================

CREATE TABLE conversation_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id VARCHAR(100) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id VARCHAR(100) NOT NULL,
    summary TEXT NOT NULL, 
    active_tasks JSONB,    
    token_count INT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE entity_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id VARCHAR(100) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    
    -- Removed ON DELETE CASCADE to prevent RAG amnesia. 
    -- Relies on application-level soft deletion handling.
    source_memory_id UUID REFERENCES memory_semantic(id),
    target_memory_id UUID REFERENCES memory_semantic(id),
    relationship_type VARCHAR(100) NOT NULL, 
    weight REAL DEFAULT 1.0,                 
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    -- Prevent self-referential graph loops
    CHECK (source_memory_id != target_memory_id),
    UNIQUE(source_memory_id, target_memory_id, relationship_type)
);

-- ==========================================
-- INDICES & PERFORMANCE 
-- ==========================================

-- Standard and File Watcher Indices
CREATE INDEX idx_mem_sem_agent_tier ON memory_semantic(agent_id, tier, is_archived);
CREATE INDEX idx_mem_sem_hash ON memory_semantic(content_hash);
CREATE INDEX idx_mem_epi_session ON memory_episodic(agent_id, session_id, is_archived);
CREATE INDEX idx_mem_sem_source_uri ON memory_semantic(source_uri) WHERE source_uri IS NOT NULL;
CREATE INDEX idx_mem_sem_metadata ON memory_semantic USING gin (metadata);
CREATE INDEX idx_mem_epi_metadata ON memory_episodic USING gin (metadata);
CREATE INDEX idx_mem_sem_expires ON memory_semantic(expires_at) WHERE expires_at IS NOT NULL;

-- Search Indices
CREATE INDEX ON memory_semantic USING gin (fts_vector);
CREATE INDEX ON memory_episodic USING gin (fts_vector);

-- Partial HNSW Vector Indices (Segmented by model and cast to specific dimensions)
CREATE INDEX idx_mem_sem_vector_nomic ON memory_semantic USING hnsw ((embedding::vector(768)) vector_cosine_ops) WHERE embedding_model = 'nomic-embed-text-v2-moe';
CREATE INDEX idx_mem_sem_vector_openai ON memory_semantic USING hnsw ((embedding::vector(1536)) vector_cosine_ops) WHERE embedding_model = 'text-embedding-3-small';

-- GraphRAG Traversal Indices
CREATE INDEX idx_edges_source ON entity_edges(source_memory_id);
CREATE INDEX idx_edges_target ON entity_edges(target_memory_id);

-- Causal Chain Index (Allows fast lookups of "Which memories were superseded by X?")
CREATE INDEX idx_mem_sem_superseded ON memory_semantic(superseded_by) WHERE superseded_by IS NOT NULL;

-- ==========================================
-- ADMIN USER SETUP
-- ==========================================

-- Create a role for your backend admin/system jobs
CREATE ROLE system_admin WITH LOGIN PASSWORD 'snack-trailing-gathering-effective-spiritual-balsamic';

-- Grant this role the power to ignore RLS 
ALTER ROLE system_admin BYPASSRLS;

-- (Give them standard read/write permissions as well)
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO system_admin;

-- ==========================================
-- ROW-LEVEL SECURITY (RLS)
-- ==========================================

-- Enable RLS across ALL relevant tables
ALTER TABLE memory_semantic ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_episodic ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_persona ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_environment ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_edges ENABLE ROW LEVEL SECURITY;

-- 1. Read Policy: Can read own memories + shared/global memories
CREATE POLICY semantic_read ON memory_semantic FOR SELECT
    USING (agent_id = current_setting('app.current_agent_id', true) OR access_scope IN ('shared', 'global'));

-- 2. Insert Policy: Can ONLY insert memories as yourself
CREATE POLICY semantic_insert ON memory_semantic FOR INSERT
    WITH CHECK (agent_id = current_setting('app.current_agent_id', true));

-- 3. Update Policy: Can ONLY update YOUR memories. You cannot alter someone else's global memory.
CREATE POLICY semantic_update ON memory_semantic FOR UPDATE
    USING (
        -- You can target the row if you own it, OR if it's a global fact
        agent_id = current_setting('app.current_agent_id', true) 
        OR access_scope = 'global'
    )
    WITH CHECK (
        -- If you update a global memory, you CANNOT downgrade it to private.
        -- It must remain global for the rest of the hive mind.
        (agent_id = current_setting('app.current_agent_id', true))
        OR 
        (access_scope = 'global')
    );

-- 4. Delete Policy: Can ONLY delete YOUR memories.
CREATE POLICY semantic_delete ON memory_semantic FOR DELETE
    USING (agent_id = current_setting('app.current_agent_id', true));

-- ==========================================
-- AGENT PERSONA POLICIES
-- ==========================================
CREATE POLICY persona_read ON agent_persona FOR SELECT
    USING (agent_id = current_setting('app.current_agent_id', true) OR access_scope IN ('shared', 'global'));

CREATE POLICY persona_insert ON agent_persona FOR INSERT
    WITH CHECK (agent_id = current_setting('app.current_agent_id', true));

CREATE POLICY persona_update ON agent_persona FOR UPDATE
    USING (agent_id = current_setting('app.current_agent_id', true) OR access_scope = 'global')
    WITH CHECK (agent_id = current_setting('app.current_agent_id', true) OR access_scope = 'global');

CREATE POLICY persona_delete ON agent_persona FOR DELETE
    USING (agent_id = current_setting('app.current_agent_id', true));

-- ==========================================
-- CONTEXT ENVIRONMENT (TOOLS) POLICIES
-- ==========================================
CREATE POLICY context_read ON context_environment FOR SELECT
    USING (agent_id = current_setting('app.current_agent_id', true) OR access_scope IN ('shared', 'global'));

CREATE POLICY context_insert ON context_environment FOR INSERT
    WITH CHECK (agent_id = current_setting('app.current_agent_id', true));

CREATE POLICY context_update ON context_environment FOR UPDATE
    USING (agent_id = current_setting('app.current_agent_id', true) OR access_scope = 'global')
    WITH CHECK (agent_id = current_setting('app.current_agent_id', true) OR access_scope = 'global');

CREATE POLICY context_delete ON context_environment FOR DELETE
    USING (agent_id = current_setting('app.current_agent_id', true));

-- * CRITICAL SECURITY NOTE: Just like semantic_memory, you must apply the 
-- immutable ownership trigger here so agents can't steal global tools/personas during an UPDATE.
CREATE TRIGGER trg_immutable_persona_owner BEFORE UPDATE ON agent_persona
    FOR EACH ROW EXECUTE FUNCTION enforce_immutable_ownership();
CREATE TRIGGER trg_immutable_context_owner BEFORE UPDATE ON context_environment
    FOR EACH ROW EXECUTE FUNCTION enforce_immutable_ownership();

-- Ensure RLS is active on Checkpoints (we missed this in the original ALTER TABLE block)
ALTER TABLE conversation_checkpoints ENABLE ROW LEVEL SECURITY;

-- ==========================================
-- EPISODIC MEMORY POLICIES
-- ==========================================
CREATE POLICY episodic_read ON memory_episodic FOR SELECT
    USING (agent_id = current_setting('app.current_agent_id', true));

CREATE POLICY episodic_insert ON memory_episodic FOR INSERT
    WITH CHECK (agent_id = current_setting('app.current_agent_id', true));

CREATE POLICY episodic_update ON memory_episodic FOR UPDATE
    USING (agent_id = current_setting('app.current_agent_id', true))
    WITH CHECK (agent_id = current_setting('app.current_agent_id', true));

CREATE POLICY episodic_delete ON memory_episodic FOR DELETE
    USING (agent_id = current_setting('app.current_agent_id', true));

-- ==========================================
-- CONVERSATION CHECKPOINTS POLICIES
-- ==========================================
CREATE POLICY checkpoint_read ON conversation_checkpoints FOR SELECT
    USING (agent_id = current_setting('app.current_agent_id', true));

CREATE POLICY checkpoint_insert ON conversation_checkpoints FOR INSERT
    WITH CHECK (agent_id = current_setting('app.current_agent_id', true));

CREATE POLICY checkpoint_update ON conversation_checkpoints FOR UPDATE
    USING (agent_id = current_setting('app.current_agent_id', true))
    WITH CHECK (agent_id = current_setting('app.current_agent_id', true));

CREATE POLICY checkpoint_delete ON conversation_checkpoints FOR DELETE
    USING (agent_id = current_setting('app.current_agent_id', true));

-- ==========================================
-- KNOWLEDGE GRAPH EDGES POLICIES
-- ==========================================

-- READ: You can see an edge if you drew it yourself, OR if it connects 
-- to at least one memory node that is shared/global.
CREATE POLICY edge_read ON entity_edges FOR SELECT
    USING (
        agent_id = current_setting('app.current_agent_id', true)
        OR EXISTS (
            SELECT 1 FROM memory_semantic ms 
            WHERE ms.id IN (source_memory_id, target_memory_id)
            AND ms.access_scope IN ('shared', 'global')
        )
    );

-- INSERT: You can only draw edges as yourself
CREATE POLICY edge_insert ON entity_edges FOR INSERT
    WITH CHECK (agent_id = current_setting('app.current_agent_id', true));

-- UPDATE: Edges are simple metadata (weights, relationship type). 
-- Only the agent who mapped the relationship should be able to update its weight.
CREATE POLICY edge_update ON entity_edges FOR UPDATE
    USING (agent_id = current_setting('app.current_agent_id', true))
    WITH CHECK (agent_id = current_setting('app.current_agent_id', true));

-- DELETE: You can only delete edges you authored
CREATE POLICY edge_delete ON entity_edges FOR DELETE
    USING (agent_id = current_setting('app.current_agent_id', true));

-- Move this to the BOTTOM of init.sql (after all tables are created)
GRANT USAGE ON SCHEMA public TO openclaw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openclaw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openclaw;
