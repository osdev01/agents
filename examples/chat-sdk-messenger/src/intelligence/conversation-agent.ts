import { createOpenAI } from "@ai-sdk/openai";
import { Think, type TurnContext, type TurnConfig } from "@cloudflare/think";
import { browserContent, browserMarkdown } from "agents/browser";
import { tool, jsonSchema, type ToolSet } from "ai";

type Browser = Env["BROWSER"];
type SearchProviderName = "builtin" | "tavily";
type SearchDepth = "basic" | "advanced";
type SearchTopic = "general" | "news" | "finance";

type SearchResult = {
  provider: SearchProviderName;
  title: string;
  url: string;
  content: string;
  score?: number;
};

type SearchResponse = {
  provider: SearchProviderName;
  query: string;
  results: SearchResult[];
  creditsUsed?: number;
  error?: string;
};

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

async function searchWithBingRss(query: string): Promise<SearchResult[]> {
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  const xml = await fetchText(url, { Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8" });
  const results: SearchResult[] = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemPattern.exec(xml)) && results.length < 8) {
    const item = itemMatch[1];
    const title = item.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
    const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1];
    const description = item.match(/<description>([\s\S]*?)<\/description>/i)?.[1];
    if (!title || !link) continue;
    results.push({ provider: "builtin", title: stripHtml(title), url: stripHtml(link), content: stripHtml(description || "") });
  }
  if (!results.length) throw new Error("Bing RSS returned no results");
  return results;
}

async function searchWithJina(query: string): Promise<SearchResult[]> {
  const text = await fetchText(`https://s.jina.ai/${encodeURIComponent(query)}`, { Accept: "text/plain" });
  const cleaned = text.trim();
  if (!cleaned) throw new Error("Jina returned an empty response");
  return [{ provider: "builtin", title: "Jina web search", url: "", content: cleanText(cleaned, 14000) }];
}

async function searchWithYahoo(query: string): Promise<SearchResult[]> {
  const html = await fetchText(`https://search.yahoo.com/search?p=${encodeURIComponent(query)}`, { Accept: "text/html, */*;q=0.8" });
  const text = stripHtml(html);
  if (!text) throw new Error("Yahoo returned an empty response");
  return [{ provider: "builtin", title: "Yahoo web search", url: "", content: cleanText(text, 12000) }];
}

async function officialCloudflareSearch(query: string): Promise<SearchResult[] | null> {
  if (!/(cloudflare|agents\s+sdk|cloudflare\s+agents)/iu.test(query)) return null;
  const results: SearchResult[] = [];
  if (/(latest|version|نسخه|ورژن|release|released)/iu.test(query)) {
    try {
      const npm = JSON.parse(await fetchText("https://registry.npmjs.org/agents/latest", { Accept: "application/json" })) as { name?: string; version?: string };
      if (npm.version) results.push({ provider: "builtin", title: `Official npm package: ${npm.name || "agents"}@${npm.version}`, url: "https://www.npmjs.com/package/agents", content: `Latest published version: ${npm.version}` });
    } catch {}
  }
  try {
    const changelog = await fetchText("https://developers.cloudflare.com/changelog/product/agents/", { Accept: "text/html, */*;q=0.8" });
    const text = stripHtml(changelog);
    const terms = query.toLowerCase().split(/\s+/).filter((x) => x.length > 3).slice(0, 8);
    const chunks = text.split(/(?=Agents SDK|Agents can|AgentsWorkers)/i);
    const relevant = chunks.filter((chunk) => terms.some((term) => chunk.toLowerCase().includes(term))).slice(0, 5).map((chunk) => cleanText(chunk, 3500));
    if (relevant.length) results.push({ provider: "builtin", title: "Official Cloudflare Agents changelog", url: "https://developers.cloudflare.com/changelog/product/agents/", content: relevant.join("\n\n") });
  } catch {}
  return results.length ? results : null;
}

async function searchBuiltin(query: string): Promise<SearchResponse> {
  const official = await officialCloudflareSearch(query);
  if (official) return { provider: "builtin", query, results: official };
  const errors: string[] = [];
  for (const [name, searcher] of [["Bing RSS", searchWithBingRss], ["Jina", searchWithJina], ["Yahoo", searchWithYahoo]] as const) {
    try {
      return { provider: "builtin", query, results: await searcher(query) };
    } catch (error) {
      errors.push(`${name}: ${String(error)}`);
    }
  }
  throw new Error(`No built-in web results were available for: ${query}. ${errors.join(" | ")}`);
}

async function searchWithTavily(env: Env, query: string, options: { depth?: SearchDepth; maxResults?: number; topic?: SearchTopic } = {}): Promise<SearchResponse> {
  const apiKey = (env as Env & { TAVILY_API_KEY?: string }).TAVILY_API_KEY;
  if (!apiKey) throw new Error("Tavily is not configured: TAVILY_API_KEY is missing");

  const depth = options.depth ?? "basic";
  const maxResults = Math.min(Math.max(options.maxResults ?? 5, 1), 10);
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      search_depth: depth,
      topic: options.topic ?? "general",
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
      ...(depth === "advanced" ? { chunks_per_source: 2 } : {})
    })
  });

  if (!response.ok) {
    const body = cleanText(await response.text(), 800);
    throw new Error(`Tavily HTTP ${response.status}: ${body}`);
  }

  const data = await response.json() as {
    results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
    usage?: { credits?: number };
  };

  const results: SearchResult[] = (data.results ?? []).filter((item) => item.url).map((item) => ({
    provider: "tavily",
    title: item.title || item.url || "Untitled result",
    url: item.url || "",
    content: cleanText(item.content || "", 5000),
    score: typeof item.score === "number" ? item.score : undefined
  }));

  return { provider: "tavily", query, results, creditsUsed: data.usage?.credits };
}

function formatSearchResponse(response: SearchResponse): string {
  const lines = [
    `SEARCH PROVIDER: ${response.provider === "tavily" ? "Tavily" : "Built-in web search"}`,
    `QUERY: ${response.query}`,
    response.creditsUsed !== undefined ? `TAVILY CREDITS USED: ${response.creditsUsed}` : "",
    `RESULT COUNT: ${response.results.length}`,
    "",
    ...response.results.map((result, index) => `${index + 1}. ${result.title}\nURL: ${result.url || "(embedded search result)"}\n${result.content}`)
  ].filter(Boolean);
  return lines.join("\n\n");
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = normalizeUrl(result.url) || `${result.title.toLowerCase()}|${result.content.slice(0, 160).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)<>]+/g)].map((match) => match[0].replace(/[.,;]+$/, ""));
}

async function readWithJina(url: string, max = 7000): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Only HTTP(S) URLs can be read");
  const text = await fetchText(`https://r.jina.ai/${url}`, { Accept: "text/plain" });
  return cleanText(text, max);
}

async function deepWebResearch(env: Env, query: string, depth: "standard" | "deep"): Promise<string> {
  const tavilyDepth: SearchDepth = depth === "deep" ? "advanced" : "basic";
  const maxResults = depth === "deep" ? 8 : 5;
  const maxPages = depth === "deep" ? 5 : 3;
  const searches = await Promise.allSettled([
    searchWithTavily(env, query, { depth: tavilyDepth, maxResults }),
    searchBuiltin(query)
  ]);

  const successful: SearchResponse[] = [];
  const failures: string[] = [];
  for (const result of searches) {
    if (result.status === "fulfilled") successful.push(result.value);
    else failures.push(String(result.reason));
  }

  const combined = dedupeResults(successful.flatMap((response) => response.results));
  const pages = combined.filter((result) => /^https?:\/\//i.test(result.url)).slice(0, maxPages);
  const pageReads = await Promise.allSettled(pages.map(async (result) => ({ result, content: await readWithJina(result.url) })));

  const readSources: Array<{ result: SearchResult; content: string }> = [];
  const readFailures: string[] = [];
  for (const page of pageReads) {
    if (page.status === "fulfilled") readSources.push(page.value);
    else readFailures.push(String(page.reason));
  }

  const providers = [...new Set(successful.map((item) => item.provider === "tavily" ? "Tavily" : "Built-in web search"))];
  const credits = successful.find((item) => item.provider === "tavily")?.creditsUsed;
  const sourceLines = combined.slice(0, 10).map((result, index) => `${index + 1}. ${result.title}\n   ${result.url || "(no direct URL)"}`);
  const readSections = readSources.map(({ result, content }, index) => `SOURCE ${index + 1}\nTitle: ${result.title}\nURL: ${result.url}\nContent: ${content}`);

  return [
    "DEEP WEB RESEARCH REPORT",
    `Query: ${query}`,
    `Mode: ${depth}`,
    `Search providers used: ${providers.join(", ") || "none"}`,
    `Searches completed: ${successful.length}/2`,
    `Unique sources found: ${combined.length}`,
    `Pages selected for reading: ${pages.length}`,
    `Pages successfully read with Jina Reader: ${readSources.length}`,
    credits !== undefined ? `Tavily credits used: ${credits}` : "",
    failures.length ? `Search failures: ${failures.join(" | ")}` : "",
    readFailures.length ? `Page-read failures: ${readFailures.length}` : "",
    "",
    "SOURCES FOUND",
    sourceLines.join("\n"),
    "",
    "READ SOURCE CONTENT",
    readSections.join("\n\n"),
    "",
    "REPORTING INSTRUCTION: In your final answer, clearly state which search provider(s) were actually used, how many sources/pages were examined, and provide the most relevant source URLs. Mention failed providers only when relevant. Never reveal API keys or hidden tool internals."
  ].filter(Boolean).join("\n");
}

async function webSearch(query: string): Promise<string> {
  return formatSearchResponse(await searchBuiltin(query));
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
    return provider("laguna-s-2.1");
  }

  override getSystemPrompt(): string {
    return [
      "You are a concise assistant replying inside a chat thread.",
      "Answer the user's latest message directly.",
      "Use plain text or simple Markdown only.",
      "Do not expose hidden reasoning, tool calls, or internal state.",
      "Your language model is provided by B.AI through an OpenAI-compatible API.",
      "You have multiple web research providers. Choose the appropriate tool yourself.",
      "Use web_search for a quick current lookup, basic verification, documentation, prices, news, software versions, or errors.",
      "Use tavily_search when you want an external ranked search provider, broader discovery, or when built-in search is not sufficient.",
      "Use deep_web_research for comprehensive research, comparisons, fact checking, multi-source questions, or when the user asks for deep research. It combines Tavily, the built-in search, and Jina Reader for selected pages.",
      "Prefer standard depth for ordinary research and deep depth only when the question genuinely benefits from more sources and deeper page reading.",
      "Do not call every search provider for every question. Decide based on the task.",
      "After using a search tool, do not claim a provider was used unless that provider appears in the tool result.",
      "For research answers, finish with a compact 'گزارش جستجو' (or 'Search report') stating the provider(s) actually used, number of sources/pages examined, and the most relevant source URLs.",
      "If a provider fails, continue with another available provider when possible and mention the limitation briefly.",
      "For Cloudflare questions, prefer official Cloudflare and official npm sources when returned by web_search.",
      "Use fetch_to_markdown when you need the readable text of a specific URL.",
      "Use browse when you need rendered HTML or page structure after JavaScript execution.",
      "Use cf_web_fetch when you need a Cloudflare-hosted web fetch.",
      "Web search does NOT use Browser Run. Browser Run is reserved for reading/browsing a specific URL after search.",
      "Interactive browser_execute is intentionally not enabled because it requires Worker Loader/Dynamic Workers on the paid plan.",
      "Prefer official and primary sources for technical questions.",
      "Never claim that you cannot access the web when these tools are available.",
      "Never reveal API keys, environment secrets, or hidden tool internals."
    ].join("\n");
  }

  override getTools(): ToolSet {
    const webSearchTool = tool({
      description: "Quick built-in public web search using ordinary HTTP from the Cloudflare Worker. Use for fast current lookups and verification.",
      inputSchema: jsonSchema<{ query: string }>({ type: "object", properties: { query: { type: "string", description: "Focused web search query" } }, required: ["query"], additionalProperties: false }),
      execute: async ({ query }) => webSearch(query)
    });

    const tavilySearchTool = tool({
      description: "Search the public web with Tavily. Use when an external ranked search provider or broader discovery is useful. Basic is cheaper; advanced is deeper.",
      inputSchema: jsonSchema<{ query: string; depth?: SearchDepth; topic?: SearchTopic; maxResults?: number }>({
        type: "object",
        properties: {
          query: { type: "string", description: "Focused search query" },
          depth: { type: "string", enum: ["basic", "advanced"], description: "Search depth; basic is cheaper" },
          topic: { type: "string", enum: ["general", "news", "finance"], description: "Search topic" },
          maxResults: { type: "number", description: "Maximum results, from 1 to 10" }
        },
        required: ["query"],
        additionalProperties: false
      }),
      execute: async ({ query, depth, topic, maxResults }) => formatSearchResponse(await searchWithTavily(this.env, query, { depth, topic, maxResults }))
    });

    const deepResearchTool = tool({
      description: "Perform multi-source web research. Combines Tavily, built-in search, and Jina Reader to search, deduplicate, and read selected pages. Use for comprehensive research and comparisons.",
      inputSchema: jsonSchema<{ query: string; depth?: "standard" | "deep" }>({
        type: "object",
        properties: {
          query: { type: "string", description: "Research question" },
          depth: { type: "string", enum: ["standard", "deep"], description: "Standard or deeper multi-source research" }
        },
        required: ["query"],
        additionalProperties: false
      }),
      execute: async ({ query, depth }) => deepWebResearch(this.env, query, depth ?? "standard")
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

    return {
      web_search: webSearchTool,
      tavily_search: tavilySearchTool,
      deep_web_research: deepResearchTool,
      fetch_to_markdown: fetchToMarkdown,
      browse,
      cf_web_fetch: cfWebFetch
    };
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    if (ctx.continuation) return;
    const latestUserMessage = [...ctx.messages].reverse().find((message) => message.role === "user");
    const query = extractExplicitSearchQuery(messageText(latestUserMessage));
    if (!query) return;

    // Explicit search requests get a hint, but the model still chooses the provider/tool.
    return {
      system: `${ctx.system}\n\nThe user explicitly requested a web search for: ${query}\nChoose the most appropriate web search tool yourself. Do not assume that the built-in provider is the only option.`,
      activeTools: Object.keys(ctx.tools)
    };
  }

  async resetConversation(): Promise<void> { await this.clearMessages(); }
}
