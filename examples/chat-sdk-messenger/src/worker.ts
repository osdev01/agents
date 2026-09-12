export { CodemodeRuntime } from "agents/browser";

const mod = await import("./index");

const conversationPrototype = mod.ConversationAgent.prototype as any;

// MCP is assembled by the Think harness. Register external MCP servers once
// during Agent startup and let Think expose their tools automatically.
const originalOnStart = conversationPrototype.onStart;
conversationPrototype.onStart = async function () {
  this.waitForMcpConnections = { timeout: 15000 };
  this.includeMcpTools = true;

  await originalOnStart?.call(this);

  const githubToken = this.env?.GITHUB_MCP_TOKEN;
  if (githubToken && !this.__externalMcpRegistered?.github) {
    try {
      await this.addMcpServer("GitHub", "https://api.githubcopilot.com/mcp/", {
        id: "github",
        transport: {
          type: "streamable-http",
          headers: { Authorization: `Bearer ${githubToken}` }
        },
        retry: { maxAttempts: 3, baseDelayMs: 500 }
      });
      this.__externalMcpRegistered = {
        ...(this.__externalMcpRegistered ?? {}),
        github: true
      };
      console.log("[MCP] GitHub registered");
    } catch (error) {
      console.error("[MCP] GitHub registration failed", error);
    }
  } else if (!githubToken) {
    console.log("[MCP] GitHub skipped: GITHUB_MCP_TOKEN is not configured");
  }

  const cloudflareToken = this.env?.CLOUDFLARE_MCP_TOKEN;
  if (cloudflareToken && !this.__externalMcpRegistered?.cloudflare) {
    try {
      await this.addMcpServer("Cloudflare API", "https://mcp.cloudflare.com/mcp", {
        id: "cloudflare",
        transport: {
          type: "streamable-http",
          headers: { Authorization: `Bearer ${cloudflareToken}` }
        },
        retry: { maxAttempts: 3, baseDelayMs: 500 }
      });
      this.__externalMcpRegistered = {
        ...(this.__externalMcpRegistered ?? {}),
        cloudflare: true
      };
      console.log("[MCP] Cloudflare registered");
    } catch (error) {
      console.error("[MCP] Cloudflare registration failed", error);
    }
  } else if (!cloudflareToken) {
    console.log("[MCP] Cloudflare skipped: CLOUDFLARE_MCP_TOKEN is not configured");
  }
};

// Do not call this.mcp.getAITools() here. Think merges MCP tools into ctx.tools
// before beforeTurn() and converts them to AI SDK tools itself. Manual injection
// caused duplicate/inconsistent tool names and made activeTools unreliable.
const originalBeforeTurn = conversationPrototype.beforeTurn;
conversationPrototype.beforeTurn = async function (ctx: any) {
  const config = (await originalBeforeTurn?.call(this, ctx)) ?? {};
  const toolNames = Object.keys(ctx?.tools ?? {});
  const mcpToolNames = toolNames.filter((name) =>
    /github|cloudflare|mcp|codemode|tool_/i.test(name)
  );

  console.log("[MCP] assembled tool count", toolNames.length);
  console.log("[MCP] assembled service tools", mcpToolNames);

  const serviceQuery = [...(ctx.messages ?? [])]
    .reverse()
    .find((message: any) => message.role === "user");
  const userText = typeof serviceQuery?.content === "string"
    ? serviceQuery.content
    : JSON.stringify(serviceQuery?.content ?? "");
  const liveServiceRequest = /\b(last|latest|current|recent|status|deploy|deployment|build|worker|workers|logs?|cloudflare|github|repository|repo|pull request|commit|issue|dns|r2|d1|kv)\b/i.test(userText)
    || /(آخرین|وضعیت|دیپلوی|استقرار|لاگ|ورکر|گیت‌هاب|گیتهاب|ریپو|مخزن|کامیت|ایشو|کلودفلر)/iu.test(userText);

  const serviceInstruction = liveServiceRequest
    ? "\n\nLIVE SERVICE POLICY: This request concerns live GitHub/Cloudflare data. Use a matching connected MCP tool from the assembled tools before answering. Do not substitute Tavily or Exa for live account data. If no matching MCP tool is available or the MCP call fails, say so clearly and do not guess."
    : "";

  return {
    ...config,
    system: `${config.system ?? ctx.system ?? ""}${serviceInstruction}`
  };
};

export const ConversationAgent = mod.ConversationAgent;
export const ThinkMessengerStateAgent = mod.ThinkMessengerStateAgent;
export const getIngressAgentName = mod.getIngressAgentName;
export const ChatIngressAgent = mod.ChatIngressAgent;
export default mod.default;
