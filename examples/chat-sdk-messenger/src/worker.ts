export { CodemodeRuntime } from "agents/browser";

const mod = await import("./index");

const conversationPrototype = mod.ConversationAgent.prototype as any;

// Connect external services through Cloudflare Agents MCP. Credentials stay in
// Worker secrets; MCP registrations persist in Agent SQL storage.
const originalOnStart = conversationPrototype.onStart;
conversationPrototype.onStart = async function () {
  await originalOnStart?.call(this);

  // Think must wait until MCP discovery has completed before inference.
  this.waitForMcpConnections = { timeout: 15000 };

  const githubToken = this.env?.GITHUB_MCP_TOKEN;
  if (githubToken) {
    try {
      const result = await this.addMcpServer("GitHub", "https://api.githubcopilot.com/mcp/", {
        id: "github",
        transport: {
          type: "streamable-http",
          headers: { Authorization: `Bearer ${githubToken}` }
        },
        retry: { maxAttempts: 3, baseDelayMs: 500 }
      });
      console.log("[MCP] GitHub connection", result);
    } catch (error) {
      console.error("[MCP] GitHub connection failed", error);
    }
  } else {
    console.log("[MCP] GitHub skipped: GITHUB_MCP_TOKEN is not configured");
  }

  const cloudflareToken = this.env?.CLOUDFLARE_MCP_TOKEN;
  if (cloudflareToken) {
    try {
      const result = await this.addMcpServer("Cloudflare API", "https://mcp.cloudflare.com/mcp", {
        id: "cloudflare",
        transport: {
          type: "streamable-http",
          headers: { Authorization: `Bearer ${cloudflareToken}` }
        },
        retry: { maxAttempts: 3, baseDelayMs: 500 }
      });
      console.log("[MCP] Cloudflare connection", result);
    } catch (error) {
      console.error("[MCP] Cloudflare connection failed", error);
    }
  } else {
    console.log("[MCP] Cloudflare skipped: CLOUDFLARE_MCP_TOKEN is not configured");
  }
};

const originalBeforeTurn = conversationPrototype.beforeTurn;
conversationPrototype.beforeTurn = async function (ctx: any) {
  const config = (await originalBeforeTurn?.call(this, ctx)) ?? {};

  // IMPORTANT: activeTools alone does not expose MCP tools. Explicitly inject
  // the AI SDK ToolSet returned by getAITools(), using the namespaced keys.
  // This avoids the previous bug where raw listTools() names were added to
  // activeTools but the actual MCP tools were absent from the model ToolSet.
  let mcpTools: Record<string, any> = {};
  try {
    mcpTools = this.mcp?.getAITools?.() ?? {};
  } catch (error) {
    console.error("[MCP] getAITools failed", error);
  }

  const mcpToolNames = Object.keys(mcpTools);
  const activeTools = Array.isArray(config.activeTools)
    ? [...new Set([...config.activeTools, ...mcpToolNames])]
    : config.activeTools;

  const serviceQuery = [...(ctx.messages ?? [])]
    .reverse()
    .find((message: any) => message.role === "user");
  const userText = typeof serviceQuery?.content === "string"
    ? serviceQuery.content
    : JSON.stringify(serviceQuery?.content ?? "");
  const liveServiceRequest = /\b(last|latest|current|recent|status|deploy|deployment|build|worker|workers|logs?|cloudflare|github|repository|repo|pull request|commit|issue|dns|r2|d1|kv)\b/i.test(userText);

  const serviceInstruction = liveServiceRequest
    ? "\n\nLIVE SERVICE POLICY: This request concerns live GitHub/Cloudflare/account data. You MUST use the appropriate connected MCP tool before answering. Do not use Tavily, Exa, or general web search as a substitute. If no matching MCP tool is available or the MCP call fails, state that clearly and do not guess or fabricate current data."
    : "";

  const mergedTools = { ...(config.tools ?? {}), ...mcpTools };

  const exaMode = Array.isArray(config.activeTools)
    && config.activeTools.includes("exa_search")
    && config.toolChoice?.type === "tool"
    && config.toolChoice?.toolName === "exa_search";

  if (!exaMode || ctx.continuation) {
    return {
      ...config,
      tools: mergedTools,
      activeTools,
      system: `${config.system ?? ctx.system ?? ""}${serviceInstruction}`
    };
  }

  // Keep the existing reliable direct Exa path. MCP tools remain available on
  // normal turns and are not used as a replacement for Exa mode.
  const apiKey = this.env?.EXA_API_KEY;
  if (!apiKey) {
    console.error("[EXA] EXA_API_KEY is missing");
    return {
      ...config,
      tools: mergedTools,
      activeTools: [],
      toolChoice: "none",
      maxSteps: 1,
      system: `${config.system ?? ctx.system ?? ""}\n\nEXA ERROR: EXA_API_KEY is missing in the Worker environment.`
    };
  }

  const query = userText.trim();
  if (!query) return { ...config, tools: mergedTools, activeTools };

  console.log("[EXA DIRECT] search", { query: query.slice(0, 300) });

  try {
    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: 5,
        contents: { highlights: true, text: true }
      })
    });

    const raw = await response.text();
    if (!response.ok) {
      console.error("[EXA DIRECT] HTTP error", response.status, raw.slice(0, 1000));
      return {
        ...config,
        tools: mergedTools,
        system: `${config.system ?? ctx.system ?? ""}\n\nEXA SEARCH ERROR: HTTP ${response.status}\n${raw.slice(0, 2000)}`,
        activeTools: [],
        toolChoice: "none",
        maxSteps: 1
      };
    }

    const data = JSON.parse(raw) as {
      results?: Array<{
        title?: string;
        url?: string;
        text?: string;
        highlights?: string[];
        publishedDate?: string;
        author?: string;
      }>;
    };

    const results = data.results ?? [];
    const evidence = results.map((result, index) => [
      `${index + 1}. ${result.title ?? "Untitled"}`,
      `URL: ${result.url ?? ""}`,
      result.publishedDate ? `PUBLISHED: ${result.publishedDate}` : "",
      result.author ? `AUTHOR: ${result.author}` : "",
      result.highlights?.length ? `HIGHLIGHTS: ${result.highlights.join(" ")}` : "",
      result.text ? `TEXT: ${result.text.slice(0, 5000)}` : ""
    ].filter(Boolean).join("\n")).join("\n\n");

    const exaContext = [
      "\n\n===== EXA DIRECT SEARCH RESULT =====",
      "Provider: Exa",
      `Query: ${query}`,
      `Result count: ${results.length}`,
      evidence || "No results returned by Exa.",
      "===== END EXA DIRECT SEARCH RESULT =====",
      "Use the Exa evidence above to answer the user. Do not claim Exa was unavailable. Do not invent URLs or facts not present in the evidence."
    ].join("\n");

    console.log("[EXA DIRECT] success", { resultCount: results.length });

    return {
      ...config,
      tools: mergedTools,
      system: `${config.system ?? ctx.system ?? ""}${exaContext}`,
      activeTools: [],
      toolChoice: "none",
      maxSteps: 1
    };
  } catch (error) {
    console.error("[EXA DIRECT] request failed", error);
    return {
      ...config,
      tools: mergedTools,
      system: `${config.system ?? ctx.system ?? ""}\n\nEXA SEARCH ERROR: ${String(error).slice(0, 2000)}`,
      activeTools: [],
      toolChoice: "none",
      maxSteps: 1
    };
  }
};

export const ConversationAgent = mod.ConversationAgent;
export const ThinkMessengerStateAgent = mod.ThinkMessengerStateAgent;
export const getIngressAgentName = mod.getIngressAgentName;
export const ChatIngressAgent = mod.ChatIngressAgent;
export default mod.default;
