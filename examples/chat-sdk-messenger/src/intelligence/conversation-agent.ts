import { Think } from "@cloudflare/think";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
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
      "You have access to a real browser through the execute tool.",
      "Use it when the user asks you to:",
      "- search or research something on the web",
      "- inspect a website or webpage",
      "- read current documentation",
      "- investigate a current error or technical issue",
      "- inspect rendered web content or JavaScript-based pages",
      "- take screenshots or inspect browser state",
      "",
      "When web information is needed, actually use the execute tool and browser CDP instead of guessing.",
      "For simple page reads, use the browser CDP efficiently; for multi-step interaction, reuse the browser session within the execution when possible.",
      "Keep replies concise and summarize browser results rather than dumping large page contents."
    ].join("\n");
  }

  override getTools(): ToolSet {
    return {
      execute: createExecuteTool(this)
    };
  }

  async resetConversation(): Promise<void> {
    await this.clearMessages();
  }
}
