import { Think } from "@cloudflare/think";
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

const webSearchTool = tool({
  description: "Search the public web for current information and open the most relevant result pages. Use this whenever the user asks for web search, current information, research, documentation, prices, news, software versions, errors, or verification.",
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
      "A server-side web_search tool is available to you for non-Telegram contexts.",
      "For requests involving current information, web research, documentation, prices, news, software versions, errors, or facts that may have changed, use web_search when tool calling is supported.",
      "If web search results are provided in the user message, treat them as research context and answer from them.",
      "Do not say that you lack internet access when web search results are available.",
      "Do not claim that you searched unless search results were actually provided or returned by the tool.",
      "Prefer official and primary sources for technical questions.",
      "After searching, summarize the relevant findings and include the source URLs."
    ].join("\n");
  }

  override getTools(): ToolSet {
    return { web_search: webSearchTool };
  }

  async resetConversation(): Promise<void> {
    await this.clearMessages();
  }
}
