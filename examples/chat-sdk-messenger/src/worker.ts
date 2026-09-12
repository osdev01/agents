export { CodemodeRuntime } from "agents/browser";

const mod = await import("./index");

// The current Think runtime is exposing the Tavily tools correctly but the
// Exa tool is disappearing from the final model tool set. For Exa mode we
// therefore execute Exa directly in beforeTurn and give the returned evidence
// to the model as part of the turn system context. This removes the failing
// model -> exa_search tool-call hop entirely while keeping the existing
// Tavily/tool-based modes unchanged.
const conversationPrototype = mod.ConversationAgent.prototype as any;
const originalBeforeTurn = conversationPrototype.beforeTurn;

conversationPrototype.beforeTurn = async function (ctx: any) {
  const config = (await originalBeforeTurn?.call(this, ctx)) ?? {};
  const activeTools = Array.isArray(config.activeTools) ? config.activeTools : [];
  const exaMode = activeTools.includes("exa_search") && config.toolChoice?.type === "tool" && config.toolChoice?.toolName === "exa_search";

  if (!exaMode || ctx.continuation) {
    return config;
  }

  const apiKey = this.env?.EXA_API_KEY;
  if (!apiKey) {
    console.error("[EXA] EXA_API_KEY is missing");
    return {
      ...config,
      system: `${ctx.system}\n\nEXA ERROR: EXA_API_KEY is missing in the Worker environment.`,
      activeTools: [],
      toolChoice: "none",
      maxSteps: 1
    };
  }

  const userMessage = [...(ctx.messages ?? [])].reverse().find((message: any) => message.role === "user");
  const query = typeof userMessage?.content === "string"
    ? userMessage.content.trim()
    : JSON.stringify(userMessage?.content ?? "").trim();

  if (!query) return config;

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
        system: `${ctx.system}\n\nEXA SEARCH ERROR: HTTP ${response.status}\n${raw.slice(0, 2000)}`,
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
      `Provider: Exa`,
      `Query: ${query}`,
      `Result count: ${results.length}`,
      evidence || "No results returned by Exa.",
      "===== END EXA DIRECT SEARCH RESULT =====",
      "Use the Exa evidence above to answer the user. Do not claim Exa was unavailable. Do not invent URLs or facts not present in the evidence."
    ].join("\n");

    console.log("[EXA DIRECT] success", { resultCount: results.length });

    return {
      ...config,
      system: `${ctx.system}${exaContext}`,
      activeTools: [],
      toolChoice: "none",
      maxSteps: 1
    };
  } catch (error) {
    console.error("[EXA DIRECT] request failed", error);
    return {
      ...config,
      system: `${ctx.system}\n\nEXA SEARCH ERROR: ${String(error).slice(0, 2000)}`,
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
