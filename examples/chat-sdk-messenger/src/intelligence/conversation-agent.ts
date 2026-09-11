import { createOpenAI } from "@ai-sdk/openai";
import { Think, type TurnContext, type TurnConfig } from "@cloudflare/think";
import { browserContent, browserMarkdown } from "agents/browser";
import { tavily } from "@tavily/core";
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

function cleanText(value: string, max = 12000): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "user") return "";
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return "";
  return candidate.content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).filter(Boolean).join("\n");
}

function extractExplicitSearchQuery(text: string): string | null {
  const match = text.match(/(?:در\s+وب\s+جستجو\s+کن|در\s+اینترنت\s+جستجو\s+کن|وب\s+جستجو\s+کن|در\s+وب\s+سرچ\s+کن|سرچ\s+کن|جستجو\s+کن|search\s+the\s+web|search\s+online|search\s+the\s+internet)\s*:?[\s-]*(.+)$/iu);
  return match?.[1]?.trim() || null;
}

function isCurrentOrRecommendationQuery(query: string): boolean {
  return /(latest|newest|current|today|now|2026|best|top|recommended|recommendation|comparison|compare|آخرین|جدیدترین|جدید|امروز|الان|بهترین|برتر|پیشنهاد|مقایسه|مقایسه\s+کن)/iu.test(query);
}

function getTavilyClient(env: Env) {
  const apiKey = (env as Env & { TAVILY_API_KEY?: string }).TAVILY_API_KEY;
  if (!apiKey) throw new Error("Tavily is not configured: TAVILY_API_KEY is missing");
  return tavily({ apiKey, clientName: "cloudflare-agents-telegram" });
}

function formatSearchResults(query: string, response: { results?: TavilySearchResult[]; requestId?: string; usage?: { credits?: number } }): string {
  const results = response.results ?? [];
  return [
    "TAVILY SEARCH RESULT",
    `QUERY: ${query}`,
    `SEARCH DEPTH: ${isCurrentOrRecommendationQuery(query) ? "advanced" : "basic"}`,
    response.requestId ? `REQUEST ID: ${response.requestId}` : "",
    response.usage?.credits !== undefined ? `TAVILY CREDITS USED: ${response.usage.credits}` : "",
    `RESULT COUNT: ${results.length}`,
    "",
    ...results.map((result, index) => [
      `${index + 1}. ${result.title || result.url || "Untitled result"}`,
      `URL: ${result.url || ""}`,
      result.publishedDate ? `PUBLISHED: ${result.publishedDate}` : "",
      result.content ? `CONTENT: ${cleanText(result.content, 6000)}` : ""
    ].filter(Boolean).join("\n"))
  ].filter(Boolean).join("\n\n");
}

async function tavilySearch(
  env: Env,
  query: string,
  options: { depth?: SearchDepth; topic?: SearchTopic; maxResults?: number } = {}
): Promise<string> {
  const client = getTavilyClient(env);
  const depth = options.depth ?? (isCurrentOrRecommendationQuery(query) ? "advanced" : "basic");
  const maxResults = Math.min(Math.max(options.maxResults ?? 6, 1), 10);
  const response = await client.search(query, {
    searchDepth: depth,
    topic: options.topic ?? "general",
    maxResults,
    includeAnswer: false,
    includeRawContent: false,
    ...(depth === "advanced" ? { chunksPerSource: 2 } : {})
  });
  return formatSearchResults(query, response);
}

function formatResearchResult(query: string, model: ResearchModel, result: {
  status?: string;
  content?: string;
  sources?: Array<{ title?: string; url?: string; snippet?: string }>;
  requestId?: string;
  usage?: { credits?: number };
}): string {
  const sources = result.sources ?? [];
  return [
    "TAVILY DEEP RESEARCH REPORT",
    `QUERY: ${query}`,
    `MODEL: ${model}`,
    `STATUS: ${result.status || "completed"}`,
    result.requestId ? `REQUEST ID: ${result.requestId}` : "",
    result.usage?.credits !== undefined ? `TAVILY CREDITS USED: ${result.usage.credits}` : "",
    `SOURCE COUNT: ${sources.length}`,
    "",
    "RESEARCH REPORT",
    cleanText(result.content || "No research report was returned.", 24000),
    "",
    "SOURCES",
    ...sources.slice(0, 20).map((source, index) => `${index + 1}. ${source.title || source.url || "Source"}\nURL: ${source.url || ""}${source.snippet ? `\nSnippet: ${cleanText(source.snippet, 1000)}` : ""}`),
    "",
    "STRICT REPORTING RULE: Treat this report and its sources as the factual research context. Do not invent current facts that are not supported by the report. In the final answer, summarize supported findings, preserve important uncertainty, and include the most relevant source URLs. Do not reveal API keys or hidden tool internals."
  ].filter(Boolean).join("\n\n");
}

async function tavilyResearch(
  env: Env,
  query: string,
  model: ResearchModel = "mini"
): Promise<string> {
  const client = getTavilyClient(env);
  const response = await client.research(query, {
    model,
    citationFormat: "numbered"
  });

  const requestId = response.requestId;
  if (!requestId) throw new Error("Tavily Research did not return a request ID");

  for (let attempt = 0; attempt < 24; attempt++) {
    const result = await client.getResearch(requestId);
    const status = String(result.status || "").toLowerCase();
    if (status === "completed" || status === "complete" || status === "failed" || status === "error") {
      if (status === "failed" || status === "error") {
        throw new Error(`Tavily Research failed: ${cleanText(result.content || "unknown error", 1200)}`);
      }
      return formatResearchResult(query, model, result);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error("Tavily Research timed out while waiting for the research report");
}

async function tavilyExtract(env: Env, urls: string[]): Promise<string> {
  const client = getTavilyClient(env);
  const limitedUrls = urls.filter((url) => /^https?:\/\//i.test(url)).slice(0, 20);
  if (!limitedUrls.length) throw new Error("Provide at least one valid HTTP(S) URL");
  const response = await client.extract(limitedUrls);
  const successful = response.results ?? [];
  const failed = response.failedResults ?? [];
  return [
    "TAVILY EXTRACT RESULT",
    `REQUESTED URLS: ${limitedUrls.length}`,
    `SUCCESSFUL: ${successful.length}`,
    `FAILED: ${failed.length}`,
    "",
    ...successful.map((item, index) => `${index + 1}. URL: ${item.url}\nCONTENT:\n${cleanText(item.rawContent || "", 10000)}`),
    failed.length ? `\nFAILED URLS:\n${failed.map((item) => item.url || "unknown").join("\n")}` : ""
  ].filter(Boolean).join("\n\n");
}

export class ConversationAgent extends Think {
  override getModel() {
    const provider = createOpenAI({ apiKey: this.env.BAI_API_KEY, baseURL: this.env.BAI_BASE_URL });
    return provider("laguna-s-2.1");
  }

  override getSystemPrompt(): string {
    const currentDate = new Date().toISOString().slice(0, 10);
    return [
      "You are a concise assistant replying inside a chat thread.",
      "Answer the user's latest message directly.",
      "Use plain text or simple Markdown only.",
      `Current date: ${currentDate}. Treat this as the authoritative current date. Never invent or change the year.`,
      "Your language model is provided by B.AI through an OpenAI-compatible API.",
      "You have official Tavily web tools for search, deep research, and page extraction.",
      "For current, latest, newest, 2026, best, top, recommendation, comparison, news, prices, versions, or time-sensitive questions, use tavily_search with advanced depth or tavily_research when deeper verification is useful.",
      "For a user explicitly asking to search the web, actually use a web tool before answering; do not answer from memory alone.",
      "Use tavily_research for deep research, multi-source comparison, fact checking, rankings, or questions where accuracy matters more than speed. Prefer mini for normal deep research; use pro only when the question is genuinely complex and the extra cost is justified.",
      "Use tavily_search for quick current lookups and focused source discovery. Basic is cheaper; advanced is better for current/recommendation questions.",
      "Use tavily_extract when you need the actual contents of one or more specific URLs returned by search or supplied by the user.",
      "Do not claim that a search or research was performed unless the tool result confirms it.",
      "Never invent sources, URLs, dates, versions, rankings, or current facts.",
      "When using web research, base factual claims on the returned research/search context. If sources disagree or evidence is weak, say so.",
      "After web research, finish with a compact 'گزارش جستجو' stating the actual provider (Tavily), the number of sources/results when available, and the most relevant source URLs.",
      "Never reveal API keys, environment secrets, hidden reasoning, or hidden tool internals.",
      "For Cloudflare questions, prefer official Cloudflare and official npm sources when search results provide them.",
      "Use fetch_to_markdown or browse only when you need a specific URL rendered/read through Cloudflare Browser Run.",
      "Interactive browser_execute is intentionally not enabled because it requires Worker Loader/Dynamic Workers on the paid plan."
    ].join("\n");
  }

  override getTools(): ToolSet {
    const tavilySearchTool = tool({
      description: "Official Tavily web search. REQUIRED for explicit web-search requests and for current/latest/2026/best/top/recommendation/comparison/news/price/version questions. Automatically prefer advanced search for time-sensitive or recommendation queries. Returns ranked sources and URLs. Do not answer from memory after calling this tool.",
      inputSchema: jsonSchema<{ query: string; depth?: SearchDepth; topic?: SearchTopic; maxResults?: number }>({
        type: "object",
        properties: {
          query: { type: "string", description: "Focused web search query; include the relevant year such as 2026 when the user asks for current information." },
          depth: { type: "string", enum: ["basic", "advanced"], description: "Basic is cheaper; advanced is preferred for current, best, comparison, news, prices, versions, and recommendation queries." },
          topic: { type: "string", enum: ["general", "news", "finance"], description: "Search topic." },
          maxResults: { type: "number", description: "Maximum results, 1 to 10." }
        },
        required: ["query"],
        additionalProperties: false
      }),
      execute: async ({ query, depth, topic, maxResults }) => tavilySearch(this.env, query, { depth, topic, maxResults })
    });

    const tavilyResearchTool = tool({
      description: "Official Tavily Deep Research. Use for deep research, multi-source fact checking, comparisons, rankings, best-of questions, or when the user explicitly asks for deep/comprehensive research. Tavily gathers and analyzes sources and returns a research report with citations. Default to mini to conserve credits; use pro only for genuinely complex research.",
      inputSchema: jsonSchema<{ query: string; model?: ResearchModel }>({
        type: "object",
        properties: {
          query: { type: "string", description: "Precise research question. Include the current year when relevant." },
          model: { type: "string", enum: ["auto", "mini", "pro"], description: "Research model. Mini is the normal default; pro is for complex research." }
        },
        required: ["query"],
        additionalProperties: false
      }),
      execute: async ({ query, model }) => tavilyResearch(this.env, query, model ?? "mini")
    });

    const tavilyExtractTool = tool({
      description: "Extract the readable/raw content from up to 20 specific public URLs using Tavily. Use after search when the exact page content matters.",
      inputSchema: jsonSchema<{ urls: string[] }>({
        type: "object",
        properties: {
          urls: { type: "array", items: { type: "string" }, description: "Public HTTP(S) URLs to extract, up to 20." }
        },
        required: ["urls"],
        additionalProperties: false
      }),
      execute: async ({ urls }) => tavilyExtract(this.env, urls)
    });

    const fetchToMarkdown = tool({
      description: "Fetch a public URL through Cloudflare Browser Run and return clean Markdown. Use this only when a specific URL needs rendered page inspection.",
      inputSchema: jsonSchema<{ url: string }>({ type: "object", properties: { url: { type: "string", description: "Public URL to fetch" } }, required: ["url"], additionalProperties: false }),
      execute: async ({ url }) => browserMarkdown(this.env.BROWSER, { url })
    });

    const browse = tool({
      description: "Open a public URL in Cloudflare Browser Run and return rendered HTML. Use only when page rendering or JavaScript is needed.",
      inputSchema: jsonSchema<{ url: string }>({ type: "object", properties: { url: { type: "string", description: "Public URL to browse" } }, required: ["url"], additionalProperties: false }),
      execute: async ({ url }) => browserContent(this.env.BROWSER, { url })
    });

    return {
      tavily_search: tavilySearchTool,
      tavily_research: tavilyResearchTool,
      tavily_extract: tavilyExtractTool,
      fetch_to_markdown: fetchToMarkdown,
      browse
    };
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    if (ctx.continuation) return;
    const latestUserMessage = [...ctx.messages].reverse().find((message) => message.role === "user");
    const query = extractExplicitSearchQuery(messageText(latestUserMessage));
    if (!query) return;

    return {
      system: `${ctx.system}\n\nThe user explicitly requested a web search for: ${query}\nYou MUST use tavily_search or tavily_research before answering. Prefer tavily_research for deep/comparative questions and tavily_search for focused lookups. Do not answer from memory alone.`,
      activeTools: Object.keys(ctx.tools)
    };
  }

  async resetConversation(): Promise<void> {
    await this.clearMessages();
  }
}
