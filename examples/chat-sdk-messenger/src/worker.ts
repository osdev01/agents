import * as mod from "./index";

// ConversationAgent owns its MCP tools and lifecycle hooks directly.
// Keeping the Worker entry as a thin export avoids prototype monkey-patching
// and lets Think merge the custom tools through its supported getTools() API.
export const ConversationAgent = mod.ConversationAgent;
export const ThinkMessengerStateAgent = mod.ThinkMessengerStateAgent;
export const getIngressAgentName = mod.getIngressAgentName;
export const ChatIngressAgent = mod.ChatIngressAgent;
export default mod.default;
