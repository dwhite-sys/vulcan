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


export interface EtnaServerProfile {
  id: string;
  name: string;
  url: string;
  networkPointOfView: 'client' | 'server';
  clientId?: string | null;
  enabled: boolean;
  healthy: boolean;
  inventory?: KitWithTools[];
}

export interface EtnaKitSource {
  serverId: string;
  name: string;
  url: string;
  networkPointOfView: 'client' | 'server';
  clientId?: string | null;
  healthy: boolean;
  enabled: boolean;
}

export interface LogicalEtnaKit extends KitWithTools {
  logical_id: string;
  sources: EtnaKitSource[];
  selected_server_id?: string | null;
  unresolved_conflict: boolean;
  effective_source?: EtnaKitSource | null;
}

export interface EtnaSummary {
  servers: number;
  kits: number;
  tools: number;
  healthy: number;
  configured: number;
  conflictServerIds: string[];
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

/** A stable quotation provenance record; its visible number follows array order. */
export interface MessageQuote {
  id: string;
  text: string;
  messageId: string;
  sourceRole: 'user' | 'assistant';
  start: number;
  end: number;
}

/** A bounded pointer to a workspace file; historical revisions are explicit. */
export interface MessageFileReference {
  id: string;
  path: string;
  startLine?: number;
  endLine?: number;
  revision?: string;
  selectedText?: string;
  startColumn?: number;
  endColumn?: number;
}

export interface MessageElementReference {
  id: string;
  designId: string;
  locator: string;
  hierarchyAddress: string;
  tagName: string;
  text?: string;
  url?: string;
  route?: string;
  attributes?: Record<string, string>;
}

/** A registered live HTTP surface attached to a conversation. */
export interface DesignAttachment {
  version: 1;
  id: string;
  name: string;
  url: string;
  attachedAt: Date;
  updatedAt: Date;
}

export type ComposerContextItem =
  | (MessageQuote & { kind: 'quote' })
  | (MessageFileReference & { kind: 'reference' })
  | (MessageElementReference & { kind: 'element' });


export interface MessageEditPayload {
  content: string;
  attachments?: MessageAttachment[];
  newFiles?: File[];
  quotes?: MessageQuote[];
  references?: MessageFileReference[];
  elements?: MessageElementReference[];
  contextOrder?: string[];
}

export type EventStatus = 'streaming' | 'running' | 'complete' | 'error' | 'interrupted';

interface BaseChatEvent {
  id: string;
  timestamp: Date;
  /** One user request / agentic run. Used only for grouping, never for ordering. */
  runId?: string;
  /** One provider assistant response inside an agentic run. */
  turnId?: string;
}

export interface UserMessageEvent extends BaseChatEvent {
  type: 'user_message';
  content: string;
  attachments?: MessageAttachment[];
  quotes?: MessageQuote[];
  references?: MessageFileReference[];
  elements?: MessageElementReference[];
  contextOrder?: string[];
  /** CLI workspace notice sent to the model but intentionally hidden from the transcript. */
  attachmentNotices?: string;
}

export interface AssistantTextEvent extends BaseChatEvent {
  type: 'assistant_text';
  content: string;
  status: EventStatus;
}

export interface ReasoningEvent extends BaseChatEvent {
  type: 'reasoning';
  content: string;
  status: EventStatus;
  reasoningDetails?: any[];
  reasoningWire?: 'reasoning' | 'reasoning_content' | 'reasoning_details' | 'thinking' | 'inline';
  completedAt?: Date;
}

/**
 * A tool invocation occupies one immutable position in the transcript.
 * Its arguments/result/status may be filled in as the call streams and executes,
 * but the event itself never moves. This is what makes live and restored rendering identical.
 */
export interface ToolEvent extends BaseChatEvent {
  type: 'tool';
  callId: string;
  tool: string;
  arguments: Record<string, any>;
  rawArguments?: string;
  rawToolCall?: any;
  status: EventStatus;
  result?: ToolResult;
}

export interface SystemMessageEvent extends BaseChatEvent {
  type: 'system_message';
  content: string;
}

export interface PresentedFileEvent extends BaseChatEvent {
  type: 'presented_file';
  file: PresentedFile;
}

export interface PanelEvent extends BaseChatEvent {
  type: 'panel';
  panel: Panel;
}

export type ChatEvent =
  | UserMessageEvent
  | AssistantTextEvent
  | ReasoningEvent
  | ToolEvent
  | SystemMessageEvent
  | PresentedFileEvent
  | PanelEvent;

/**
 * Legacy render-only shape retained for a few leaf UI components. It is never
 * persisted and is never the source of transcript ordering.
 */
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  thinking?: string;
  attachments?: MessageAttachment[];
  quotes?: MessageQuote[];
  references?: MessageFileReference[];
  elements?: MessageElementReference[];
  contextOrder?: string[];
  toolCall?: { tool: string; arguments: Record<string, any> };
  toolResult?: ToolResult;
  toolStatus?: EventStatus;
  timestamp: Date;
  presentedFiles?: PresentedFile[];
  panels?: Panel[];
}

export type BranchOrigin = 'root' | 'edit' | 'regen' | 'jump';

export interface BranchEventNode {
  event: ChatEvent;
  /** Canonical topology: every event points only to its parent; children are derived by reverse lookup. */
  parentId: string | null;
}

export interface BranchRecord {
  id: string;
  parentBranchId: string | null;
  origin: BranchOrigin;
  title: string;
  titleSource: 'auto' | 'user';
  createdAt: Date;
  updatedAt: Date;
  /** Presentation metadata points at a leaf; the event parent graph remains topology authority. */
  headEventId: string | null;
}

export interface BranchingState {
  version: 1;
  currentBranchId: string;
  /** Append-only event graph. Each event appears once regardless of how many branches inherit it. */
  nodes: BranchEventNode[];
  branches: BranchRecord[];
}

export interface Chat {
  schemaVersion: 2;
  id: string;
  title: string | null; // null = pending (not yet shown in sidebar)
  events: ChatEvent[];
  createdAt: Date;
  updatedAt: Date;
  enabledKits?: string[];       // kit names enabled for this chat (undefined = use defaults)
  disabledTools?: string[];     // "kit::tool" keys disabled for this chat
  folderId?: string | null;      // parent chat-folder id; null/undefined = root
  tags?: string[];               // server-derived, searchable message-cluster topics
  branching?: BranchingState;     // alternate conversation histories within this chat
  designs?: DesignAttachment[]; // registered live web surfaces attached to this conversation
  /** Internal sidebar projection marker. Full transcript state is loaded on selection. */
  _summaryOnly?: boolean;
}

export interface ChatFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
  collapsed?: boolean;          // persisted chat-folder collapsed state; undefined = expanded
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
  generation?: number; // forces a fresh viewer when resuming an expired PTY
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
