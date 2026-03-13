/**
 * Minimal agent test harness for the Yuki MCP server.
 *
 * Spins up the MCP server as a subprocess, connects to it via stdio,
 * then runs a task through Claude using a full agentic tool-call loop.
 * This simulates exactly how OpenClaw will use the MCP server.
 *
 * Usage:
 *   npx tsx scripts/test-agent.ts
 *   npx tsx scripts/test-agent.ts --scenario get-administrations
 *   npx tsx scripts/test-agent.ts --scenario search-relations --arg "Apple"
 *
 * Requirements:
 *   ANTHROPIC_API_KEY must be set (in .env or environment)
 *   YUKI_API_KEY must be set
 *   Run `npm run build` first
 */

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, "../dist/index.js");

// ── Scenarios ─────────────────────────────────────────────────────────────────

/**
 * A scenario is a plain-text task description passed to the agent.
 * The agent then decides which tools to call to complete it.
 * Add or modify scenarios here to cover your own test cases.
 */
const SCENARIOS: Record<string, (arg?: string) => string> = {
  "get-administrations": () =>
    "List all Yuki administrations accessible with the current API key. " +
    "Show me the administration ID(s) and their names.",

  "search-relations": (arg = "test") =>
    `Search for relations in Yuki with the name or code "${arg}". ` +
    "Show me their contact codes, names, and contact types.",

  "outstanding-invoices": () =>
    "Give me an overview of all outstanding sales invoices (open debtor items). " +
    "For each item, show the contact name, reference, amount, and due date.",

  "outstanding-payables": () =>
    "Give me an overview of all outstanding purchase invoices (open creditor items). " +
    "For each item, show the supplier name, reference, amount, and due date.",

  "gl-accounts": () =>
    "Fetch all GL accounts with their current balance. " +
    "Look for accounts that look like bank accounts (typically in the 1100–1299 range) " +
    "and highlight them.",

  "bank-transactions": (arg = "1200") =>
    `Fetch the last 30 days of transactions for GL account ${arg}. ` +
    "Summarise the total inflow and outflow.",

  "full-workflow": () =>
    "Do the following in order:\n" +
    "1. Get the list of administrations\n" +
    "2. Fetch all outstanding sales invoices\n" +
    "3. Fetch all outstanding purchase invoices\n" +
    "Summarise the total receivables and payables.",
};

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const scenarioFlag = args.indexOf("--scenario");
const argFlag = args.indexOf("--arg");

const scenarioKey =
  scenarioFlag !== -1 ? args[scenarioFlag + 1] : "get-administrations";
const scenarioArg = argFlag !== -1 ? args[argFlag + 1] : undefined;

if (!SCENARIOS[scenarioKey]) {
  console.error(`Unknown scenario: "${scenarioKey}"`);
  console.error("Available:", Object.keys(SCENARIOS).join(", "));
  process.exit(1);
}

const task = SCENARIOS[scenarioKey](scenarioArg);

// ── Validation ────────────────────────────────────────────────────────────────

if (!process.env["ANTHROPIC_API_KEY"]) {
  console.error("❌ ANTHROPIC_API_KEY is not set");
  process.exit(1);
}
if (!process.env["YUKI_API_KEY"]) {
  console.error("❌ YUKI_API_KEY is not set");
  process.exit(1);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();

// Launch the MCP server as a child process connected via stdio
const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER_PATH],
  env: {
    ...process.env,
    YUKI_API_KEY: process.env["YUKI_API_KEY"] ?? "",
    YUKI_DOMAIN_ID: process.env["YUKI_DOMAIN_ID"] ?? "",
  } as Record<string, string>,
});

const mcpClient = new Client({ name: "test-agent", version: "1.0.0" });

// ── Agent loop ────────────────────────────────────────────────────────────────

async function run() {
  console.log("━".repeat(60));
  console.log(`🧪 Scenario : ${scenarioKey}`);
  console.log(`📋 Task     : ${task}`);
  console.log("━".repeat(60));

  // Connect to the MCP server
  await mcpClient.connect(transport);
  console.log("✅ Connected to yuki-mcp server\n");

  // Fetch all available tools from the MCP server
  const { tools: mcpTools } = await mcpClient.listTools();

  // Convert MCP tool definitions to Anthropic tool format
  const anthropicTools: Anthropic.Tool[] = mcpTools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
  }));

  console.log(
    `🔧 Tools available (${anthropicTools.length}):`,
    anthropicTools.map((t) => t.name).join(", "),
    "\n"
  );

  // Conversation history — grows as the agent calls tools
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: task },
  ];

  let iteration = 0;
  const MAX_ITERATIONS = 10; // Safety limit to prevent runaway loops

  // Agentic loop: keep going until Claude stops requesting tool calls
  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`\n${"─".repeat(60)}`);
    console.log(`🔄 Iteration ${iteration}`);

    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 4096,
      system:
        "You are a bookkeeping assistant with access to the Yuki accounting system. " +
        "Use the available tools to complete the user's task accurately. " +
        "Always call get_administrations first if you don't have an administrationId. " +
        "Be concise in your final answer — focus on the data, not the process.",
      tools: anthropicTools,
      messages,
    });

    // Show what Claude is doing
    for (const block of response.content) {
      if (block.type === "text" && block.text) {
        console.log("\n💬 Claude:", block.text);
      } else if (block.type === "tool_use") {
        console.log(`\n🔧 Tool call: ${block.name}`);
        console.log("   Input:", JSON.stringify(block.input, null, 2));
      }
    }

    // If Claude is done (no more tool calls), print the final answer and exit
    if (response.stop_reason === "end_turn") {
      const finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      console.log("\n" + "━".repeat(60));
      console.log("✅ Final answer:\n");
      console.log(finalText);
      console.log("━".repeat(60));
      break;
    }

    // Append Claude's response (including tool_use blocks) to the conversation
    messages.push({ role: "assistant", content: response.content });

    // Execute all tool calls Claude requested and collect the results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      let toolResult: string;
      try {
        const result = await mcpClient.callTool({
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });

        // MCP returns content as an array of blocks — extract the text
        const text = (result.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");

        toolResult = text;
        console.log(`\n   ↩ Result (${block.name}):`, text.slice(0, 300) + (text.length > 300 ? "…" : ""));
      } catch (err) {
        toolResult = JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
        console.error(`\n   ❌ Tool error (${block.name}):`, toolResult);
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: toolResult,
      });
    }

    // Feed the tool results back to Claude for the next iteration
    messages.push({ role: "user", content: toolResults });
  }

  if (iteration >= MAX_ITERATIONS) {
    console.warn("\n⚠️  Max iterations reached — agent loop stopped.");
  }

  await mcpClient.close();
}

run().catch((err) => {
  console.error("\n❌ Fatal error:", err);
  process.exit(1);
});
