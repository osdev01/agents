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

ConversationAgentClass.prototype.getTools = function () {
  const tools = { ...(originalGetTools.call(this) as any) };
  delete tools.execute;

  tools.mcp_search = tool({
    description: "Discover live tools on the connected GitHub or Cloudflare MCP servers. This is the required first step for GitHub/Cloudflare requests. Search the MCP catalog, then call mcp_execute with the exact serverId, name, and arguments returned here.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "The user's live GitHub or Cloudflare task, expressed as a tool-discovery query" },
        server: { type: "string", enum: ["github", "cloudflare"] }
      },
      required: ["query"],
      additionalProperties: false
    }),
    execute: async ({ query, server }: { query: string; server?: string }) => {
      await this.mcp.waitForConnections({ timeout: 15000 });
      const all = await this.mcp.listTools();
      const filtered = server
        ? all.filter((item: any) => String(item.serverId).toLowerCase() === server.toLowerCase())
        : all;
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
      return {
        query,
        server: server ?? null,
        count: matches.length,
        matches,
        connectedServers: Object.entries(this.getMcpServers().servers).map(([id, value]: [string, any]) => ({ id, name: value.name, state: value.state, error: value.error ?? null }))
      };
    }
  });

  tools.mcp_execute = tool({
    description: "Execute exactly one live GitHub or Cloudflare MCP tool discovered by mcp_search. Never invent a tool name, serverId, or argument shape; use the values returned by mcp_search.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        serverId: { type: "string", description: "Exact MCP server ID returned by mcp_search" },
        name: { type: "string", description: "Exact MCP tool name returned by mcp_search" },
        arguments: { type: "object", description: "JSON arguments matching the selected MCP tool input schema", additionalProperties: true }
      },
      required: ["serverId", "name", "arguments"],
      additionalProperties: false
    }),
    execute: async ({ serverId, name, arguments: args }: { serverId: string; name: string; arguments: Record<string, unknown> }) => {
      await this.mcp.waitForConnections({ timeout: 15000 });
      const available = await this.mcp.listTools();
      const selected = available.find((item: any) => item.serverId === serverId && item.name === name);
      if (!selected) {
        throw new Error(`MCP tool not found: ${serverId}/${name}. Run mcp_search again to refresh the live catalog.`);
      }
      return await this.mcp.callTool({ serverId, name, arguments: args });
    }
  });

  return tools;
};

ConversationAgentClass.prototype.beforeTurn = async function (ctx: any) {
  const base = originalBeforeTurn ? await originalBeforeTurn.call(this, ctx) : undefined;
  const query = latestUserText(ctx);
  if (!isLiveServiceQuery(query)) return base;

  const connected = Object.entries(this.getMcpServers().servers).map(([id, value]: [string, any]) => `${id}:${value.state}${value.error ? ` (${value.error})` : ""}`).join(", ");
  const system = [
    (base as any)?.system ?? ctx.system,
    "LIVE MCP RULE: This request concerns GitHub or Cloudflare. You have live MCP access through mcp_search and mcp_execute.",
    "On the first step, call mcp_search using the user's request. Do not answer from memory or web search when the request asks about the connected GitHub/Cloudflare account.",
    "After mcp_search returns an exact tool and input schema, call mcp_execute with those exact values. Then answer using the live tool result.",
    `Current MCP connection states: ${connected || "none reported"}`
  ].join("\n\n");

  const config: any = {
    ...(base ?? {}),
    system,
    activeTools: ["mcp_search", "mcp_execute"],
    maxSteps: Math.max((base as any)?.maxSteps ?? 6, 6)
  };

  if (!ctx.continuation) {
    config.toolChoice = { type: "tool", toolName: "mcp_search" };
  }

  return config;
};

export const ConversationAgent = ConversationAgentClass;
export const ThinkMessengerStateAgent = mod.ThinkMessengerStateAgent;
export const getIngressAgentName = mod.getIngressAgentName;
export const ChatIngressAgent = mod.ChatIngressAgent;
export default mod.default;
