import { TelegramAdapter } from "@chat-adapter/telegram";

// Telegram normally adds a `bot_command` entity to slash-command messages.
// Some clients/forwarding paths can deliver the same `/command` text without
// that entity, which makes Chat SDK's Telegram adapter silently ignore it.
// Keep the adapter's normal parser first, then add a conservative text fallback.
const originalParseSlashCommand = (TelegramAdapter.prototype as any)
  .parseSlashCommand;

(TelegramAdapter.prototype as any).parseSlashCommand = function (
  telegramMessage: any
) {
  const parsed = originalParseSlashCommand?.call(this, telegramMessage);
  if (parsed) {
    return parsed;
  }

  const text = telegramMessage.text ?? telegramMessage.caption;
  if (typeof text !== "string") {
    return null;
  }

  const trimmed = text.trimStart();
  const match = trimmed.match(
    /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/
  );
  if (!match) {
    return null;
  }

  const configuredUserName =
    (this as any).userName ?? (this as any)._userName ?? "";
  if (
    match[2] &&
    configuredUserName &&
    match[2].toLowerCase() !== String(configuredUserName).toLowerCase()
  ) {
    return null;
  }

  return {
    command: `/${match[1]}`,
    text: match[3] ?? ""
  };
};

export { CodemodeRuntime } from "agents/browser";

const mod = await import("./index");

export const ConversationAgent = mod.ConversationAgent;
export const ThinkMessengerStateAgent = mod.ThinkMessengerStateAgent;
export const getIngressAgentName = mod.getIngressAgentName;
export const ChatIngressAgent = mod.ChatIngressAgent;
export default mod.default;
