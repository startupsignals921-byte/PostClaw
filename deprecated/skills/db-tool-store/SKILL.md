# Tool Store Skill

## Description

This skill allows you to store tools in the database for later use.

## Usage

exec "deno run --allow-net --allow-env
/home/cl/.openclaw/workspace/skills/db-tool-store/script.ts <agent_id> <scope>
<tool_name> <tool_json>"

## Parameters

- agent_id: The ID of the agent to store the tool for.
- scope: The scope of the tool (private or global).
- tool_name: The name of the tool.
- tool_json: The JSON representation of the tool.
