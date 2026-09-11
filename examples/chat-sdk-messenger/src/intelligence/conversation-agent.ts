import { createOpenAI } from "@ai-sdk/openai";
import { Think, type ChatResponseResult, type TurnContext, type TurnConfig } from "@cloudflare/think";
import { browserContent, browserMarkdown } from "agents/browser";
import { tool, jsonSchema, type ToolSet } from "ai";

type SearchDepth = "basic" | "advanced";
type SearchTopic = "general" | "news" | "finance";
type ResearchModel = "auto" | "mini" | "pro";

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

function getTavilyApiKey(env: Env): string {
  const apiKey = (env as Env & { TAVILY_API_KEY?: string }).TAVILY_API_KEY;
  if (!apiKey) throw new Error("Tavily is not configured: TAVILY_API_KEY is missing");
  return apiKey;
}

async function tavilyRequest<T>(env: Env, path: string, body?: unknown, method: "GET" | "POST" = "POST"): Promise<T> {
  console.log("[TAVILY] request", { path, method });

  const response = await fetch(`https://api.tavily.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getTavilyApiKey(env)}`,
      "Content-Type": "application/json",
      "X-Client-Name": "cloudflare-agents-telegram"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  if (!response.ok) {
    const bodyText = cleanText(await response.text(), 1000);
    console.error("[TAVILY] error", { path, status: response.status });
    throw new Error(`Tavily HTTP ${response.status}: ${bodyText}`);
  }

  const parsed = await response.json() as T;
  const metadata = parsed as T & {
    request_id?: unknown;
    usage?: { credits?: unknown };
  };
  console.log("[TAVILY] response", {
    path,
    status: response.status,
    requestId: metadata.request_id,
    credits: metadata.usage?.credits
  });
  return parsed;
}

function formatWebSearchReport(input: TavilyReport): string {
  const sources = input.sources.filter((source) => source.url).slice(0, 8);
  return [
    "━━━━━━━━━━━━━━",
    "🔎 گزارش جستجوی واقعی Tavily",
    `نوع جستجو: ${input.type}`,
    "Provider: Tavily",
    input.depth ? `عمق جستجو: ${input.depth === "advanced" ? "Advanced" : "Basic"}` : "",
    input.model ? `مدل تحقیق: ${input.model}` : "",
    input.requestId ? `Request ID واقعی Tavily: ${input.requestId}` : "Request ID: دریافت نشد",
    input.creditsUsed !== undefined ? `Credits مصرف‌شده طبق پاسخ Tavily: ${input.creditsUsed}` : "Credits: در پاسخ Tavily گزارش نشد",
    input.resultCount !== undefined ? `تعداد نتایج: ${input.resultCount}` : "",
    input.sourceCount !== undefined ? `تعداد منابع: ${input.sourceCount}` : "",
    sources.length ? "منابع واقعی برگشتی از Tavily:" : "منبع URL قابل نمایش دریافت نشد",
    ...sources.map((source, index) => `${index + 1}. ${source.title || "Source"}\n${source.url}`),
    "━━━━━━━━━━━━━━"
  ].filter(Boolean).join("\n");
}

function formatSearchResults(query: string, response: {
  results?: TavilySearchResult[];
  request_id?: string;
  usage?: TavilyUsage;
}, depth: SearchDepth): { context: string; report: string } {
  const results = response.results ?? [];
  const report = formatWebSearchReport({
    type: "Web Search",
    depth,
    requestId: response.request_id,
    creditsUsed: response.usage?.credits,
    resultCount: results.length,
    sourceCount: results.length,
    sources: results.map((result) => ({ title: result.title, url: result.url }))
  });

  const context = [
    "TAVILY SEARCH RESULT",
    `QUERY: ${query}`,
    `SEARCH DEPTH: ${depth}`,
    response.request_id ? `REQUEST ID: ${response.request_id}` : "REQUEST ID: MISSING",
    response.usage?.credits !== undefined ? `TAVILY CREDITS USED: ${response.usage.credits}` : "TAVILY CREDITS USED: MISSING",
    `RESULT COUNT: ${results.length}`,
    "",
    ...results.map((result, index) => [
      `${index + 1}. ${result.title || result.url || "Untitled result"}`,
      `URL: ${result.url || ""}`,
      result.publishedDate ? `PUBLISHED: ${result.publishedDate}` : "",
      result.content ? `CONTENT: ${cleanText(result.content, 6000)}` : ""
    ].filter(Boolean).join("\n"))
  ].filter(Boolean).join("\n\n");

  return { context, report };
}

async function tavilySearch(
  env: Env,
  query: string,
  options: { depth?: SearchDepth; topic?: SearchTopic; maxResults?: number } = {}
): Promise<{ context: string; report: string }> {
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

function researchContentText(content: unknown): string {
  if (typeof content === "string") return cleanText(content, 24000);
  if (content && typeof content === "object") return JSON.stringify(content, null, 2).slice(0, 24000);
  return "No research report was returned.";
}

function formatResearchResult(query: string, model: ResearchModel, result: {
  status?: string;
  content?: unknown;
  sources?: Array<{ title?: string; url?: string; snippet?: string }>;
  request_id?: string;
}): { context: string; report: string } {
  const sources = result.sources ?? [];
  const report = formatWebSearchReport({
    type: "Deep Research",
    model,
    requestId: result.request_id,
    sourceCount: sources.length,
    sources: sources.map((source) => ({ title: source.title, url: source.url }))
  });
  const context = [
    "TAVILY DEEP RESEARCH REPORT",
    `QUERY: ${query}`,
    `MODEL: ${model}`,
    `STATUS: ${result.status || "completed"}`,
    result.request_id ? `REQUEST ID: ${result.request_id}` : "REQUEST ID: MISSING",
    `SOURCE COUNT: ${sources.length}`,
    "",
    "RESEARCH REPORT",
    researchContentText(result.content),
    "",
    "SOURCES",
    ...sources.slice(0, 20).map((source, index) => `${index + 1}. ${source.title || source.url || "Source"}\nURL: ${source.url || ""}`),
    "",
    "Do not invent current facts, URLs, dates, rankings, or source metadata not present in this report."
  ].filter(Boolean).join("\n\n");
  return { context, report };
}

async function tavilyResearch(env: Env, query: string, model: ResearchModel = "mini"): Promise<{ context: string; report: string }> {
  const response = await tavilyRequest<{ request_id?: string }>(env, "/research", {
    input: query,
    model,
    citation_format: "numbered",
    output_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        key_findings: { type: "array", items: { type: "string" } },
        caveats: { type: "array", items: { type: "string" } }
      },
      required: ["summary", "key_findings", "caveats"]
    }
  });

  const requestId = response.request_id;
  if (!requestId) throw new Error("Tavily Research did not return a request ID");

  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await tavilyRequest<{
      status?: string;
      content?: unknown;
      sources?: Array<{ title?: string; url?: string; snippet?: string }>;
      request_id?: string;
    }>(env, `/research/${encodeURIComponent(requestId)}`, undefined, "GET");
    const status = String(result.status || "").toLowerCase();
    if (status === "completed" || status === "complete") {
      return formatResearchResult(query, model, result);
    }
    if (status === "failed" || status === "error") {
      throw new Error(`Tavily Research failed with status: ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error("Tavily Research timed out while waiting for the research report");
}

async function tavilyExtract(env: Env, urls: string[]): Promise<{ context: string; report: string }> {
  const limitedUrls = urls.filter((url) => /^https?:\/\//i.test(url)).slice(0, 20);
  if (!limitedUrls.length) throw new Error("Provide at least one valid HTTP(S) URL");
  const response = await tavilyRequest<{
    results?: Array<{ url?: string; raw_content?: string }>;
    failed_results?: Array<{ url?: string; error?: string }>;
    usage?: TavilyUsage;
  }>(env, "/extract", { urls: limitedUrls });
  const successful = response.results ?? [];
  const failed = response.failed_results ?? [];
  const report = formatWebSearchReport({
    type: "URL Extraction",
    requestId: undefined,
    creditsUsed: response.usage?.credits,
    sourceCount: successful.length,
    sources: successful.map((item) => ({ title: "Extracted page", url: item.url }))
  });
  const context = [
    "TAVILY EXTRACT RESULT",
    `REQUESTED URLS: ${limitedUrls.length}`,
    `SUCCESSFUL: ${successful.length}`,
    `FAILED: ${failed.length}`,
    response.usage?.credits !== undefined ? `TAVILY CREDITS USED: ${response.usage.credits}` : "",
    "",
    ...successful.map((item, index) => `${index + 1}. URL: ${item.url || ""}\nCONTENT:\n${cleanText(item.raw_content || "", 10000)}`),
    failed.length ? `FAILED URLS:\n${failed.map((item) => `${item.url || "unknown"}: ${item.error || "unknown error"}`).join("\n")}` : ""
  ].filter(Boolean).join("\n\n");
  return { context, report };
}

export class ConversationAgent extends Think {
  private pendingTavilyReport: string | null = null;

  override getModel() {
    const provider = createOpenAI({ apiKey: this.env.BAI_API_KEY, baseURL: this.env.BAI_BASE_URL });
    return provider("laguna-s-2.1");
  }

  override getSystemPrompt(): string {
    const currentDate = new Date().toISOString().slice(0, 10);
    const iranNow = new Date().toLocaleString("fa-IR", {
      timeZone: "Asia/Tehran",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    return [
      "You are a concise assistant replying inside a chat thread.",
      "Answer the user's latest message directly.",
      "Use plain text or simple Markdown only.",
      `Current date: ${currentDate}. Treat this as the authoritative current date. Never invent or change the year.`,
      `Current server time in Iran/Tehran: ${iranNow}. For ordinary current-time questions, use this exact server-provided value instead of guessing or inventing a time.`,
      "Your language model is provided by B.AI through an OpenAI-compatible API.",
      "You have official Tavily web tools for search, deep research, and page extraction.",
      "For current, latest, newest, 2026, best, top, recommendation, comparison, news, prices, versions, or time-sensitive questions, use tavily_search with advanced depth or tavily_research when deeper verification is useful.",
      "For a user explicitly asking to search the web, actually use a web tool before answering; do not answer from memory alone.",
      "Use tavily_research for deep research, multi-source comparison, fact checking, rankings, best-of questions, or questions where accuracy matters more than speed. Prefer mini for normal deep research; use pro only when the question is genuinely complex and the extra cost is justified.",
      "Use tavily_search for quick current lookups and focused source discovery. Basic is cheaper; advanced is better for current/recommendation questions.",
      "Use tavily_extract when you need the actual contents of one or more specific URLs returned by search or supplied by the user.",
      "Do not claim that a search or research was performed unless the tool result confirms it.",
      "Never invent sources, URLs, dates, versions, rankings, request IDs, credit usage, or current facts.",
      "Never invent a Tavily request ID. Only report request_id values returned by the Tavily API.",
      "Never state that tavily_extract, tavily_search, or tavily_research ran unless its tool result is actually present in the current turn.",
      "The final Tavily report is appended by the server from the actual Tavily response. Do not create or rewrite that report yourself.",
      "Never reveal API keys, environment secrets, hidden reasoning, or hidden tool internals.",
      "For Cloudflare questions, prefer official Cloudflare and official npm sources when search results provide them.",
      "Use fetch_to_markdown or browse only when you need a specific URL rendered/read through Cloudflare Browser Run.",
      "Interactive browser_execute is intentionally not enabled because it requires Worker Loader/Dynamic Workers on the paid plan."
    ].join("\n");
  }

  override beforeTurn(ctx: TurnContext): TurnConfig | void {
    const query = latestUserText(ctx);
    if (!query) return;

    const explicitWeb = isExplicitWebSearchQuery(query);
    const currentQuery = isCurrentOrRecommendationQuery(query);

    if (explicitWeb || currentQuery) {
      console.log("[SEARCH POLICY] forcing Tavily search", { query: cleanText(query, 300) });
      return {
        activeTools: ["tavily_search", "tavily_research", "tavily_extract", "fetch_to_markdown", "browse"],
        toolChoice: { type: "tool", toolName: "tavily_search" },
        maxSteps: 4
      };
    }

    if (isTimeQuery(query)) {
      console.log("[TIME POLICY] using server-provided Tehran time", { query: cleanText(query, 300) });
      return { maxSteps: 2 };
    }
  }

  override getTools(): ToolSet {
    const tavilySearchTool = tool({
      description: "Official Tavily web search. REQUIRED for explicit web-search requests and for current/latest/2026/best/top/recommendation/comparison/news/price/version questions. Returns ranked sources and URLs.",
      inputSchema: jsonSchema<{ query: string; depth?: SearchDepth; topic?: SearchTopic; maxResults?: number }>({
        type: "object",
        properties: {
          query: { type: "string", description: "Focused web search query; include the relevant year such as 2026 when the user asks for current information." },
          depth: { type: "string", enum: ["basic", "advanced"] },
          topic: { type: "string", enum: ["general", "news", "finance"] },
          maxResults: { type: "number", description: "Maximum results, 1 to 10." }
        },
        required: ["query"],
        additionalProperties: false
      }),
      execute: async ({ query, depth, topic, maxResults }) => {
        console.log("[AGENT TOOL] tavily_search", { query: cleanText(query, 300), depth, topic, maxResults });
        const result = await tavilySearch(this.env, query, { depth, topic, maxResults });
        this.pendingTavilyReport = result.report;
        return result.context;
      }
    });

    const tavilyResearchTool = tool({
      description: "Official Tavily Deep Research. Use for deep research, multi-source fact checking, comparisons, rankings, best-of questions, or explicit comprehensive research. Default to mini to conserve credits.",
      inputSchema: jsonSchema<{ query: string; model?: ResearchModel }>({
        type: "object",
        properties: {
          query: { type: "string", description: "Precise research question. Include the current year when relevant." },
          model: { type: "string", enum: ["auto", "mini", "pro"] }
        },
        required: ["query"],
        additionalProperties: false
      }),
      execute: async ({ query, model }) => {
        console.log("[AGENT TOOL] tavily_research", { query: cleanText(query, 300), model: model ?? "mini" });
        const result = await tavilyResearch(this.env, query, model ?? "mini");
        this.pendingTavilyReport = result.report;
        return result.context;
      }
    });

    const tavilyExtractTool = tool({
      description: "Extract readable/raw content from up to 20 specific public URLs using Tavily.",
      inputSchema: jsonSchema<{ urls: string[] }>({
        type: "object",
        properties: { urls: { type: "array", items: { type: "string" } } },
        required: ["urls"],
        additionalProperties: false
      }),
      execute: async ({ urls }) => {
        console.log("[AGENT TOOL] tavily_extract", { urlCount: urls.length });
        const result = await tavilyExtract(this.env, urls);
        this.pendingTavilyReport = result.report;
        return result.context;
      }
    });

    const fetchToMarkdown = tool({
      description: "Fetch a public URL through Cloudflare Browser Run and return cleaned Markdown/text.",
      inputSchema: jsonSchema<{ url: string }>({
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false
      }),
      execute: async ({ url }) => browserMarkdown(this.env.BROWSER, url)
    });

    const browse = tool({
      description: "Read a public URL as cleaned browser content.",
      inputSchema: jsonSchema<{ url: string }>({
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false
      }),
      execute: async ({ url }) => browserContent(this.env.BROWSER, url)
    });

    return {
      tavily_search: tavilySearchTool,
      tavily_research: tavilyResearchTool,
      tavily_extract: tavilyExtractTool,
      fetch_to_markdown: fetchToMarkdown,
      browse
    };
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    if (result.status !== "completed" || !this.pendingTavilyReport || !result.message?.id) return;

    const report = this.pendingTavilyReport;
    this.pendingTavilyReport = null;

    const currentParts = Array.isArray(result.message.parts) ? result.message.parts : [];
    const hasReport = currentParts.some((part) =>
      part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string" && (part as { text: string }).text.includes("🔎 گزارش جستجوی واقعی Tavily")
    );
    if (hasReport) return;

    await this.addMessages([
      {
        ...result.message,
        parts: [
          ...currentParts,
          { type: "text", text: `\n\n${report}` }
        ]
      }
    ], { mode: "upsert" });
  }
}
