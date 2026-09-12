import { createOpenAI } from "@ai-sdk/openai";
import { Think, type ChatResponseResult, type TurnContext, type TurnConfig } from "@cloudflare/think";
import { browserContent, browserMarkdown } from "agents/browser";
import { tool, jsonSchema, type ToolSet } from "ai";
type SearchDepth = "basic" | "advanced"; type SearchTopic = "general" | "news" | "finance"; type ResearchModel = "auto" | "mini" | "pro"; type SearchMode = "auto" | "tavily" | "exa" | "research" | "both";
type TavilySearchResult = { title?: string; url?: string; content?: string; score?: number; publishedDate?: string }; type TavilyUsage = { credits?: number }; type TavilyReport = { type: string; depth?: SearchDepth; model?: ResearchModel; requestId?: string; creditsUsed?: number; resultCount?: number; sourceCount?: number; sources: Array<{ title?: string; url?: string }> }; type ExaResult = { title?: string; url?: string; text?: string; publishedDate?: string; author?: string; score?: number };
function cleanText(value: string, max = 12000): string { return value.replace(/\s+/g, " ").trim().slice(0, max); }
function isCurrentOrRecommendationQuery(query: string): boolean { return /(latest|newest|current|today|now|2026|best|top|recommended|recommendation|comparison|compare|آخرین|جدیدترین|جدید|امروز|الان|بهترین|برتر|پیشنهاد|مقایسه)/iu.test(query); }
function isExplicitWebSearchQuery(query: string): boolean { return /(search|look\s*up|browse|web|internet|research|find\s+online|جستجو|جست‌وجو|وب|اینترنت|تحقیق|بررسی\s+کن|از\s+وب|با\s+اطلاعاتی\s+که\s+از\s+وب)/iu.test(query); }
function isTimeQuery(query: string): boolean { return /(what time|current time|time now|time is it|ساعت\s*(چند|چنده|فعلی)|الان\s*ساعت|زمان\s*فعلی|وقت\s+ایران|به\s+وقت\s+ایران)/iu.test(query); }
function latestUserText(ctx: TurnContext): string { const message = [...ctx.messages].reverse().find((item) => item.role === "user"); if (!message) return ""; if (typeof message.content === "string") return message.content; return JSON.stringify(message.content ?? ""); }
function searchModeFromContext(ctx: TurnContext): SearchMode { for (const message of [...ctx.messages].reverse()) { const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""); const match = content.match(/\[SEARCH_MODE:(auto|tavily|exa|research|both)\]/i); if (match) return match[1].toLowerCase() as SearchMode; } return "auto"; }
function getTavilyApiKey(env: Env): string { const apiKey = (env as Env & { TAVILY_API_KEY?: string }).TAVILY_API_KEY; if (!apiKey) throw new Error("Tavily is not configured: TAVILY_API_KEY is missing"); return apiKey; }
function getExaApiKey(env: Env): string { const apiKey = (env as Env & { EXA_API_KEY?: string }).EXA_API_KEY; if (!apiKey) throw new Error("Exa is not configured: EXA_API_KEY is missing"); return apiKey; }
async function tavilyRequest<T>(env: Env, path: string, body?: unknown, method: "GET" | "POST" = "POST"): Promise<T> { const response = await fetch(`https://api.tavily.com${path}`, { method, headers: { Authorization: `Bearer ${getTavilyApiKey(env)}`, "Content-Type": "application/json", "X-Client-Name": "cloudflare-agents-telegram" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw new Error(`Tavily HTTP ${response.status}: ${cleanText(await response.text(), 1000)}`); return await response.json() as T; }
async function exaSearch(env: Env, query: string, maxResults = 8): Promise<{ context: string; report: string }> { const response = await fetch("https://api.exa.ai/search", { method: "POST", headers: { "x-api-key": getExaApiKey(env), "Content-Type": "application/json" }, body: JSON.stringify({ query, type: "auto", numResults: Math.min(Math.max(maxResults, 1), 10), contents: { text: true } }) }); if (!response.ok) throw new Error(`Exa HTTP ${response.status}: ${cleanText(await response.text(), 1000)}`); const data = await response.json() as { results?: ExaResult[] }; const results = data.results ?? []; const context = ["EXA SEARCH RESULT", `QUERY: ${query}`, `RESULT COUNT: ${results.length}`, "", ...results.map((result, index) => [`${index + 1}. ${result.title || result.url || "Untitled result"}`, `URL: ${result.url || ""}`, result.publishedDate ? `PUBLISHED: ${result.publishedDate}` : "", result.author ? `AUTHOR: ${result.author}` : "", result.text ? `CONTENT: ${cleanText(result.text, 7000)}` : ""].filter(Boolean).join("\n"))].filter(Boolean).join("\n\n"); const report = ["━━━━━━━━━━━━━━", "🧠 گزارش جستجوی واقعی Exa", "Provider: Exa", `تعداد نتایج: ${results.length}`, results.length ? "منابع واقعی برگشتی از Exa:" : "منبع URL قابل نمایش دریافت نشد", ...results.slice(0, 8).map((result, index) => `${index + 1}. ${result.title || "Source"}\n${result.url || ""}`), "━━━━━━━━━━━━━━"].join("\n"); return { context, report }; }
function formatWebSearchReport(input: TavilyReport): string { const sources = input.sources.filter((source) => source.url).slice(0, 8); return ["━━━━━━━━━━━━━━", "🔎 گزارش جستجوی واقعی Tavily", `نوع جستجو: ${input.type}`, "Provider: Tavily", input.depth ? `عمق جستجو: ${input.depth === "advanced" ? "Advanced" : "Basic"}` : "", input.model ? `مدل تحقیق: ${input.model}` : "", input.requestId ? `Request ID واقعی Tavily: ${input.requestId}` : "Request ID: دریافت نشد", input.creditsUsed !== undefined ? `Credits مصرف‌شده طبق پاسخ Tavily: ${input.creditsUsed}` : "Credits: در پاسخ Tavily گزارش نشد", input.resultCount !== undefined ? `تعداد نتایج: ${input.resultCount}` : "", input.sourceCount !== undefined ? `تعداد منابع: ${input.sourceCount}` : "", sources.length ? "منابع واقعی برگشتی از Tavily:" : "منبع URL قابل نمایش دریافت نشد", ...sources.map((source, index) => `${index + 1}. ${source.title || "Source"}\n${source.url}`), "━━━━━━━━━━━━━━"].filter(Boolean).join("\n"); }
function formatSearchResults(query: string, response: { results?: TavilySearchResult[]; request_id?: string; usage?: TavilyUsage }, depth: SearchDepth): { context: string; report: string } { const results = response.results ?? []; const report = formatWebSearchReport({ type: "Web Search", depth, requestId: response.request_id, creditsUsed: response.usage?.credits, resultCount: results.length, sourceCount: results.length, sources: results.map((result) => ({ title: result.title, url: result.url })) }); const context = ["TAVILY SEARCH RESULT", `QUERY: ${query}`, `SEARCH DEPTH: ${depth}`, response.request_id ? `REQUEST ID: ${response.request_id}` : "REQUEST ID: MISSING", response.usage?.credits !== undefined ? `TAVILY CREDITS USED: ${response.usage.credits}` : "TAVILY CREDITS USED: MISSING", `RESULT COUNT: ${results.length}`, "", ...results.map((result, index) => [`${index + 1}. ${result.title || result.url || "Untitled result"}`, `URL: ${result.url || ""}`, result.publishedDate ? `PUBLISHED: ${result.publishedDate}` : "", result.content ? `CONTENT: ${cleanText(result.content, 6000)}` : ""].filter(Boolean).join("\n"))].filter(Boolean).join("\n\n"); return { context, report }; }
async function tavilySearch(env: Env, query: string, options: { depth?: SearchDepth; topic?: SearchTopic; maxResults?: number } = {}): Promise<{ context: string; report: string }> { const depth = options.depth ?? (isCurrentOrRecommendationQuery(query) ? "advanced" : "basic"); const maxResults = Math.min(Math.max(options.maxResults ?? 6, 1), 10); const response = await tavilyRequest<{ results?: TavilySearchResult[]; request_id?: string; usage?: TavilyUsage }>(env, "/search", { query, search_depth: depth, topic: options.topic ?? "general", max_results: maxResults, include_answer: false, include_raw_content: false, ...(depth === "advanced" ? { chunks_per_source: 2 } : {}) }); return formatSearchResults(query, response, depth); }
function researchContentText(content: unknown): string { if (typeof content === "string") return cleanText(content, 24000); if (content && typeof content === "object") return JSON.stringify(content, null, 2).slice(0, 24000); return "No research report was returned."; }
function formatResearchResult(query: string, model: ResearchModel, result: { status?: string; content?: unknown; sources?: Array<{ title?: string; url?: string; snippet?: string }>; request_id?: string }): { context: string; report: string } { const sources = result.sources ?? []; const report = formatWebSearchReport({ type: "Deep Research", model, requestId: result.request_id, sourceCount: sources.length, sources: sources.map((source) => ({ title: source.title, url: source.url })) }); const context = ["TAVILY DEEP RESEARCH REPORT", `QUERY: ${query}`, `MODEL: ${model}`, `STATUS: ${result.status || "completed"}`, result.request_id ? `REQUEST ID: ${result.request_id}` : "REQUEST ID: MISSING", `SOURCE COUNT: ${sources.length}`, "", "RESEARCH REPORT", researchContentText(result.content), "", "SOURCES", ...sources.slice(0, 20).map((source, index) => `${index + 1}. ${source.title || source.url || "Source"}\nURL: ${source.url || ""}`), "", "Do not invent current facts, URLs, dates, rankings, or source metadata not present in this report."].filter(Boolean).join("\n\n"); return { context, report }; }
async function tavilyResearch(env: Env, query: string, model: ResearchModel = "mini"): Promise<{ context: string; report: string }> { const response = await tavilyRequest<{ request_id?: string }>(env, "/research", { input: query, model, citation_format: "numbered", output_schema: { type: "object", properties: { summary: { type: "string" }, key_findings: { type: "array", items: { type: "string" } }, caveats: { type: "array", items: { type: "string" } } }, required: ["summary", "key_findings", "caveats"] } }); const requestId = response.request_id; if (!requestId) throw new Error("Tavily Research did not return a request ID"); for (let attempt = 0; attempt < 40; attempt++) { const result = await tavilyRequest<{ status?: string; content?: unknown; sources?: Array<{ title?: string; url?: string; snippet?: string }>; request_id?: string }>(env, `/research/${encodeURIComponent(requestId)}`, undefined, "GET"); const status = String(result.status || "").toLowerCase(); if (status === "completed" || status === "complete") return formatResearchResult(query, model, result); if (status === "failed" || status === "error") throw new Error(`Tavily Research failed with status: ${status}`); await new Promise((resolve) => setTimeout(resolve, 1500)); } throw new Error("Tavily Research timed out while waiting for the research report"); }
async function tavilyExtract(env: Env, urls: string[]): Promise<{ context: string; report: string }> { const limitedUrls = urls.filter((url) => /^https?:\/\//i.test(url)).slice(0, 20); if (!limitedUrls.length) throw new Error("Provide at least one valid HTTP(S) URL"); const response = await tavilyRequest<{ results?: Array<{ url?: string; raw_content?: string }>; failed_results?: Array<{ url?: string; error?: string }>; usage?: TavilyUsage }>(env, "/extract", { urls: limitedUrls }); const successful = response.results ?? []; const failed = response.failed_results ?? []; const report = formatWebSearchReport({ type: "URL Extraction", creditsUsed: response.usage?.credits, sourceCount: successful.length, sources: successful.map((item) => ({ title: "Extracted page", url: item.url })) }); const context = ["TAVILY EXTRACT RESULT", `REQUESTED URLS: ${limitedUrls.length}`, `SUCCESSFUL: ${successful.length}`, `FAILED: ${failed.length}`, response.usage?.credits !== undefined ? `TAVILY CREDITS USED: ${response.usage.credits}` : "", "", ...successful.map((item, index) => `${index + 1}. URL: ${item.url || ""}\nCONTENT:\n${cleanText(item.raw_content || "", 10000)}`), failed.length ? `FAILED URLS:\n${failed.map((item) => `${item.url || "unknown"}: ${item.error || "unknown error"}`).join("\n")}` : ""].filter(Boolean).join("\n\n"); return { context, report }; }

export class ConversationAgent extends Think {
  private pendingSearchReport: string | null = null;
  includeMcpTools = false;
  waitForMcpConnections = { timeout: 15000 };
  override async onStart() {
    await super.onStart();
    const env = this.env as Env & { GITHUB_MCP_TOKEN?: string; CLOUDFLARE_MCP_TOKEN?: string };
    const servers: Array<[string, string, string | undefined, string]> = [
      ["GitHub", "https://api.githubcopilot.com/mcp/", env.GITHUB_MCP_TOKEN, "github"],
      ["Cloudflare", "https://mcp.cloudflare.com/mcp", env.CLOUDFLARE_MCP_TOKEN, "cloudflare"],
    ];

    for (const [name, url, token, id] of servers) {
      if (!token) {
        console.warn(`[MCP] ${name} token is not configured`);
        continue;
      }
      try {
        // MCP registrations are persisted by the Agent. Re-registering with the
        // same name/URL can reuse an old persisted connection, so remove the
        // previous registration first to guarantee that the current secret is used.
        try {
          await this.removeMcpServer(id);
        } catch {
          // It is normal for the server not to exist on first deployment.
        }

        const result = await this.addMcpServer(name, url, {
          id,
          transport: {
            type: "streamable-http",
            headers: { Authorization: `Bearer ${token}` },
          },
          retry: { maxAttempts: 3, baseDelayMs: 500 },
        });
        console.log(`[MCP] ${name} registered`, {
          id,
          tokenConfigured: true,
          state: result.state,
          resultId: result.id,
        });
      } catch (error) {
        console.error(`[MCP] ${name} registration failed`, error);
      }
    }

    try {
      await this.mcp.waitForConnections({ timeout: 15000 });
      const serversState = Object.entries(this.getMcpServers().servers).map(([id, value]: [string, any]) => ({
        id,
        name: value.name,
        state: value.state,
        error: value.error ?? null,
      }));
      console.log("[MCP] connections ready", { servers: serversState });
    } catch (error) {
      console.error("[MCP] waitForConnections failed", error);
    }
  }
  override getModel() { const provider = createOpenAI({ apiKey: this.env.BAI_API_KEY, baseURL: this.env.BAI_BASE_URL }); return provider("laguna-s-2.1"); }
  override getSystemPrompt(): string { const currentDate = new Date().toISOString().slice(0,10); const iranNow = new Date().toLocaleString("fa-IR",{timeZone:"Asia/Tehran",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}); return ["You are a concise coding-focused assistant replying inside a chat thread.","Answer the user's latest message directly.","Use plain text or simple Markdown only.",`Current date: ${currentDate}. Treat this as the authoritative current date. Never invent or change the year... (truncated)".join("\n\n"); }
}