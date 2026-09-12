import { createOpenAI } from "@ai-sdk/openai";
import { Think, type ChatResponseResult, type TurnContext, type TurnConfig } from "@cloudflare/think";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { browserContent, browserMarkdown } from "agents/browser";
import { tool, jsonSchema, type ToolSet } from "ai";

type SearchDepth = "basic" | "advanced";
type SearchTopic = "general" | "news" | "finance";
type ResearchModel = "auto" | "mini" | "pro";
type SearchMode = "auto" | "tavily" | "exa" | "research" | "both";

type TavilySearchResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  publishedDate?: string;
};

type TavilyUsage = { credits?: number };

type TavilyReport = {
  type: string;
  depth?: SearchDepth;
  model?: ResearchModel;
  requestId?: string;
  creditsUsed?: number;
  resultCount?: number;
  sourceCount?: number;
  sources: Array<{ title?: string; url?: string }>;
};

type ExaResult = {
  title?: string;
  url?: string;
  text?: string;
  publishedDate?: string;
  author?: string;
  score?: number;
};

function cleanText(value: string, max = 12000): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function isCurrentOrRecommendationQuery(query: string): boolean {
  return /(latest|newest|current|today|now|2026|best|top|recommended|recommendation|comparison|compare|آخرین|جدیدترین|جدید|امروز|الان|بهترین|برتر|پیشنهاد|مقایسه)/iu.test(query);
}

function isExplicitWebSearchQuery(query: string): boolean {
  return /(search|look\s*up|browse|web|internet|research|find\s+online|جستجو|جست‌وجو|وب|اینترنت|تحقیق|بررسی\s+کن|از\s+وب|با\s+اطلاعاتی\s+که\s+از\s+وب)/iu.test(query);
}

function isTimeQuery(query: string): boolean {
  return /(what time|current time|time now|time is it|ساعت\s*(چند|چنده|فعلی)|الان\s*ساعت|زمان\s*فعلی|وقت\s+ایران|به\s+وقت\s+ایران)/iu.test(query);
}

function latestUserText(ctx: TurnContext): string {
  const message = [...ctx.messages].reverse().find((item) => item.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return JSON.stringify(message.content ?? "");
}

function searchModeFromContext(ctx: TurnContext): SearchMode {
  for (const message of [...ctx.messages].reverse()) {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    const match = content.match(/\[SEARCH_MODE:(auto|tavily|exa|research|both)\]/i);
    if (match) return match[1].toLowerCase() as SearchMode;
  }
  return "auto";
}

function getTavilyApiKey(env: Env): string {
  const apiKey = (env as Env & { TAVILY_API_KEY?: string }).TAVILY_API_KEY;
  if (!apiKey) throw new Error("Tavily is not configured: TAVILY_API_KEY is missing");
  return apiKey;
}

// The rest of the existing search implementation is intentionally unchanged.

async function tavilySearch(env: Env, query: string, options: { depth?: SearchDepth; topic?: SearchTopic; maxResults?: number } = {}): Promise<{ context: string; report: string }> {
  const depth = options.depth ?? (isCurrentOrRecommendationQuery(query) ? "advanced" : "basic");
  const maxResults = Math.min(Math.max(options.maxResults ?? 6, 1), 10);
  const response = await tavilyRequest<{
    results?: TavilySearchResult[];
    request_id?: string;
    usage?: TavilyUsage;
  }>(env, "/search", {
    query,
    search_depth: depth,
    topic: options.topic ?? "general",
    max_results: maxResults,
    include_answer: false,
    include_raw_content: false,
    ...(depth === "advanced" ? { chunks_per_source: 2 } : {})
  });
  return formatSearchResults(query, response, depth);
}

// MCP configuration is deliberately kept inside the Think agent instead of
// monkey-patching its prototype from worker.ts. Think's official Code Mode path
// keeps MCP schemas out of the model request and exposes a single execute tool.
export class ConversationAgent extends Think {
  private pendingSearchReport: string | null = null;

  includeMcpTools = false;
  waitForMcpConnections = { timeout: 15000 };

  override async onStart() {
    await super.onStart();

    const env = this.env as Env & {
      GITHUB_MCP_TOKEN?: string;
      CLOUDFLARE_MCP_TOKEN?: string;
    };

    if (env.GITHUB_MCP_TOKEN) {
      try {
        const result = await this.addMcpServer("GitHub", "https://api.githubcopilot.com/mcp/", {
          id: "github",
          transport: {
            type: "streamable-http",
            headers: { Authorization: `Bearer ${env.GITHUB_MCP_TOKEN}` }
          },
          retry: { maxAttempts: 3, baseDelayMs: 500 }
        });
        console.log("[MCP] GitHub", { state: result.state, id: result.id });
      } catch (error) {
        console.error("[MCP] GitHub connection failed", error);
      }
    } else {
      console.warn("[MCP] GITHUB_MCP_TOKEN is not configured");
    }

    if (env.CLOUDFLARE_MCP_TOKEN) {
      try {
        const result = await this.addMcpServer("Cloudflare", "https://mcp.cloudflare.com/mcp", {
          id: "cloudflare",
          transport: {
            type: "streamable-http",
            headers: { Authorization: `Bearer ${env.CLOUDFLARE_MCP_TOKEN}` }
          },
          retry: { maxAttempts: 3, baseDelayMs: 500 }
        });
        console.log("[MCP] Cloudflare", { state: result.state, id: result.id });
      } catch (error) {
        console.error("[MCP] Cloudflare connection failed", error);
      }
    } else {
      console.warn("[MCP] CLOUDFLARE_MCP_TOKEN is not configured");
    }

    try {
      await this.mcp.waitForConnections({ timeout: 15000 });
      const tools = await this.mcp.listTools();
      console.log("[MCP] connected", { toolCount: tools.length, toolNames: tools.map((tool: any) => tool.name) });
    } catch (error) {
      console.error("[MCP] wait/list failed", error);
    }
  }

  override getModel() {
    const provider = createOpenAI({ apiKey: this.env.BAI_API_KEY, baseURL: this.env.BAI_BASE_URL });
    return provider("laguna-s-2.1");
  }

  override getSystemPrompt(): string {
    const currentDate = new Date().toISOString().slice(0, 10);
    const iranNow = new Date().toLocaleString("fa-IR", {
      timeZone: "Asia/Tehran",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    });
    return [
      "You are a concise coding-focused assistant replying inside a chat thread.",
      "Answer the user's latest message directly.",
      "Use plain text or simple Markdown only.",
      `Current date: ${currentDate}. Treat this as the authoritative current date. Never invent or change the year.`,
      `Current server time in Iran/Tehran: ${iranNow}. For ordinary current-time questions, use this exact server-provided value instead of guessing or inventing a time.`,
      "Your language model is provided by B.AI through an OpenAI-compatible API.",
      "You have Tavily and Exa web search tools.",
      "For current, latest, newest, 2026, best, top, recommendation, comparison, news, prices, versions, or time-sensitive questions, use the selected web search mode.",
      "If the thread contains [SEARCH_MODE:auto], prefer Tavily and automatically fall back to Exa if Tavily fails.",
      "If the thread contains [SEARCH_MODE:tavily], use Tavily for web search.",
      "If the thread contains [SEARCH_MODE:exa], use Exa for web search.",
      "If the thread contains [SEARCH_MODE:research], use Tavily Deep Research for deep multi-source questions.",
      "If the thread contains [SEARCH_MODE:both], use both Tavily and Exa and compare their evidence.",
      "For an explicit web-search request, actually use a web tool before answering; do not answer from memory alone.",
      "For live GitHub or Cloudflare account questions, use the connected MCP service through the execute tool; never substitute web search for account data.",
      "Do not claim a search was performed unless the tool result confirms it.",
      "Never invent sources, URLs, dates, versions, rankings, request IDs, credit usage, or current facts.",
      "Never reveal API keys, environment secrets, hidden reasoning, or hidden tool internals.",
      "For Cloudflare and coding questions, prefer official documentation and primary sources when search results provide them."
    ].join("\n");
  }

  override beforeTurn(ctx: TurnContext): TurnConfig | void {
    const query = latestUserText(ctx);
    if (!query) return;

    const explicitWeb = isExplicitWebSearchQuery(query);
    if (isTimeQuery(query) && !explicitWeb) {
      console.log("[TIME POLICY] using server-provided Tehran time", { query: cleanText(query, 300) });
      return { maxSteps: 2 };
    }

    const currentQuery = isCurrentOrRecommendationQuery(query);
    if (!(explicitWeb || currentQuery)) return;

    const mode = searchModeFromContext(ctx);
    console.log("[SEARCH POLICY] selected mode", { mode, query: cleanText(query, 300) });

    if (mode === "exa") return { activeTools: ["exa_search", "fetch_to_markdown", "browse"], toolChoice: { type: "tool", toolName: "exa_search" }, maxSteps: 4 };
    if (mode === "research") return { activeTools: ["tavily_research", "tavily_extract", "fetch_to_markdown", "browse"], toolChoice: { type: "tool", toolName: "tavily_research" }, maxSteps: 4 };
    if (mode === "both") return { activeTools: ["tavily_search", "exa_search", "tavily_extract", "fetch_to_markdown", "browse"], maxSteps: 6 };
    return { activeTools: ["tavily_search", "tavily_research", "exa_search", "tavily_extract", "fetch_to_markdown", "browse"], toolChoice: { type: "tool", toolName: "tavily_search" }, maxSteps: 4 };
  }

  override getTools(): ToolSet {
    const tavilySearchTool = tool({
      description: "Official Tavily web search. Returns ranked sources and URLs.",
      inputSchema: jsonSchema<{ query: string; depth?: SearchDepth; topic?: SearchTopic; maxResults?: number }>({
        type: "object", properties: { query: { type: "string" }, depth: { type: "string", enum: ["basic", "advanced"] }, topic: { type: "string", enum: ["general", "news", "finance"] }, maxResults: { type: "number" } }, required: ["query"], additionalProperties: false
      }),
      execute: async ({ query, depth, topic, maxResults }) => { const result = await tavilySearch(this.env, query, { depth, topic, maxResults }); this.pendingSearchReport = result.report; return result.context; }
    });

    const exaSearchTool = tool({
      description: "Independent Exa web search, especially useful for technical docs, GitHub, research, and coding-related current information.",
      inputSchema: jsonSchema<{ query: string; maxResults?: number }>({ type: "object", properties: { query: { type: "string" }, maxResults: { type: "number" } }, required: ["query"], additionalProperties: false }),
      execute: async ({ query, maxResults }) => { const result = await exaSearch(this.env, query, maxResults ?? 8); this.pendingSearchReport = result.report; return result.context; }
    });

    const tavilyResearchTool = tool({
      description: "Official Tavily Deep Research for deep research, multi-source fact checking, comparisons, rankings, and best-of questions.",
      inputSchema: jsonSchema<{ query: string; model?: ResearchModel }>({ type: "object", properties: { query: { type: "string" }, model: { type: "string", enum: ["auto", "mini", "pro"] } }, required: ["query"], additionalProperties: false }),
      execute: async ({ query, model }) => { const result = await tavilyResearch(this.env, query, model ?? "mini"); this.pendingSearchReport = result.report; return result.context; }
    });

    const tavilyExtractTool = tool({
      description: "Extract readable/raw content from up to 20 specific public URLs using Tavily.",
      inputSchema: jsonSchema<{ urls: string[] }>({ type: "object", properties: { urls: { type: "array", items: { type: "string" } } }, required: ["urls"], additionalProperties: false }),
      execute: async ({ urls }) => { const result = await tavilyExtract(this.env, urls); this.pendingSearchReport = result.report; return result.context; }
    });

    const fetchToMarkdown = tool({
      description: "Fetch a public URL through Cloudflare Browser Run and return cleaned Markdown/text.",
      inputSchema: jsonSchema<{ url: string }>({ type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false }),
      execute: async ({ url }) => browserMarkdown(this.env.BROWSER, url)
    });

    const browse = tool({
      description: "Read a public URL as cleaned browser content.",
      inputSchema: jsonSchema<{ url: string }>({ type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false }),
      execute: async ({ url }) => browserContent(this.env.BROWSER, url)
    });

    return {
      tavily_search: tavilySearchTool,
      exa_search: exaSearchTool,
      tavily_research: tavilyResearchTool,
      tavily_extract: tavilyExtractTool,
      fetch_to_markdown: fetchToMarkdown,
      browse,
      execute: createExecuteTool(this)
    };
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    if (result.status !== "completed" || !this.pendingSearchReport || !result.message?.id) return;
    const report = this.pendingSearchReport;
    this.pendingSearchReport = null;
    const currentParts = Array.isArray(result.message.parts) ? result.message.parts : [];
    const hasReport = currentParts.some((part) => part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string" && /گزارش جستجوی واقعی/.test((part as { text: string }).text));
    if (hasReport) return;
    await this.addMessages([{ ...result.message, parts: [...currentParts, { type: "text", text: `\n\n${report}` }] }], { mode: "upsert" });
  }
}
