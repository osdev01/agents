import { Think } from "@cloudflare/think";
import { jsonSchema, tool } from "ai";

const mod = await import("./index");

const ConversationAgentClass = mod.ConversationAgent;

const originalGetTools = ConversationAgentClass.prototype.getTools;
const originalBeforeTurn = ConversationAgentClass.prototype.beforeTurn;

function isLiveServiceQuery(query: string): boolean {
  return /(github|git hub|pull request|pull requests|issue|issues|repository|repo|commit|branch|cloudflare|worker|workers|durable object|pages|dns|zone|account|گیت.?هاب|پول.?ریکوئست|ایشیو|ریپازیتوری|کامیت|برنچ|کلودفلر|ورکر|دامین|زون|اکانت)/iu.test(query);
}

function latestUserText(ctx: any): string {
  const message = [...(ctx.messages ?? [])].reverse().find((item: any) => item.role === "user");
  if (!message) return "";
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
}

function mcpConfig(env: any) {
  return [
    ["GitHub", "https://api.githubcopilot.com/mcp/", env.GITHUB_MCP_TOKEN, "github"],
    ["Cloudflare", "https://mcp.cloudflare.com/mcp", env.CLOUDFLARE_MCP_TOKEN, "cloudflare"],
  ] as const;
}

ConversationAgentClass.prototype.onStart = async function (this: any, ...args: any[]) {
  // IMPORTANT: do not call ConversationAgent.onStart(). Its current implementation
  // performs blocking MCP registration and can prevent Telegram/model startup.
  // Call the base Think lifecycle only, then register MCP in the background.
  await (Think.prototype as any).onStart.apply(this, args);

  for (const [name, url, token, id] of mcpConfig(this.env)) {
    if (!token) {
      console.warn(`[MCP] ${name} token is not configured`);
      continue;
    }

    void this.addMcpServer(name, url, {
      id,
      transport: {
        type: "streamable-http",
        headers: { Authorization: `Bearer ${token}` },
      },
      retry: { maxAttempts: 2, baseDelayMs: 500 },
    })
      .then((result: any) => console.log(`[MCP] ${name} registered`, { id, state: result?.state, resultId: result?.id }))
      .catch((error: unknown) => console.error(`[MCP] ${name} registration failed`, error));
  }
};

ConversationAgentClass.prototype.getTools = function (this: any) {
  const tools = { ...(originalGetTools.call(this) as any) };
  delete tools.execute;

  tools.mcp_diagnose = tool({
    description: "Diagnose outbound connectivity and authentication to the configured GitHub and Cloudflare MCP HTTP endpoints. Use this when MCP tools are unavailable or failing. Returns HTTP status and a short response excerpt, never the token.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false
    }),
    execute: async () => {
      const results = [];
      for (const [name, url, token, id] of mcpConfig(this.env)) {
        if (!token) {
          results.push({ id, name, configured: false, error: "token not configured" });
          continue;
        }
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "MCP-Protocol-Version": "2026-07-28",
              "Mcp-Method": "server/discover",
              "Mcp-Name": "server/discover",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "server/discover",
              params: {},
            }),
          });
          const text = (await response.text()).replace(/\s+/g, " ").slice(0, 600);
          results.push({ id, name, configured: true, httpStatus: response.status, ok: response.ok, contentType: response.headers.get("content-type"), response: text });
        } catch (error: any) {
          results.push({ id, name, configured: true, networkError: String(error?.message ?? error) });
        }
      }
      return { results };
    }
  });

  tools.mcp_search = tool({
    description: "Search the connected GitHub or Cloudflare MCP tool catalog. Use this before mcp_execute when you need live GitHub or Cloudflare data. Returns matching tool names, descriptions, server IDs, and input schemas.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "What live GitHub or Cloudflare operation is needed" },
        server: { type: "string", enum: ["github", "cloudflare"] }
      },
      required: ["query"],
      additionalProperties: false
    }),
    execute: async ({ query, server }: { query: string; server?: string }) => {
      await this.mcp.waitForConnections({ timeout: 15000 });
      const all = await this.mcp.listTools();
      const filtered = server ? all.filter((item: any) => String(item.serverId).toLowerCase() === server.toLowerCase()) : all;
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = filtered.map((item: any) => {
        const haystack = [item.serverId, item.name, item.title, item.description].filter(Boolean).join(" ").toLowerCase();
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        return { item, score };
      }).filter((entry: any) => entry.score > 0).sort((a: any, b: any) => b.score - a.score).slice(0, 12);
      const matches = (scored.length ? scored : filtered.slice(0, 12)).map((entry: any) => {
        const item = entry.item;
        return {
          serverId: item.serverId,
          name: item.name,
          title: item.title ?? item.annotations?.title ?? item.name,
          description: item.description ?? "",
          inputSchema: item.inputSchema
        };
      });
      return { query, server: server ?? null, count: matches.length, matches };
    }
  });

  tools.mcp_execute = tool({
    description: "Execute one discovered GitHub or Cloudflare MCP tool using the exact serverId, name, and JSON arguments returned by mcp_search.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        serverId: { type: "string", description: "MCP server ID returned by mcp_search" },
        name: { type: "string", description: "Exact MCP tool name returned by mcp_search" },
        arguments: { type: "object", description: "Arguments matching the selected MCP tool input schema", additionalProperties: true }
      },
      required: ["serverId", "name", "arguments"],
      additionalProperties: false
    }),
    execute: async ({ serverId, name, arguments: args }: { serverId: string; name: string; arguments: Record<string, unknown> }) => {
      await this.mcp.waitForConnections({ timeout: 15000 });
      const available = await this.mcp.listTools();
      const selected = available.find((item: any) => item.serverId === serverId && item.name === name);
      if (!selected) throw new Error(`MCP tool not found: ${serverId}/${name}. Run mcp_search again.`);
      return await this.mcp.callTool({ serverId, name, arguments: args });
    }
  });

  return tools;
};

ConversationAgentClass.prototype.beforeTurn = async function (this: any, ctx: any) {
  const base = originalBeforeTurn ? await originalBeforeTurn.call(this, ctx) : undefined;
  const query = latestUserText(ctx);
  if (!isLiveServiceQuery(query)) return base;
  return {
    ...(base ?? {}),
    activeTools: ["mcp_diagnose", "mcp_search", "mcp_execute"],
    maxSteps: Math.max((base as any)?.maxSteps ?? 6, 6)
  };
};

export const ConversationAgent = ConversationAgentClass;
export const ThinkMessengerStateAgent = mod.ThinkMessengerStateAgent;
export const getIngressAgentName = mod.getIngressAgentName;
export const ChatIngressAgent = mod.ChatIngressAgent;
export default mod.default;
