import { createOpenAI } from "@ai-sdk/openai";
import { Think, type TurnContext, type TurnConfig } from "@cloudflare/think";
import { browserContent, browserMarkdown } from "agents/browser";
import { tool, jsonSchema, type ToolSet } from "ai";

export type SearchMode =
  | "auto"
  | "tavily_search"
  | "tavily_research"
  | "web_search"
  | "fetch_to_markdown"
  | "none";

type SearchState = { searchMode: SearchMode };
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

function cleanText(value: string, max = 12000): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function getTavilyApiKey(env: Env): string {
  const apiKey = (env as Env & { TAVILY_API_KEY?: string }).TAVILY_API_KEY;
  if (!apiKey) throw new Error("Tavily is not configured: TAVILY_API_KEY is missing");
  return apiKey;
}

async function tavilyRequest<T>(
  env: Env,
  path: string,
  body?: unknown,
  method: "GET" | "POST" = "POST"
): Promise<T> {
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

function formatSearchContext(
  query: string,
  response: { results?: TavilySearchResult[]; request_id?: string; usage?: TavilyUsage },
  depth: SearchDepth
): string {
  const results = response.results ?? [];
  return [
    "TAVILY SEARCH RESULT",
    `QUERY: ${query}`,
    `SEARCH DEPTH: ${depth}`,
    response.request_id ? `REQUEST ID: ${response.request_id}` : "REQUEST ID: MISSING",
    response.usage?.credits !== undefined
      ? `TAVILY CREDITS USED: ${response.usage.credits}`
      : "TAVILY CREDITS USED: MISSING",
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
  const depth = options.depth ?? "advanced";
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
  return formatSearchContext(query, response, depth);
}

async function tavilyResearch(
  env: Env,
  query: string,
  model: ResearchModel = "mini"
): Promise<string> {
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

  if (!response.request_id) {
    throw new Error("Tavily Research did not return a request ID");
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await tavilyRequest<{
      status?: string;
      content?: unknown;
      sources?: Array<{ title?: string; url?: string; snippet?: string }>;
      request_id?: string;
    }>(env, `/research/${encodeURIComponent(response.request_id)}`, undefined, "GET");
    const status = String(result.status || "").toLowerCase();

    if (status === "completed" || status === "complete") {
      const sources = result.sources ?? [];
      return [
        "TAVILY DEEP RESEARCH RESULT",
        `QUERY: ${query}`,
        `MODEL: ${model}`,
        `STATUS: ${result.status || "completed"}`,
        `REQUEST ID: ${result.request_id || response.request_id}`,
        `SOURCE COUNT: ${sources.length}`,
        "",
        "RESEARCH REPORT",
        typeof result.content === "string"
          ? result.content.slice(0, 24000)
          : JSON.stringify(result.content ?? {}, null, 2).slice(0, 24000),
        "",
        "SOURCES",
        ...sources.slice(0, 20).map(
          (source, index) => `${index + 1}. ${source.title || source.url || "Source"}\nURL: ${source.url || ""}`
        ),
        "",
        "Use only facts and source metadata present in this report."
      ].join("\n\n");
    }

    if (status === "failed" || status === "error") {
      throw new Error(`Tavily Research failed with status: ${status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error("Tavily Research timed out");
}

async function tavilyExtract(env: Env, urls: string[]): Promise<string> {
  const limitedUrls = urls.filter((url) => /^https?:\/\//i.test(url)).slice(0, 20);
  if (!limitedUrls.length) throw new Error("Provide at least one valid HTTP(S) URL");

  const response = await tavilyRequest<{
    results?: Array<{ url?: string; raw_content?: string }>;
    failed_results?: Array<{ url?: string; error?: string }>;
    usage?: TavilyUsage;
  }>(env, "/extract", { urls: limitedUrls });

  const successful = response.results ?? [];
  const failed = response.failed_results ?? [];
  return [
    "TAVILY EXTRACT RESULT",
    `REQUESTED URLS: ${limitedUrls.length}`,
    `SUCCESSFUL: ${successful.length}`,
    `FAILED: ${failed.length}`,
    response.usage?.credits !== undefined ? `TAVILY CREDITS USED: ${response.usage.credits}` : "",
    "",
    ...successful.map(
      (item, index) => `${index + 1}. URL: ${item.url || ""}\nCONTENT:\n${cleanText(item.raw_content || "", 10000)}`
    ),
    failed.length
      ? `FAILED URLS:\n${failed.map((item) => `${item.url || "unknown"}: ${item.error || "unknown error"}`).join("\n")}`
      : ""
  ].filter(Boolean).join("\n\n");
}

async function webSearch(env: Env, query: string): Promise<string> {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  console.log("[WEB SEARCH] request", { query: cleanText(query, 300) });
  const content = await browserMarkdown(env.BROWSER, searchUrl);
  console.log("[WEB SEARCH] response", { length: content.length });
  return [
    "WEB SEARCH RESULT",
    `QUERY: ${query}`,
    `SEARCH URL: ${searchUrl}`,
    "",
    content.slice(0, 30000),
    "",
    "Treat this as live web-search output. Do not invent details that are not present in the result."
  ].join("\n");
}

async function fetchToMarkdown(env: Env, url: string): Promise<string> {
  console.log("[FETCH MARKDOWN] request", { url: cleanText(url, 500) });
  const content = await browserMarkdown(env.BROWSER, url);
  console.log("[FETCH MARKDOWN] response", { url, length: content.length });
  return [
    "FETCH_TO_MARKDOWN RESULT",
    `URL: ${url}`,
    "",
    content.slice(0, 30000)
  ].join("\n");
}

function extractLatestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message.role !== "user") continue;

    if (typeof message.content === "string") return message.content.trim();
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const value = (part as { text?: unknown }).text;
          return typeof value === "string" ? value : "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

function detectExplicitSearchMode(query: string): SearchMode | null {
  if (/(بدون\s+(جستجو|سرچ|وب)|don't\s+search|do\s+not\s+search|no\s+web\s+search)/iu.test(query)) {
    return "none";
  }
  if (/(tavily\s*(research|deep\s*research)|تحقیق\s+با\s+tavily|tavily.*تحقیق)/iu.test(query)) {
    return "tavily_research";
  }
  if (/(tavily|تاویلی)/iu.test(query)) {
    return "tavily_search";
  }
  if (/(fetch[_\s-]*to[_\s-]*markdown|fetch\s+markdown|دریافت\s+مارک.?دان|صفحه.*مارک.?دان)/iu.test(query)) {
    return "fetch_to_markdown";
  }
  if (/(web[_\s-]*search|جستجوی?\s+وب|جستجو\s+در\s+وب|web\s+search)/iu.test(query)) {
    return "web_search";
  }
  return null;
}

function looksLikeWebRequest(query: string): boolean {
  return /https?:\/\//i.test(query) || /(search|web|internet|online|look up|latest|newest|current|today|now|news|price|pricing|cost|version|release|compare|comparison|best|top|recommend|recommendation|review|2026|جستجو|وب|اینترنت|آخرین|جدیدترین|امروز|الان|خبر|قیمت|نسخه|انتشار|مقایسه|بهترین|برترین|پیشنهاد|بررسی)/iu.test(query);
}

function chooseAutoSearchMode(query: string): SearchMode {
  if (/https?:\/\//i.test(query) && /(fetch|read|open|page|url|صفحه|لینک|بخوان|بررسی)/iu.test(query)) {
    return "fetch_to_markdown";
  }
  if (/(deep|research|investigate|comprehensive|fact.?check|تحقیق|بررسی\s+جامع|مقایسه\s+کامل)/iu.test(query)) {
    return "tavily_research";
  }
  if (/(news|خبر|price|قیمت|finance|مالی|stock|سهام|crypto|ارز|latest|current|آخرین|امروز|الان)/iu.test(query)) {
    return "tavily_search";
  }
  return "web_search";
}

function searchResultLooksUseful(result: string): boolean {
  const normalized = result.trim().toLowerCase();
  if (normalized.length < 500) return false;
  if (/no results|failed|error|not found|نتیجه.?ای پیدا نشد/iu.test(normalized)) return false;
  return /https?:\/\//i.test(result) || /result|نتیجه|source|منبع|content|محتوا/i.test(result);
}

export class ConversationAgent extends Think<Env, SearchState> {
  initialState: SearchState = { searchMode: "auto" };

  override getModel() {
    const provider = createOpenAI({
      apiKey: this.env.BAI_API_KEY,
      baseURL: this.env.BAI_BASE_URL
    });
    return provider("laguna-s-2.1");
  }

  getSearchMode(): SearchMode {
    return this.state.searchMode ?? "auto";
  }

  setSearchMode(mode: SearchMode): SearchMode {
    this.setState({ searchMode: mode });
    console.log("[SEARCH MODE] changed", { mode });
    return mode;
  }

  override getSystemPrompt(): string {
    const currentDate = new Date().toISOString().slice(0, 10);
    return [
      "You are a concise assistant replying inside a chat thread.",
      "Answer the user's latest message directly.",
      "Use plain text or simple Markdown only.",
      `Current date: ${currentDate}. Treat this as authoritative. Never invent or change the year.`,
      "The language model is provided by B.AI through an OpenAI-compatible API.",
      "Search is orchestrated by the server.",
      `Current search mode: ${this.getSearchMode()}.`,
      "If the user explicitly names a search method, that explicit request overrides the selected button mode.",
      "In Auto mode, the server selects the first suitable search method and can fall back to another method when the result is weak.",
      "Use only the actual tool result as evidence. Never claim a search happened unless a tool result confirms it.",
      "Never invent sources, URLs, dates, prices, versions, rankings, request IDs, or current facts.",
      "For current or web-dependent questions, do not answer from memory when a search result is available.",
      "For Cloudflare questions, prefer official Cloudflare sources when they appear in the results.",
      "Never reveal API keys, environment secrets, hidden reasoning, or internal control markers."
    ].join("\n");
  }

  override async beforeTurn(context: TurnContext): Promise<TurnConfig | void> {
    const query = extractLatestUserText(context.messages);
    const explicitMode = detectExplicitSearchMode(query);
    const mode = explicitMode ?? this.getSearchMode();

    console.log("[SEARCH ORCHESTRATOR] turn", {
      query: query.slice(0, 300),
      selectedMode: this.getSearchMode(),
      explicitMode,
      effectiveMode: mode
    });

    if (mode === "none") {
      return { activeTools: [], toolChoice: "none" };
    }

    if (!looksLikeWebRequest(query)) {
      return;
    }

    if (mode === "auto") {
      return {
        activeTools: ["search_orchestrator"],
        toolChoice: { type: "tool", toolName: "search_orchestrator" },
        maxSteps: 3
      };
    }

    return {
      activeTools: [mode],
      toolChoice: { type: "tool", toolName: mode },
      maxSteps: 3
    };
  }

  override getTools(): ToolSet {
    console.log("[AGENT] getTools called");

    const tavilySearchTool = tool({
      description: "Official Tavily web search. Use for current facts, news, prices, versions, source discovery, and focused web searches.",
      inputSchema: jsonSchema<{ query: string; depth?: SearchDepth; topic?: SearchTopic; maxResults?: number }>({
        type: "object",
        properties: {
          query: { type: "string" },
          depth: { type: "string", enum: ["basic", "advanced"] },
          topic: { type: "string", enum: ["general", "news", "finance"] },
          maxResults: { type: "number" }
        },
        required: ["query"],
        additionalProperties: false
      }),
      execute: async ({ query, depth, topic, maxResults }) => {
        console.log("[AGENT TOOL] tavily_search", { query: cleanText(query, 300), depth, topic, maxResults });
        return tavilySearch(this.env, query, {
          depth: depth ?? "advanced",
          topic,
          maxResults
        });
      }
    });

    const tavilyResearchTool = tool({
      description: "Official Tavily Deep Research for comprehensive multi-source research, fact checking, comparisons, and complex questions.",
      inputSchema: jsonSchema<{ query: string; model?: ResearchModel }>({
        type: "object",
        properties: {
          query: { type: "string" },
          model: { type: "string", enum: ["auto", "mini", "pro"] }
        },
        required: ["query"],
        additionalProperties: false
      }),
      execute: async ({ query, model }) => {
        console.log("[AGENT TOOL] tavily_research", { query: cleanText(query, 300), model: model ?? "mini" });
        return tavilyResearch(this.env, query, model ?? "mini");
      }
    });

    const tavilyExtractTool = tool({
      description: "Extract readable content from specific public URLs using Tavily.",
      inputSchema: jsonSchema<{ urls: string[] }>({
        type: "object",
        properties: { urls: { type: "array", items: { type: "string" } } },
        required: ["urls"],
        additionalProperties: false
      }),
      execute: async ({ urls }) => {
        console.log("[AGENT TOOL] tavily_extract", { urlCount: urls.length });
        return tavilyExtract(this.env, urls);
      }
    });

    const fetchMarkdownTool = tool({
      description: "Fetch a specific public URL through Cloudflare Browser Run and return readable Markdown.",
      inputSchema: jsonSchema<{ url: string }>({
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false
      }),
      execute: async ({ url }) => fetchToMarkdown(this.env, url)
    });

    const webSearchTool = tool({
      description: "Search the public web through DuckDuckGo HTML results. This is the generic web-search path and does not use Tavily credits.",
      inputSchema: jsonSchema<{ query: string }>({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      }),
      execute: async ({ query }) => webSearch(this.env, query)
    });

    const browseTool = tool({
      description: "Read a public URL as cleaned browser content.",
      inputSchema: jsonSchema<{ url: string }>({
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false
      }),
      execute: async ({ url }) => browserContent(this.env.BROWSER, url)
    });

    const searchOrchestratorTool = tool({
      description: "Server-side automatic web research orchestrator. Select the best search method for the query and try up to three methods when results are weak.",
      inputSchema: jsonSchema<{ query: string }>({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      }),
      execute: async ({ query }) => {
        const first = chooseAutoSearchMode(query);
        const plan: SearchMode[] = [
          first,
          ...(first === "tavily_research"
            ? ["tavily_search", "web_search"] as SearchMode[]
            : first === "tavily_search"
              ? ["web_search", "tavily_research"] as SearchMode[]
              : first === "web_search"
                ? ["tavily_search", "tavily_research"] as SearchMode[]
                : ["tavily_search", "web_search"] as SearchMode[])
        ];

        console.log("[SEARCH ORCHESTRATOR] plan", { query: cleanText(query, 300), plan });
        const errors: string[] = [];

        for (let index = 0; index < Math.min(plan.length, 3); index += 1) {
          const method = plan[index];
          try {
            let result: string;
            if (method === "tavily_search") {
              result = await tavilySearch(this.env, query, { depth: "advanced", maxResults: 6 });
            } else if (method === "tavily_research") {
              result = await tavilyResearch(this.env, query, "mini");
            } else if (method === "web_search") {
              result = await webSearch(this.env, query);
            } else if (method === "fetch_to_markdown") {
              const url = query.match(/https?:\/\/[^\s]+/i)?.[0];
              if (!url) throw new Error("No URL found for fetch_to_markdown");
              result = await fetchToMarkdown(this.env, url);
            } else {
              continue;
            }

            const useful = searchResultLooksUseful(result);
            console.log("[SEARCH ORCHESTRATOR] result", { method, attempt: index + 1, useful, length: result.length });
            if (useful || index === plan.length - 1) {
              return [
                `SEARCH ORCHESTRATOR FINAL METHOD: ${method}`,
                `ATTEMPTS: ${index + 1}`,
                errors.length ? `PREVIOUS ERRORS: ${errors.join(" | ")}` : "",
                "",
                result
              ].filter(Boolean).join("\n\n");
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`${method}: ${message}`);
            console.error("[SEARCH ORCHESTRATOR] failed", { method, message });
          }
        }

        throw new Error(`All automatic search methods failed: ${errors.join(" | ")}`);
      }
    });

    return {
      search_orchestrator: searchOrchestratorTool,
      tavily_search: tavilySearchTool,
      tavily_research: tavilyResearchTool,
      tavily_extract: tavilyExtractTool,
      web_search: webSearchTool,
      fetch_to_markdown: fetchMarkdownTool,
      browse: browseTool
    };
  }
}
