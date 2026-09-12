import { jsonSchema, tool } from "ai";

const mod = await import("./index");

const ConversationAgent = mod.ConversationAgent;

const originalGetTools = ConversationAgent.prototype.getTools;
const originalBeforeTurn = ConversationAgent.prototype.beforeTurn;

function isLiveServiceQuery(query: string): boolean {
  return /(github|git hub|pull request|pull requests|issue|issues|repository|repo|commit|branch|cloudflare|worker|workers|durable object|pages|dns|zone|account|گیت.?هاب|پول.?ریکوئست|ایشیو|ریپازیتوری|کامیت|برنچ|کلودفلر|ورکر|دامین|زون|اکانت)/iu.test(query);
}

function latestUserText(ctx: any): string {
  const message = [...(ctx.messages ?? [])].reverse().find((item: any) => item.role === "user");
  if (!message) return "";
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
}

ConversationAgent.prototype.getTools = function () {
  const tools = { ...(originalGetTools.call(this) as any) };
  delete tools.execute;

  tools.mcp_search = tool({
    description: "Search the connected GitHub or Cloudflare MCP tool catalog. Use this before mcp_execute when you need live GitHub or Cloudflare data. Returns matching tool names, descriptions, server IDs, and input schemas.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { query: { type: "string", description: "What live GitHub or Cloudflare operation is needed" } },
      required: ["query"],
      additionalProperties: false
    }),
    execute: async ({ query }: { query: string }) => {
      const all = this.mcp.listTools();
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = all.map((item: any) => {
        const haystack = [item.name, item.title, item.description].filter(Boolean).join(" ").toLowerCase();
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        return { item, score };
      }).filter((entry: any) => entry.score > 0).sort((a: any, b: any) => b.score - a.score).slice(0, 12);
      const matches = (scored.length ? scored : all.slice(0, 12)).map(({ item }: any) => ({
        serverId: item.serverId,
        name: item.name,
        title: item.title ?? item.annotations?.title ?? item.name,
        description: item.description ?? "",
        inputSchema: item.inputSchema
      }));
      return { query, count: matches.length, matches };
    }
  });

  tools.mcp_execute = tool({
    description: "Execute one discovered GitHub or Cloudflare MCP tool using the exact serverId, tool name, and JSON arguments returned by mcp_search.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        serverId: { type: "string", description: "MCP server ID returned by mcp_search, usually github or cloudflare" },
        name: { type: "string", description: "Exact MCP tool name returned by mcp_search" },
        arguments: { type: "object", description: "Arguments matching the selected MCP tool input schema", additionalProperties: true }
      },
      required: ["serverId", "name", "arguments"],
      additionalProperties: false
    }),
    execute: async ({ serverId, name, arguments: args }: { serverId: string; name: string; arguments: Record<string, unknown> }) => {
      const result = await this.mcp.callTool({ serverId, name, arguments: args });
      return result;
    }
  });

  return tools;
};

ConversationAgent.prototype.beforeTurn = async function (ctx: any) {
  const base = originalBeforeTurn ? await originalBeforeTurn.call(this, ctx) : undefined;
  const query = latestUserText(ctx);
  if (!isLiveServiceQuery(query)) return base;
  return {
    ...(base ?? {}),
    activeTools: ["mcp_search", "mcp_execute"],
    maxSteps: Math.max((base as any)?.maxSteps ?? 6, 6)
  };
};

export const ConversationAgent = ConversationAgent;
export const ThinkMessengerStateAgent = mod.ThinkMessengerStateAgent;
export const getIngressAgentName = mod.getIngressAgentName;
export const ChatIngressAgent = mod.ChatIngressAgent;
export default mod.default;
