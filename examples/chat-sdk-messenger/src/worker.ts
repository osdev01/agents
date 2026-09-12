export { CodemodeRuntime } from "agents/browser";

const mod = await import("./index");

const conversationPrototype = mod.ConversationAgent.prototype as any;

// Keep MCP connections available without automatically injecting every MCP
// schema into every model request. Some OpenAI-compatible providers reject
// large/complex tool payloads even for ordinary messages.
conversationPrototype.waitForMcpConnections = { timeout: 15000 };
conversationPrototype.includeMcpTools = false;

const originalOnStart = conversationPrototype.onStart;
conversationPrototype.onStart = async function () {
  await originalOnStart?.call(this);

  console.log("[MCP] configuration", {
    githubConfigured: Boolean(this.env?.GITHUB_MCP_TOKEN),
    cloudflareConfigured: Boolean(this.env?.CLOUDFLARE_MCP_TOKEN)
  });

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
      console.log("[MCP] GitHub ready", { state: result.state });
    } catch (error) {
      console.error("[MCP] GitHub registration/discovery failed", error);
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
      console.log("[MCP] Cloudflare ready", { state: result.state });
    } catch (error) {
      console.error("[MCP] Cloudflare registration/discovery failed", error);
    }
  } else {
    console.log("[MCP] Cloudflare skipped: CLOUDFLARE_MCP_TOKEN is not configured");
  }

  try {
    await this.mcp.waitForConnections({ timeout: 15000 });
    const servers = this.getMcpServers?.() ?? [];
    const tools = await this.mcp.listTools();
    console.log("[MCP] startup state", {
      servers: servers.map((server: any) => ({ id: server.id, name: server.name, state: server.state, error: server.error ?? null })),
      toolCount: tools.length,
      toolNames: tools.map((tool: any) => tool.name)
    });
  } catch (error) {
    console.error("[MCP] startup wait/list failed", error);
  }
};

const originalBeforeTurn = conversationPrototype.beforeTurn;
conversationPrototype.beforeTurn = async function (ctx: any) {
  const config = (await originalBeforeTurn?.call(this, ctx)) ?? {};

  const serviceQuery = [...(ctx.messages ?? [])]
    .reverse()
    .find((message: any) => message.role === "user");
  const userText = typeof serviceQuery?.content === "string"
    ? serviceQuery.content
    : JSON.stringify(serviceQuery?.content ?? "");

  const liveServiceRequest = /\b(last|latest|current|recent|status|deploy|deployment|build|worker|workers|logs?|cloudflare|github|repository|repo|pull request|commit|issue|dns|r2|d1|kv)\b/i.test(userText)
    || /(آخرین|وضعیت|دیپلوی|استقرار|لاگ|ورکر|گیت‌هاب|گیتهاب|ریپو|مخزن|کامیت|ایشو|کلودفلر)/iu.test(userText);

  // Do not materialize MCP tools for ordinary turns. This keeps normal
  // messages compatible with providers that have strict request-body/tool
  // schema handling.
  if (!liveServiceRequest) return config;

  // Explicitly materialize only the MCP tools needed for live GitHub/Cloudflare
  // requests. Cloudflare Think documents getAITools() as the supported explicit
  // escape hatch when includeMcpTools is disabled.
  const mcpTools = this.mcp.getAITools({
    serverId: ["github", "cloudflare"]
  });
  const mcpToolNames = Object.keys(mcpTools);

  console.log("[MCP] live-request tools", {
    query: userText.slice(0, 300),
    toolCount: mcpToolNames.length,
    toolNames: mcpToolNames
  });

  const serviceInstruction = "\n\nLIVE SERVICE POLICY: This request concerns live GitHub/Cloudflare data. Use a matching connected MCP tool from the tools supplied for this turn before answering. Do not substitute Tavily or Exa for live account data. If no matching MCP tool is available or the MCP call fails, say so clearly and do not guess.";

  if (!mcpToolNames.length) {
    console.error("[MCP] live service request has no MCP tools", {
      query: userText.slice(0, 300)
    });
    return {
      ...config,
      activeTools: [],
      toolChoice: "none",
      maxSteps: 1,
      system: `${config.system ?? ctx.system ?? ""}${serviceInstruction}\n\nMCP ERROR: No GitHub/Cloudflare MCP tools were available in this turn.`
    };
  }

  return {
    ...config,
    tools: {
      ...(config.tools ?? {}),
      ...mcpTools
    },
    activeTools: mcpToolNames,
    toolChoice: "auto",
    maxSteps: Math.max(config.maxSteps ?? 1, 4),
    system: `${config.system ?? ctx.system ?? ""}${serviceInstruction}`
  };
};

export const ConversationAgent = mod.ConversationAgent;
export const ThinkMessengerStateAgent = mod.ThinkMessengerStateAgent;
export const getIngressAgentName = mod.getIngressAgentName;
export const ChatIngressAgent = mod.ChatIngressAgent;
export default mod.default;
