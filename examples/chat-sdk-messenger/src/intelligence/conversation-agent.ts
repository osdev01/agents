import { Think, type TurnContext, type TurnConfig } from "@cloudflare/think";
import { tool, jsonSchema, type ToolSet } from "ai";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const pattern = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) && results.length < 5) {
    let url = decodeHtml(match[1]);
    const title = stripHtml(match[2]);
    const redirect = url.match(/[?&](?:uddg)=([^&]+)/i);
    if (redirect) {
      try {
        url = decodeURIComponent(redirect[1]);
      } catch {
        // Keep the original URL when decoding fails.
      }
    }
    if (!/^https?:\/\//i.test(url) || !title) continue;

    const nearby = html.slice(match.index, match.index + 7000);
    const snippetMatch = nearby.match(
      /<(?:a|div)[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i
    );

    results.push({
      title,
      url,
      snippet: stripHtml(snippetMatch?.[1] ?? "")
    });
  }

  return results;
}

async function searchEngine(url: string): Promise<SearchResult[]> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; CloudflareAgent/1.0; +https://developers.cloudflare.com/workers/)"
    }
  });
  if (!response.ok) throw new Error(`Search engine returned HTTP ${response.status}`);
  return parseDuckDuckGo(await response.text());
}

function extractPageText(html: string): string {
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0]
    ?? html.match(/<article[\s\S]*?<\/article>/i)?.[0]
    ?? html;
  return stripHtml(main).slice(0, 8000);
}

export async function searchWeb(query: string): Promise<string> {
  let results: SearchResult[] = [];
  let searchError = "";

  try {
    results = await searchEngine(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    );
  } catch (error) {
    searchError = String(error);
  }

  if (results.length === 0) {
    return `No web results were available for: ${query}${searchError ? ` (${searchError})` : ""}`;
  }

  const pages = await Promise.all(
    results.slice(0, 3).map(async (result) => {
      try {
        const page = await fetch(result.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; CloudflareAgent/1.0)"
          },
          redirect: "follow"
        });
        if (!page.ok) return { ...result, content: `HTTP ${page.status}` };
        const contentType = page.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html")) {
          return { ...result, content: `Non-HTML response: ${contentType}` };
        }
        return { ...result, content: extractPageText(await page.text()) };
      } catch (error) {
        return { ...result, content: `Could not fetch page: ${String(error)}` };
      }
    })
  );

  return pages
    .map(
      (page, index) =>
        `${index + 1}. ${page.title}\nURL: ${page.url}\nSnippet: ${page.snippet}\nContent: ${page.content}`
    )
    .join("\n\n");
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "user") return "";
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return "";

  return candidate.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractExplicitSearchQuery(text: string): string | null {
  const match = text.match(
    /(?:در\s+وب\s+جستجو\s+کن|در\s+اینترنت\s+جستجو\s+کن|وب\s+جستجو\s+کن|در\s+وب\s+سرچ\s+کن|سرچ\s+کن|جستجو\s+کن|search\s+the\s+web|search\s+online|search\s+the\s+internet)\s*:?[\s-]*(.+)$/iu
  );
  return match?.[1]?.trim() || null;
}

const webSearchTool = tool({
  description: "Search the public web for current information and open the most relevant result pages. Use this when the user asks for current information, web research, documentation, prices, news, software versions, errors, or verification and the answer cannot be reliably given from the conversation alone.",
  inputSchema: jsonSchema<{ query: string }>({
    type: "object",
    properties: {
      query: { type: "string", description: "A focused web search query" }
    },
    required: ["query"],
    additionalProperties: false
  }),
  execute: async ({ query }) => searchWeb(query)
});

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
      "A server-side web_search tool is available.",
      "Use web_search when the user asks for current information, web research, documentation, prices, news, software versions, errors, or facts that may have changed.",
      "If web search results are provided in the turn context, use them as research context and do not search for the same request again.",
      "Do not say that you lack internet access when web search is available or when search results are provided.",
      "Do not claim that you searched unless search results were actually returned by the tool or provided in the turn context.",
      "Prefer official and primary sources for technical questions.",
      "After web research, summarize the relevant findings and include source URLs."
    ].join("\n");
  }

  override getTools(): ToolSet {
    return { web_search: webSearchTool };
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    // For an explicit search request, do the search before the model stream.
    // This keeps the Telegram-visible stream text-only and prevents a second
    // identical web_search tool call during the same turn.
    if (ctx.continuation) return;

    const latestUserMessage = [...ctx.messages].reverse().find((message) => {
      return message.role === "user";
    });
    const query = extractExplicitSearchQuery(messageText(latestUserMessage));
    if (!query) return;

    const webResults = await searchWeb(query);
    return {
      system:
        `${ctx.system}\n\n` +
        `WEB SEARCH RESULTS FOR THIS TURN:\n${webResults}\n\n` +
        `Use these results to answer the user's request. Do not call web_search again for this same request. Include relevant source URLs.` ,
      activeTools: Object.keys(ctx.tools).filter((name) => name !== "web_search")
    };
  }

  async resetConversation(): Promise<void> {
    await this.clearMessages();
  }
}
