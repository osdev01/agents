import {
  ConversationAgent as BaseConversationAgent,
  ThinkMessengerStateAgent,
  getIngressAgentName,
  ChatIngressAgent
} from "./index";

export class ConversationAgent extends BaseConversationAgent {
  includeMcpTools = false;

  override getTools() {
    return {
      ...super.getTools(),
      ...this.mcp.getAITools()
    };
  }
}

export { ThinkMessengerStateAgent, getIngressAgentName, ChatIngressAgent };
export { default } from "./index";
