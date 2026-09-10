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
      .replace(/<script[\\s\\S]*?<\\/script>/gi, " ")
      .replace(/<style[\\s\\S]*?<\\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\\s+/g, " ")
      .trim()
  );
}

function parseSearchResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const pattern = /<a[^>]+class=[\"']result__a[\"'][^>]+href=[\"']([^\"']+)[\"'][^>]*>([\\s\\S]*?)<\\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) && results.length < 5) {
    let url = decodeHtml(match[1]);
    const title = stripHtml(match[2]);
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) {
      try {
        url = decodeURIComponent(redirect[1]);
      } catch {
        // Keep the original URL when decoding fails.
      }
    }
    if (!/^https?:\\/\\//i.test(url) || !title) continue;

    const from = match.index;
    const nearby = html.slice(from, from + 5000);
    const snippetMatch = nearby.match(/<a[^>]+class=[\"']result__snippet[\"'][^>]*>([\\s\\S]*?)<\\/a>|<div[^>]+class=[\"'][^\"']*result__snippet[^\"']*[\"'][^>]*>([\\s\\S]*?)<\\/div>/i);
    results.push({
      title,
      url,
      snippet: stripHtml(snippetMatch?.[1] ?? snippetMatch?.[2] ?? "")
    });
  }

  return results;
}

function extractPageText(html: string): string {
  const main = html.match(/<main[\\s\\S]*?<\\/main>/i)?.[0]
    ?? html.match(/<article[\\s\\S]*?<\\/article>/i)?.[0]
    ?? html;
  return stripHtml(main).slice(0, 12000);
}

const webSearchTool = tool({
  description: "Search the public web for current information. Use this for questions that need fresh web research.",
  inputSchema: jsonSchema<{ query: string }>({
    type: "object",
    properties: { query: { type: "string", description: "The web search query" } },
    required: ["query"],
    additionalProperties: false
  }),
  execute: async ({ query }) => {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CloudflareAgent/1.0)"
      }
    });
    if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}`);

    const results = parseSearchResults(await response.text());
    if (results.length === 0) return "No web results found.";

    const pages = await Promise.all(
      results.slice(0, 3).map(async (result) => {
        try {
          const page = await fetch(result.url, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; CloudflareAgent/1.0)" },
            redirect: "follow"
          });
          if (!page.ok) return { ...result, content: `HTTP ${page.status}` };
          const contentType = page.headers.get("content-type") ?? "";
          if (!contentType.includes("text/html")) return { ...result, content: contentType };
          return { ...result, content: extractPageText(await page.text()) };
        } catch (error) {
          return { ...result, content: `Could not fetch page: ${String(error)}` };
        }
      })
    );

    return pages
      .map((page, index) => `${index + 1}. ${page.title}\nURL: ${page.url}\nSnippet: ${page.snippet}\nContent: ${page.content}`)
      .join("\n\n");
  }
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
      "You have a web_search tool for current web research.",
      "Use it whenever the user asks you to search the web, research a current topic, inspect a public webpage, or verify current documentation.",
      "Do not claim to have searched the web unless you actually used the tool.",
      "Prefer recent primary sources and official documentation when researching technical topics.",
      "Summarize useful results and include the source URLs in the answer."
    ].join("\n");
  }

  override getTools(): ToolSet {
    return { web_search: webSearchTool };
  }

  async resetConversation(): Promise<void> {
    await this.clearMessages();
  }
}
