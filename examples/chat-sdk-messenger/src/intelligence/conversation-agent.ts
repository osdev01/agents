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
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/gi, "'")
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

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function searchWithJina(query: string): Promise<string> {
  const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
  const text = await fetchText(url, { Accept: "text/plain" });
  const cleaned = text.trim();
  if (!cleaned) throw new Error("Jina returned an empty response");
  return cleanText(cleaned, 14000);
}

function parseBingRss(xml: string): string {
  const items: string[] = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemPattern.exec(xml)) && items.length < 8) {
    const item = itemMatch[1];
    const title = item.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
    const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1];
    const description = item.match(/<description>([\s\S]*?)<\/description>/i)?.[1];
    if (!title || !link) continue;
    items.push(
      `${items.length + 1}. ${stripHtml(title)}\nURL: ${stripHtml(link)}\n${stripHtml(description || "")}`
    );
  }

  return items.join("\n\n");
}

async function searchWithBingRss(query: string): Promise<string> {
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  const xml = await fetchText(url, { Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8" });
  const results = parseBingRss(xml);
  if (!results) throw new Error("Bing RSS returned no results");
  return results;
}

async function searchWithYahoo(query: string): Promise<string> {
  const url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
  const html = await fetchText(url, { Accept: "text/html, */*;q=0.8" });
  const text = stripHtml(html);
  if (!text) throw new Error("Yahoo returned an empty response");
  return cleanText(text, 12000);
}

async function webSearch(query: string): Promise<string> {
  const errors: string[] = [];

  // Search is deliberately done with ordinary Worker fetch(), not Browser Run.
  // This avoids the Free-plan Browser Run Quick Action 429 limit.
  for (const [name, searcher] of [
    ["Jina", searchWithJina],
    ["Bing RSS", searchWithBingRss],
    ["Yahoo", searchWithYahoo]
  ] as const) {
    try {
      const results = await searcher(query);
      return `WEB SEARCH RESULTS (${name})\n\n${results}`;
    } catch (error) {
      errors.push(`${name}: ${String(error)}`);
    }
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
  const match = text.match(
    /(?:در\s+وب\s+جستجو\s+کن|در\s+اینترنت\s+جستجو\s+کن|وب\s+جستجو\s+کن|در\s+وب\s+سرچ\s+کن|سرچ\s+کن|جستجو\s+کن|search\s+the\s+web|search\s+online|search\s+the\s+internet)\s*:?[\s-]*(.+)$/iu
  );
  return match?.[1]?.trim() || null;
}

export class ConversationAgent extends Think {
  override getModel() {
    return "@cf/zai-org/glm-4.7-flash";
  }

  override getSystemPrompt(): string {
    return [
      "You are a concise assistant replying inside a chat thread.",
      "Answer the user's latest message directly.",
      "Use plain text or simple Markdown only.",
      "Do not expose hidden reasoning, tool calls, or internal state.",
      "",
      "You have web search through ordinary Cloudflare Worker fetch() and Cloudflare Browser Run Quick Actions.",
      "Use web_search for current information, web research, documentation, prices, news, software versions, errors, and verification.",
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
      description: "Search the public web using ordinary HTTP from the Cloudflare Worker. This does not consume Browser Run.",
      inputSchema: jsonSchema<{ query: string }>({
        type: "object",
        properties: { query: { type: "string", description: "Focused web search query" } },
        required: ["query"],
        additionalProperties: false
      }),
      execute: async ({ query }) => webSearch(query)
    });

    const fetchToMarkdown = tool({
      description: "Fetch a public URL through Cloudflare Browser Run and return clean Markdown. Use this after search when you need to inspect a source page.",
      inputSchema: jsonSchema<{ url: string }>({
        type: "object",
        properties: { url: { type: "string", description: "Public URL to fetch" } },
        required: ["url"],
        additionalProperties: false
      }),
      execute: async ({ url }) => browserMarkdown(this.env.BROWSER, { url })
    });

    const browse = tool({
      description: "Open a public URL in Cloudflare Browser Run and return rendered HTML. Use only when page rendering or JavaScript is needed.",
      inputSchema: jsonSchema<{ url: string }>({
        type: "object",
        properties: { url: { type: "string", description: "Public URL to browse" } },
        required: ["url"],
        additionalProperties: false
      }),
      execute: async ({ url }) => browserContent(this.env.BROWSER, { url })
    });

    const cfWebFetch = tool({
      description: "Fetch a public URL through Cloudflare Browser Run. Return Markdown when possible, otherwise rendered content.",
      inputSchema: jsonSchema<{ url: string }>({
        type: "object",
        properties: { url: { type: "string", description: "Public URL to fetch" } },
        required: ["url"],
        additionalProperties: false
      }),
      execute: async ({ url }) => {
        try {
          return await browserMarkdown(this.env.BROWSER, { url });
        } catch {
          return await browserContent(this.env.BROWSER, { url });
        }
      }
    });

    return {
      web_search: webSearchTool,
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

    const webResults = await webSearch(query);
    return {
      system: `${ctx.system}\n\nWEB SEARCH RESULTS FOR THIS TURN:\n${webResults}\n\nUse these results to answer the user's request. Do not repeat the same search unless the results are insufficient.`,
      activeTools: Object.keys(ctx.tools)
    };
  }

  async resetConversation(): Promise<void> {
    await this.clearMessages();
  }
}
