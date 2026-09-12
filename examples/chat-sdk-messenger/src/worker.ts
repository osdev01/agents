export { CodemodeRuntime } from "agents/browser";

const mod = await import("./index");

// Cloudflare Think supports additive per-turn tools. Explicitly inject the
// Exa tool into every ConversationAgent search turn so activeTools can never
// hide it from the model when the runtime assembles the turn.
const conversationPrototype = mod.ConversationAgent.prototype as any;
const originalBeforeTurn = conversationPrototype.beforeTurn;
conversationPrototype.beforeTurn = function (ctx: any) {
  const config = originalBeforeTurn?.call(this, ctx) ?? {};
  const registeredTools = this.getTools?.() ?? {};
  const exaSearch = registeredTools.exa_search;
  if (!exaSearch) {
    console.error("[EXA] exa_search tool is missing from ConversationAgent.getTools()");
    return config;
  }

  return {
    ...config,
    tools: {
      ...(config.tools ?? {}),
      exa_search: exaSearch
    }
  };
};

export const ConversationAgent = mod.ConversationAgent;
export const ThinkMessengerStateAgent = mod.ThinkMessengerStateAgent;
export const getIngressAgentName = mod.getIngressAgentName;
export const ChatIngressAgent = mod.ChatIngressAgent;
export default mod.default;
