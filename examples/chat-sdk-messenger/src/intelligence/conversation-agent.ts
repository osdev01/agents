import { Think } from "@cloudflare/think";
import { createBrowserTools } from "@cloudflare/think/tools/browser";
import type { ToolSet } from "ai";

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
      "You have access to browser tools.",
      "Use the browser when the user asks you to:",
      "- search or research something on the web",
      "- inspect a website or webpage",
      "- read current documentation",
      "- investigate a current error or technical issue",
      "- inspect rendered web content or JavaScript-based pages",
      "",
      "When web information is needed, actually use the browser tools instead of guessing.",
      "Prefer lightweight browser actions when possible.",
      "Use browser_execute when interactive browser control is necessary."
    ].join("\n");
  }

  override getTools(): ToolSet {
    return {
      ...createBrowserTools({
        ctx: this.ctx,
        browser: this.env.BROWSER,
        loader: this.env.LOADER
      })
    };
  }

  async resetConversation(): Promise<void> {
    await this.clearMessages();
  }
}
