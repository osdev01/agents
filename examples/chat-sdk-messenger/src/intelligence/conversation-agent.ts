import { createOpenAI } from "@ai-sdk/openai";
import { Think, type TurnContext, type TurnConfig } from "@cloudflare/think";
import { browserContent, browserMarkdown } from "agents/browser";
import { tool, jsonSchema, type ToolSet } from "ai";

type Browser = Env["BROWSER"];

function cleanText(value: string, max = 12000): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url: string, headers: HeadersInit = {}): Promise<string> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Cloudflare-Agent-WebSearch/1.0)",
      Accept: "text/plain, text/html, application/xml, application/rss+xml;q=0.9, */*;q=0.8",
      ...headers
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.text();
}

async function searchWithBingRss(query: string): Promise<string> {
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  const xml = await fetchText(url, { Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8" });
  const items: string[] = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemPattern.exec(xml)) && items.length < 8) {
    const item = itemMatch[1];
    const title = item.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
    const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1];
    const description = item.match(/<description>([\s\S]*?)<\/description>/i)?.[1];
    if (!title || !link) continue;
    items.push(`${items.length + 1}. ${stripHtml(title)}\nURL: ${stripHtml(link)}\nSnippet: ${stripHtml(description || "")}`);
  }
  if (!items.length) throw new Error("Bing RSS returned no results");
  return `WEB SEARCH RESULTS (Bing RSS)\n\n${items.join("\n\n")}`;
}

async function searchWithJina(query: string): Promise<string> {
  const text = await fetchText(`https://s.jina.ai/${encodeURIComponent(query)}`, { Accept: "text/plain" });
  const cleaned = text.trim();
  if (!cleaned) throw new Error("Jina returned an empty response");
  return `WEB SEARCH RESULTS (Jina)\n\n${cleanText(cleaned, 14000)}`;
}

async function searchWithYahoo(query: string): Promise<string> {
  const html = await fetchText(`https://search.yahoo.com/search?p=${encodeURIComponent(query)}`, { Accept: "text/html, */*;q=0.8" });
  const text = stripHtml(html);
  if (!text) throw new Error("Yahoo returned an empty response");
  return `WEB SEARCH RESULTS (Yahoo)\n\n${cleanText(text, 12000)}`;
}

async function officialCloudflareSearch(query: string): Promise<string | null> {
  if (!/(cloudflare|agents\s+sdk|cloudflare\s+agents)/iu.test(query)) return null;
  const sources: string[] = [];
  if (/(latest|version|نسخه|ورژن|release|released)/iu.test(query)) {
    try {
      const npm = JSON.parse(await fetchText("https://registry.npmjs.org/agents/latest", { Accept: "application/json" })) as { name?: string; version?: string };
      if (npm.version) sources.push(`Official npm package: ${npm.name || "agents"}@${npm.version}\nURL: https://www.npmjs.com/package/agents\nPackage registry: https://registry.npmjs.org/agents/latest`);
    } catch {}
  }
  try {
    const changelog = await fetchText("https://developers.cloudflare.com/changelog/product/agents/", { Accept: "text/html, */*;q=0.8" });
    const text = stripHtml(changelog);
    const terms = query.toLowerCase().split(/\s+/).filter((x) => x.length > 3).slice(0, 8);
    const chunks = text.split(/(?=Agents SDK|Agents can|AgentsWorkers)/i);
    const relevant = chunks.filter((chunk) => terms.some((term) => chunk.toLowerCase().includes(term))).slice(0, 5).map((chunk) => cleanText(chunk, 3500));
    if (relevant.length) sources.push(`Official Cloudflare Agents changelog:\nURL: https://developers.cloudflare.com/changelog/product/agents/\n${relevant.join("\n\n")}`);
  } catch {}
  return sources.length ? `OFFICIAL CLOUDFLARE RESULTS\n\n${sources.join("\n\n")}` : null;
}

async function webSearch(query: string): Promise<string> {
  const official = await officialCloudflareSearch(query);
  if (official) return official;
  const errors: string[] = [];
  for (const [name, searcher] of [["Bing RSS", searchWithBingRss], ["Jina", searchWithJina], ["Yahoo", searchWithYahoo]] as const) {
    try { return await searcher(query); } catch (error) { errors.push(`${name}: ${String(error)}`); }
  }
  throw new Error(`No web results were available for: ${query}. ${errors.join(" | ")}`);
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

export class ConversationAgent extends Think {
  override getModel() {
    const provider = createOpenAI({ apiKey: this.env.BAI_API_KEY, baseURL: this.env.BAI_BASE_URL });
    return provider("ling-3.0-flash-fin-free");
  }

  override getSystemPrompt(): string {
    return [
      "You are a concise assistant replying inside a chat thread.",
      "Answer the user's latest message directly.",
      "Use plain text or simple Markdown only.",
      "Do not expose hidden reasoning, tool calls, or internal state.",
      "Your language model is provided by B.AI through an OpenAI-compatible API.",
      "You have web search through ordinary Cloudflare Worker fetch().",
      "Use web_search for current information, web research, documentation, prices, news, software versions, errors, and verification.",
      "For Cloudflare questions, prefer the official Cloudflare changelog and official npm package data returned by web_search.",
      "Use fetch_to_markdown when you need the readable text of a URL.",
      "Use browse when you need rendered HTML or page structure after JavaScript execution.",
      "Use cf_web_fetch when you need a Cloudflare-hosted web fetch.",
      "Important: web_search does NOT use Browser Run. Browser Run is reserved for reading/browsing a specific URL after search.",
      "Interactive browser_execute is intentionally not enabled because it requires Worker Loader/Dynamic Workers on the paid plan.",
      "Prefer official and primary sources for technical questions.",
      "Never claim that you cannot access the web when these tools are available.",
      "After research, summarize the findings and include relevant source URLs."
    ].join("\n");
  }

  override getTools(): ToolSet {
    const webSearchTool = tool({
      description: "Search the public web using ordinary HTTP from the Cloudflare Worker. For Cloudflare questions it prioritizes official Cloudflare and npm sources.",
      inputSchema: jsonSchema<{ query: string }>({ type: "object", properties: { query: { type: "string", description: "Focused web search query" } }, required: ["query"], additionalProperties: false }),
      execute: async ({ query }) => webSearch(query)
    });
    const fetchToMarkdown = tool({
      description: "Fetch a public URL through Cloudflare Browser Run and return clean Markdown. Use this after search when you need to inspect a source page.",
      inputSchema: jsonSchema<{ url: string }>({ type: "object", properties: { url: { type: "string", description: "Public URL to fetch" } }, required: ["url"], additionalProperties: false }),
      execute: async ({ url }) => browserMarkdown(this.env.BROWSER, { url })
    });
    const browse = tool({
      description: "Open a public URL in Cloudflare Browser Run and return rendered HTML. Use only when page rendering or JavaScript is needed.",
      inputSchema: jsonSchema<{ url: string }>({ type: "object", properties: { url: { type: "string", description: "Public URL to browse" } }, required: ["url"], additionalProperties: false }),
      execute: async ({ url }) => browserContent(this.env.BROWSER, { url })
    });
    const cfWebFetch = tool({
      description: "Fetch a public URL through Cloudflare Browser Run. Return Markdown when possible, otherwise rendered content.",
      inputSchema: jsonSchema<{ url: string }>({ type: "object", properties: { url: { type: "string", description: "Public URL to fetch" } }, required: ["url"], additionalProperties: false }),
      execute: async ({ url }) => { try { return await browserMarkdown(this.env.BROWSER, { url }); } catch { return await browserContent(this.env.BROWSER, { url }); } }
    });
    return { web_search: webSearchTool, fetch_to_markdown: fetchToMarkdown, browse, cf_web_fetch: cfWebFetch };
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    if (ctx.continuation) return;
    const latestUserMessage = [...ctx.messages].reverse().find((message) => message.role === "user");
    const query = extractExplicitSearchQuery(messageText(latestUserMessage));
    if (!query) return;
    const webResults = await webSearch(query);
    return { system: `${ctx.system}\n\nWEB SEARCH RESULTS FOR THIS TURN:\n${webResults}\n\nUse these results to answer the user's request. Do not repeat the same search unless the results are insufficient.`, activeTools: Object.keys(ctx.tools) };
  }

  async resetConversation(): Promise<void> { await this.clearMessages(); }
}
