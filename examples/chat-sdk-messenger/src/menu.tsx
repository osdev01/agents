/** @jsxImportSource chat */

import { Actions, Button, Card, CardText } from "chat";
import { CARD_DEMOS, FILE_DEMOS, MARKDOWN_DEMOS } from "./demos";
import type { Demo, DemoThread } from "./demos";

export const MAIN_MENU_ID = "menu-main";
export const ASK_AGENT_ACTION_ID = "ask-agent";
export const SEARCH_MODE_MENU_ID = "menu-search-mode";
export const SEARCH_MODE_AUTO_ID = "search-mode-auto";
export const SEARCH_MODE_TAVILY_ID = "search-mode-tavily";
export const SEARCH_MODE_EXA_ID = "search-mode-exa";
export const SEARCH_MODE_RESEARCH_ID = "search-mode-research";
export const SEARCH_MODE_BOTH_ID = "search-mode-both";
const MARKDOWN_MENU_ID = "menu-md";
const CARDS_MENU_ID = "menu-card";
const FILES_MENU_ID = "menu-file";

export const MENU_IDS = new Set([
  MAIN_MENU_ID,
  MARKDOWN_MENU_ID,
  CARDS_MENU_ID,
  FILES_MENU_ID,
  SEARCH_MODE_MENU_ID,
  SEARCH_MODE_AUTO_ID,
  SEARCH_MODE_TAVILY_ID,
  SEARCH_MODE_EXA_ID,
  SEARCH_MODE_RESEARCH_ID,
  SEARCH_MODE_BOTH_ID
]);

const DEMO_GROUPS = [
  {
    id: MARKDOWN_MENU_ID,
    title: "Text and Markdown",
    description: "MarkdownV2 rendering and post+edit streaming.",
    demos: MARKDOWN_DEMOS
  },
  {
    id: CARDS_MENU_ID,
    title: "Cards and Actions",
    description: "Cards rendered with Telegram inline keyboards.",
    demos: CARD_DEMOS
  },
  {
    id: FILES_MENU_ID,
    title: "Files",
    description: "Worker-generated file upload through Chat SDK.",
    demos: FILE_DEMOS
  }
];

const SEARCH_MODE_ACTIONS = [
  { id: SEARCH_MODE_AUTO_ID, label: "🤖 Auto", marker: "auto", description: "Tavily first, Exa fallback." },
  { id: SEARCH_MODE_TAVILY_ID, label: "🔎 Tavily", marker: "tavily", description: "Always use Tavily for web search." },
  { id: SEARCH_MODE_EXA_ID, label: "🧠 Exa", marker: "exa", description: "Always use Exa for web search." },
  { id: SEARCH_MODE_RESEARCH_ID, label: "📚 Deep Research", marker: "research", description: "Use Tavily Deep Research." },
  { id: SEARCH_MODE_BOTH_ID, label: "⚖️ Compare / Both", marker: "both", description: "Search with Tavily and Exa and compare." }
] as const;

export const DEMO_LOOKUP = new Map<string, Demo>(
  DEMO_GROUPS.flatMap((group) => group.demos.map((demo) => [demo.id, demo]))
);

export async function postMainMenu(thread: DemoThread): Promise<void> {
  // Keep a plain-text acknowledgement before the rich card so the command
  // remains visibly handled even when a Telegram client has trouble rendering
  // the Chat SDK card/keyboard.
  await thread.post("📋 Menu");
  await thread.post(
    <Card title="Chat SDK on Cloudflare Workers">
      <CardText>
        Pick a category to exercise the Telegram adapter with Agent
        subagent-backed state.
      </CardText>
      {DEMO_GROUPS.map((group) => (
        <Actions key={group.id}>
          <Button id={group.id}>{group.title}</Button>
        </Actions>
      ))}
      <Actions>
        <Button id={SEARCH_MODE_MENU_ID}>⚙️ Search Mode</Button>
      </Actions>
      <Actions>
        <Button id={ASK_AGENT_ACTION_ID}>Ask the Agent</Button>
      </Actions>
    </Card>
  );
}

export async function postAskAgentInstructions(
  thread: DemoThread
): Promise<void> {
  await thread.post(
    <Card title="Ask the Agent">
      <CardText>
        DM me a question for an AI response. In a group, mention me or start a
        message with /ask. Send /reset to clear this thread's AI history.
      </CardText>
    </Card>
  );
}

export async function postMenu(
  thread: DemoThread,
  menuId: string
): Promise<void> {
  if (menuId === SEARCH_MODE_MENU_ID) {
    await thread.post(
      <Card title="⚙️ Search Mode">
        <CardText>
          Choose which web-search strategy this Telegram thread should use.
        </CardText>
        {SEARCH_MODE_ACTIONS.map((mode) => (
          <Actions key={mode.id}>
            <Button id={mode.id}>{mode.label}</Button>
          </Actions>
        ))}
        <Actions>
          <Button id={MAIN_MENU_ID}>Back to main menu</Button>
        </Actions>
      </Card>
    );
    return;
  }

  const selectedMode = SEARCH_MODE_ACTIONS.find((mode) => mode.id === menuId);
  if (selectedMode) {
    await thread.post(
      <Card title={`Search Mode: ${selectedMode.label}`}>
        <CardText>
          [SEARCH_MODE:{selectedMode.marker}]
          {"\n\n"}
          {selectedMode.description}
          {"\n\n"}
          This mode applies to the current Telegram thread until you choose another mode.
        </CardText>
        <Actions>
          <Button id={SEARCH_MODE_MENU_ID}>⚙️ Change Search Mode</Button>
        </Actions>
        <Actions>
          <Button id={MAIN_MENU_ID}>Back to main menu</Button>
        </Actions>
      </Card>
    );
    return;
  }

  const group = DEMO_GROUPS.find((item) => item.id === menuId);
  if (!group) {
    await postMainMenu(thread);
    return;
  }

  await thread.post(
    <Card title={group.title}>
      <CardText>{group.description}</CardText>
      {group.demos.map((demo) => (
        <Actions key={demo.id}>
          <Button id={demo.id}>{demo.label}</Button>
        </Actions>
      ))}
      <Actions>
        <Button id={MAIN_MENU_ID}>Back to main menu</Button>
      </Actions>
    </Card>
  );
}
