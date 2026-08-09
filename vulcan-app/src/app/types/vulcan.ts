// Vulcan Type Definitions

export interface Kit {
  kit_name: string;
  kit_description: string;
  filename: string;
  enabled: boolean;
  skill?: string | null;
}

export interface ToolParameter {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter;
}

export interface KitWithTools extends Kit {
  tools: Tool[];
}

export interface ToolResult {
  result?: any;
  error?: string;
}

export interface MessageAttachment {
  name: string;
  size: number;
  type: string;
  dataUrl?: string; // base64 data URL for images, for thumbnail display
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  thinking?: string;
  attachments?: MessageAttachment[];
  attachmentNotices?: string; // CLI workspace: injected into LLM context but not displayed
  toolCall?: {
    tool: string;
    arguments: Record<string, any>;
  };
  toolCalls?: any[];           // raw OAI tool_calls array — preserved for history reconstruction
  toolResult?: ToolResult;
  timestamp: Date;
  presentedFiles?: PresentedFile[]; // files presented by agent in this turn
  panels?: Panel[];            // panels opened/updated by agent in this turn
  isAnnouncement?: boolean;   // true when model emitted content + tool_calls in same response
}

export interface Chat {
  id: string;
  title: string | null; // null = pending (not yet shown in sidebar)
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  enabledKits?: string[];       // kit names enabled for this chat (undefined = use defaults)
  disabledTools?: string[];     // "kit::tool" keys disabled for this chat
  folderId?: string | null;      // parent chat-folder id; null/undefined = root
  sidebarOrder?: number;         // ordering among chats/folders with the same parent
  containerScope?: 'chat' | 'global'; // execution environment; undefined = per-chat container
}

export interface ChatFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
  sidebarOrder?: number;
  collapsed?: boolean;          // persisted chat-folder collapsed state; undefined = expanded
  scope?: 'chat' | 'global';     // sidebar namespace; undefined = regular chats
}


export interface UserQuestionCall {
  toolCallId: string;
  question: string;
  options: string[];
}

export interface UserQuestionAnswer {
  status: 'answered' | 'skipped';
  answer?: string;
  source?: 'option' | 'custom';
  option_index?: number;
}

export interface UserQuestionBatch {
  id: string;
  chatId: string;
  questions: UserQuestionCall[];
}

export interface AppLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// ── Artifacts / workspace types ───────────────────────────────────────────────

export interface PresentedFile {
  path: string;         // relative path within the chat workspace
  name: string;         // display name (basename)
  presentedAt: Date;    // when the agent called present()
  messageId: string;    // which assistant turn presented it
}

export interface Panel {
  name: string;         // unique identifier within a chat — same name = replace
  updatedAt: Date;      // when the agent last called open_panel with this name
  messageId: string;    // which assistant turn last updated it
}

// ── Terminal slots ────────────────────────────────────────────────────────────

export type SlotKind = 'agent' | 'user';

export interface TerminalSlotMeta {
  kind: SlotKind;
  slot: number;         // 1-3
  chatId: string;
  status: 'connected' | 'disconnected' | 'closed-inactivity';
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;      // e.g. "Agent: presented report.md"
  author: 'agent' | 'user';
  timestamp: Date;
}

export interface FileSnapshot {
  id: string;           // local snapshot ID (not a git hash)
  path: string;
  timestamp: Date;
  source: 'agent' | 'user';
}

export type TimelineEntry =
  | { kind: 'commit'; commit: GitCommit }
  | { kind: 'snapshot'; snapshot: FileSnapshot };