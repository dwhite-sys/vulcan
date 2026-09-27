// LLM inference service — OpenAI-compatible API

import type { Tool } from '../types/vulcan';

export interface LLMConfig {
  baseUrl: string;   // e.g. https://openrouter.ai/api/v1
  apiKey: string;
  model: string;
  providerId?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  networkPointOfView: 'client' | 'server';
}


export type ReasoningWire = 'reasoning' | 'reasoning_content' | 'reasoning_details' | 'thinking' | 'inline';

export type LLMStreamEvent =
  | { type: 'reasoning_delta'; delta: string; wire?: ReasoningWire; details?: any[] }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_delta'; index: number; id?: string; nameDelta?: string; argumentsDelta?: string };

const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

async function fetchJsonWithRetry(url: string, init: RequestInit, attempts = 2): Promise<any> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return await response.json();
      if (!TRANSIENT_HTTP.has(response.status) || attempt + 1 >= attempts) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      lastError = new Error(`Transient HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) throw error;
    } finally {
      window.clearTimeout(timer);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  throw lastError instanceof Error ? lastError : new Error('Provider request failed');
}

export interface ModelInfo {
  id: string;
  name?: string;
  owned_by?: string;
  providerId?: string;
  providerName?: string;
}

export async function listModelsForProvider(provider: Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'id' | 'name' | 'networkPointOfView'>): Promise<ModelInfo[]> {
  if (!provider.baseUrl) throw new Error('No inference endpoint configured');
  let data: any;
  if (provider.networkPointOfView === 'server') {
    const { generalWS } = await import('./ws');
    data = await generalWS.send('providers/models', { provider });
  } else {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    data = await fetchJsonWithRetry(`${provider.baseUrl.replace(/\/$/, '')}/models`, { headers });
  }
  return (data.data || []).map((m: ModelInfo) => ({ ...m, providerId: provider.id, providerName: provider.name }));
}

export async function testProviderConnection(provider: Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'id' | 'name' | 'networkPointOfView'>): Promise<boolean> {
  try {
    await listModelsForProvider(provider);
    return true;
  } catch {
    return false;
  }
}

export class LLMClient {
  private config: LLMConfig = {
    baseUrl: '',
    apiKey: '',
    model: '',
  };

  setConfig(config: Partial<LLMConfig>) {
    this.config = { ...this.config, ...config };
  }

  getConfig(): LLMConfig {
    return { ...this.config };
  }

  isConfigured(): boolean {
    return !!(this.config.baseUrl && this.config.model);
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.config.baseUrl) throw new Error('No inference endpoint configured');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/models`, { headers });
    if (!res.ok) throw new Error(`Failed to fetch models: ${res.statusText}`);
    const data = await res.json();
    return data.data || [];
  }

  // Convert Vulcan tool schemas to OpenAI function call format
  private formatTools(tools: Tool[]) {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async chat(
    messages: { role: string; content: string | { type: string; [key: string]: any }[] | null; tool_call_id?: string; name?: string; tool_calls?: any[]; reasoning?: string; reasoning_content?: string; reasoning_details?: any[]; thinking?: string }[],
    tools: Tool[] = [],
    onStreamEvent?: (event: LLMStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<{ content: string; thinking?: string; reasoningDetails?: any[]; reasoningWire?: 'reasoning' | 'reasoning_content' | 'reasoning_details' | 'thinking' | 'inline'; toolCalls?: any[] }> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const body: any = {
      model: this.config.model,
      messages,
      stream: !!onStreamEvent,
      // `reasoning: { enabled: true }` is the current OpenRouter unified API for requesting
      // reasoning tokens. `include_reasoning: true` is kept as a legacy fallback alias.
      reasoning: { enabled: true },
      include_reasoning: true,
    };

    if (tools.length > 0) {
      body.tools = this.formatTools(tools);
      body.tool_choice = 'auto';
    }

    const chatHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) chatHeaders['Authorization'] = `Bearer ${this.config.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LLM error ${res.status}: ${err}`);
    }

    // Streaming response
    if (onStreamEvent && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let thinkingContent = '';  // first-class reasoning text; never injected into content
      let fullContent = '';       // visible assistant content only
      let toolCalls: any[] = [];
      let reasoningDetails: any[] = [];
      let reasoningWire: ReasoningWire | undefined;
      let inInlineThink = false;  // only for providers/models that genuinely emit inline <think> tags

      let sseBuffer = '';
      let inlineContentBuffer = '';
      const emitReasoning = (text: string, wire?: ReasoningWire, details?: any[]) => {
        if (!text) return;
        thinkingContent += text;
        onStreamEvent({ type: 'reasoning_delta', delta: text, wire, details });
      };
      const emitText = (text: string) => {
        if (!text) return;
        fullContent += text;
        onStreamEvent({ type: 'text_delta', delta: text });
      };

      // Keep only a suffix which could still become a tag when the next provider
      // chunk arrives. This prevents split `<think>` / `</think>` tags from leaking
      // into visible assistant text without imposing a fixed-size streaming delay.
      const partialTagSuffixLength = (text: string, tags: string[]) => {
        const max = Math.min(text.length, Math.max(...tags.map((tag) => tag.length - 1)));
        for (let length = max; length > 0; length--) {
          const suffix = text.slice(-length);
          if (tags.some((tag) => tag.startsWith(suffix))) return length;
        }
        return 0;
      };

      const drainInlineContent = (final = false) => {
        while (inlineContentBuffer.length > 0) {
          if (inInlineThink) {
            const close = inlineContentBuffer.indexOf('</think>');
            if (close !== -1) {
              emitReasoning(inlineContentBuffer.slice(0, close), 'inline');
              inlineContentBuffer = inlineContentBuffer.slice(close + '</think>'.length);
              inInlineThink = false;
              continue;
            }
            const keep = final ? 0 : partialTagSuffixLength(inlineContentBuffer, ['</think>']);
            const emitLength = inlineContentBuffer.length - keep;
            if (emitLength > 0) {
              emitReasoning(inlineContentBuffer.slice(0, emitLength), 'inline');
              inlineContentBuffer = inlineContentBuffer.slice(emitLength);
            }
            return;
          }

          const open = inlineContentBuffer.indexOf('<think>');
          const close = inlineContentBuffer.indexOf('</think>');

          // Some OpenAI-compatible backends have been observed to start emitting
          // reasoning before a closing tag even when the opening tag was omitted.
          // Preserve the old tolerant behavior, but consume the tag here so neither
          // the tag nor its inner reasoning can leak into visible/persisted text.
          if (close !== -1 && (open === -1 || close < open)) {
            reasoningWire ??= 'inline';
            emitReasoning(inlineContentBuffer.slice(0, close), 'inline');
            inlineContentBuffer = inlineContentBuffer.slice(close + '</think>'.length);
            continue;
          }

          if (open !== -1) {
            emitText(inlineContentBuffer.slice(0, open));
            reasoningWire ??= 'inline';
            inlineContentBuffer = inlineContentBuffer.slice(open + '<think>'.length);
            inInlineThink = true;
            continue;
          }

          const keep = final ? 0 : partialTagSuffixLength(inlineContentBuffer, ['<think>', '</think>']);
          const emitLength = inlineContentBuffer.length - keep;
          if (emitLength > 0) {
            emitText(inlineContentBuffer.slice(0, emitLength));
            inlineContentBuffer = inlineContentBuffer.slice(emitLength);
          }
          return;
        }
      };

      const processDelta = (delta: any) => {
        if (!delta) return;

        if (delta.content || delta.reasoning_content || delta.thinking || delta.reasoning || delta.reasoning_details || delta.tool_calls) {
          console.debug('[llm delta]', JSON.stringify(delta));
        }

        const deltaReasoningDetails = delta.reasoning_details as any[] | undefined;
        const reasoningFromDetails = deltaReasoningDetails
          ?.map((d: any) => d?.text ?? d?.summary ?? '')
          .join('') ?? '';

        let dedicatedReasoning = '';
        let dedicatedWire: ReasoningWire | undefined;
        if (deltaReasoningDetails !== undefined) {
          reasoningWire ??= 'reasoning_details';
          dedicatedWire = 'reasoning_details';
          reasoningDetails.push(...deltaReasoningDetails);
          dedicatedReasoning = reasoningFromDetails;
        } else if (delta.reasoning !== undefined) {
          reasoningWire ??= 'reasoning';
          dedicatedWire = 'reasoning';
          dedicatedReasoning = delta.reasoning ?? '';
        } else if (delta.reasoning_content !== undefined) {
          reasoningWire ??= 'reasoning_content';
          dedicatedWire = 'reasoning_content';
          dedicatedReasoning = delta.reasoning_content ?? '';
        } else if (delta.thinking !== undefined) {
          reasoningWire ??= 'thinking';
          dedicatedWire = 'thinking';
          dedicatedReasoning = delta.thinking ?? '';
        }
        if (dedicatedReasoning) emitReasoning(dedicatedReasoning, dedicatedWire, deltaReasoningDetails);

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          // Inline-think parsing itself is streaming: incomplete tags stay in a tiny
          // carry buffer until the next provider chunk. The transcript therefore only
          // ever receives semantic reasoning/text deltas, never markup fragments.
          inlineContentBuffer += delta.content;
          drainInlineContent(false);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCalls[tc.index]) {
              toolCalls[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            }
            if (tc.id) toolCalls[tc.index].id = tc.id;
            if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
            onStreamEvent({
              type: 'tool_call_delta',
              index: tc.index,
              id: tc.id,
              nameDelta: tc.function?.name,
              argumentsDelta: tc.function?.arguments,
            });
          }
        }
      };

      const processSseLine = (rawLine: string): boolean => {
        const line = rawLine.trimEnd();
        if (!line.startsWith('data:')) return false;
        const payload = line.slice('data:'.length).trim();
        if (!payload) return false;
        if (payload === '[DONE]') return true;
        try {
          const parsed = JSON.parse(payload);
          const choice = parsed.choices?.[0];
          processDelta(choice?.delta);
          return choice?.finish_reason != null;
        } catch {
          // Ignore a malformed provider payload, but never let it corrupt the
          // semantic transcript already accumulated from valid deltas.
          return false;
        }
      };

      try {
        let terminal = false;
        while (!terminal) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() ?? '';
          for (const line of lines) {
            if (processSseLine(line)) { terminal = true; break; }
          }
        }

        // A provider may emit the terminal SSE marker without closing the HTTP
        // stream. Stop reading immediately instead of leaving the caller in a
        // permanent generating state waiting for EOF.
        if (terminal) { try { await reader.cancel(); } catch {} }
        sseBuffer += decoder.decode();
        if (!terminal && sseBuffer.trim()) processSseLine(sseBuffer);
        drainInlineContent(true);
      } catch (e: any) {
        // AbortError is expected when stop is pressed. Flush semantic text already
        // received; App.tsx will mark the still-open canonical event interrupted.
        if (e?.name !== 'AbortError') throw e;
        drainInlineContent(true);
      }

      return {
        content: fullContent,
        thinking: thinkingContent || undefined,
        reasoningDetails: reasoningDetails.length > 0 ? reasoningDetails : undefined,
        reasoningWire,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    }

    // Non-streaming — thinking may be in message.content as <think> tags, or in a separate field.
    // OpenRouter primary field is `reasoning`; legacy aliases: `reasoning_content`, `thinking`.
    // `reasoning_details` is an array of objects; extract text/summary from each entry.
    const data = await res.json();
    const choice = data.choices?.[0];
    const msgContent: string = choice?.message?.content || '';
    const msgReasoningDetails: string =
      (choice?.message?.reasoning_details as any[] | undefined)
        ?.map((d: any) => d?.text ?? d?.summary ?? '')
        .join('') ?? '';
    let reasoningWire: ReasoningWire | undefined;
    if (choice?.message?.reasoning_details !== undefined) reasoningWire = 'reasoning_details';
    else if (choice?.message?.reasoning !== undefined) reasoningWire = 'reasoning';
    else if (choice?.message?.reasoning_content !== undefined) reasoningWire = 'reasoning_content';
    else if (choice?.message?.thinking !== undefined) reasoningWire = 'thinking';

    let visibleContent = msgContent;
    let inlineReasoning = '';
    // Compatibility fallback only: if the PROVIDER itself emitted inline tags, split them
    // for Vulcan's first-class thinking UI. We never manufacture these tags ourselves.
    if (!reasoningWire) {
      const inline = msgContent.match(/^<think>([\s\S]*?)<\/think>([\s\S]*)$/);
      if (inline) {
        reasoningWire = 'inline';
        inlineReasoning = inline[1];
        visibleContent = inline[2];
      }
    }

    const msgReasoning: string =
      choice?.message?.reasoning ??
      (msgReasoningDetails || undefined) ??
      choice?.message?.reasoning_content ??
      choice?.message?.thinking ??
      inlineReasoning ??
      '';

    return {
      content: visibleContent,
      thinking: msgReasoning || undefined,
      reasoningDetails: choice?.message?.reasoning_details,
      reasoningWire,
      toolCalls: choice?.message?.tool_calls,
    };
  }

  async generateTitle(userMessage: string): Promise<string> {
    if (!this.isConfigured()) return userMessage.slice(0, 40);
    try {
      const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const titleHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.config.apiKey) titleHeaders['Authorization'] = `Bearer ${this.config.apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: titleHeaders,
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: 'system',
              content:
                'Generate a short 3-6 word title for a chat that starts with this message. Return ONLY the title, no quotes, no punctuation at the end.',
            },
            { role: 'user', content: userMessage.slice(0, 500) },
          ],
          stream: false,
          max_tokens: 20,
        }),
      });
      if (!res.ok) throw new Error(`title gen failed: ${res.status}`);
      const data = await res.json();
      const title = data.choices?.[0]?.message?.content?.trim();
      return title ? title.slice(0, 60) : userMessage.slice(0, 40);
    } catch {
      return userMessage.slice(0, 40);
    }
  }
}

export const llmClient = new LLMClient();
