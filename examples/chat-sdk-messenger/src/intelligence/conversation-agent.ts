import { Think, type TurnContext, type TurnConfig } from "@cloudflare/think";
import { createBrowserTools } from "@cloudflare/think/tools/browser";
import { browserContent, browserMarkdown } from "agents/browser";
import { tool, jsonSchema, type ToolSet } from "ai";

function cleanText(value: string, max = 12000): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function extractLinks(html: string): { title: string; url: string }[] {
  const results: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  const pattern = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) && results.length < 8) {
    const url = match[1];
    const title = cleanText(match[2].replace(/<[^>]+>/g, ""), 300);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    if (/google\.(?:com|de|co\.uk)\//i.test(url)) continue;
    if (/^https?:\/\/(?:www\.)?bing\.com\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url });
  }

  return results;
}

async function readSearchResults(browser: Env["BROWSER"], searchUrl: string, engine: string): Promise<string> {
  const html = await browserContent(browser, { url: searchUrl });
  const links = extractLinks(html);
  if (links.length === 0) {
    throw new Error(`${engine}: no search results extracted`);
  }

  const pages = await Promise.all(
    links.slice(0, 5).map(async (result, index) => {
      try {
        const markdown = await browserMarkdown(browser, { url: result.url });
        return `${index + 1}. ${result.title}\nURL: ${result.url}\n${cleanText(markdown, 7000)}`;
      } catch (error) {
        return `${index + 1}. ${result.title}\nURL: ${result.url}\nCould not read page: ${String(error)}`;
      }
    })
  );

  return pages.join("\n\n");
}

async function browserWebSearch(browser: Env["BROWSER"], query: string): Promise<string> {
  const engines = [
    {
      name: "Google",
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}&num=8&hl=en&gbv=1`
    },
    {
      name: "Bing",
      url: `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=8`
    }
  ];
  const errors: string[] = [];

  for (const engine of engines) {
    try {
      return await readSearchResults(browser, engine.url, engine.name);
    } catch (error) {
      errors.push(`${engine.name}: ${String(error)}`);
    }
  }

  return `No web results were available for: ${query}\nSearch attempts: ${errors.join(" | ")}`;
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
      "You have Cloudflare Browser Run tools for web research.",
      "Use web_search for current information, web research, documentation, prices, news, software versions, errors, and verification.",
      "Use fetch_to_markdown when you need the readable text of a URL.",
      "Use browse when you need rendered HTML or page structure after JavaScript execution.",
      "Use cf_web_fetch when you need a Cloudflare-hosted web fetch and prefer it over a normal fetch.",
      "Use browser_execute for interactive browser automation when a simple fetch is not enough.",
      "Prefer official and primary sources for technical questions.",
      "Never claim that you cannot access the web when these tools are available.",
      "After research, summarize the findings and include relevant source URLs."
    ].join("\n");
  }

  override getTools(): ToolSet {
    const browserTools = createBrowserTools({
      ctx: this.ctx,
      browser: this.env.BROWSER,
      loader: this.env.LOADER,
      quickActions: { maxChars: 12000 }
    });

    const webSearch = tool({
      description: "Search Google and Bing through Cloudflare Browser Run, then read the most relevant result pages. Use for current web research and verification.",
      inputSchema: jsonSchema<{ query: string }>({
        type: "object",
        properties: { query: { type: "string", description: "Focused web search query" } },
        required: ["query"],
        additionalProperties: false
      }),
      execute: async ({ query }) => browserWebSearch(this.env.BROWSER, query)
    });

    const fetchToMarkdown = tool({
      description: "Fetch a public URL through Cloudflare Browser Run and return clean Markdown. Best for documentation, articles, and readable page content.",
      inputSchema: jsonSchema<{ url: string }>({
        type: "object",
        properties: { url: { type: "string", description: "Public URL to fetch" } },
        required: ["url"],
        additionalProperties: false
      }),
      execute: async ({ url }) => browserMarkdown(this.env.BROWSER, { url })
    });

    const browse = tool({
      description: "Open a public URL in Cloudflare Browser Run and return rendered HTML. Use when JavaScript-generated page content or structure matters.",
      inputSchema: jsonSchema<{ url: string }>({
        type: "object",
        properties: { url: { type: "string", description: "Public URL to browse" } },
        required: ["url"],
        additionalProperties: false
      }),
      execute: async ({ url }) => browserContent(this.env.BROWSER, { url })
    });

    const cfWebFetch = tool({
      description: "Fetch a public URL through Cloudflare Browser Run. Prefer this over direct fetch when web content should be observable and rendered by Cloudflare.",
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
      ...browserTools,
      web_search: webSearch,
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

    const webResults = await browserWebSearch(this.env.BROWSER, query);
    return {
      system:
        `${ctx.system}\n\nWEB RESEARCH RESULTS FOR THIS TURN:\n${webResults}\n\n` +
        "Use these results to answer the user's request. Do not repeat the same search.",
      activeTools: Object.keys(ctx.tools).filter((name) => name !== "web_search")
    };
  }

  async resetConversation(): Promise<void> {
    await this.clearMessages();
  }
}
