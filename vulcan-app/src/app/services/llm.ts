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
}

export interface ModelInfo {
  id: string;
  name?: string;
  owned_by?: string;
  providerId?: string;
  providerName?: string;
}

export async function listModelsForProvider(provider: Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'id' | 'name'>): Promise<ModelInfo[]> {
  if (!provider.baseUrl) throw new Error('No inference endpoint configured');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, { headers });
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.statusText}`);
  const data = await res.json();
  return (data.data || []).map((m: ModelInfo) => ({ ...m, providerId: provider.id, providerName: provider.name }));
}

export async function testProviderConnection(provider: Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'id' | 'name'>): Promise<boolean> {
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
    messages: { role: string; content: string | { type: string; [key: string]: any }[] | null; tool_call_id?: string; name?: string }[],
    tools: Tool[] = [],
    onChunk?: (text: string) => void,
    signal?: AbortSignal
  ): Promise<{ content: string; toolCalls?: any[] }> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const body: any = {
      model: this.config.model,
      messages,
      stream: !!onChunk,
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
    if (onChunk && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let thinkingContent = '';  // accumulated from delta.reasoning_content / delta.thinking
      let fullContent = '';       // accumulated from delta.content (may also contain <think> tags)
      let toolCalls: any[] = [];
      let inInlineThink = false;  // track whether we're inside a <think> tag in delta.content

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n').filter((l) => l.startsWith('data: '));
          for (const line of lines) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;

              // DEBUG: log any delta that carries content or reasoning
              if (delta && (delta.content || delta.reasoning_content || delta.thinking || delta.reasoning || delta.reasoning_details)) {
                console.debug('[llm delta]', JSON.stringify(delta));
              }

              // OpenRouter sends reasoning in (in order of preference):
              //   delta.reasoning            — current primary field (OpenRouter unified API)
              //   delta.reasoning_details[]  — structured array (reasoning.text chunks)
              //   delta.reasoning_content    — legacy alias (still used by some providers)
              //   delta.thinking             — some providers (e.g. older Qwen via OpenRouter)
              const reasoningFromDetails: string =
                (delta?.reasoning_details as any[] | undefined)
                  ?.map((d: any) => d?.text ?? d?.summary ?? '')
                  .join('') ?? '';
              const reasoningChunk: string =
                delta?.reasoning ??
                (reasoningFromDetails || undefined) ??
                delta?.reasoning_content ??
                delta?.thinking ??
                '';
              if (reasoningChunk) {
                thinkingContent += reasoningChunk;
              }

              if (delta?.content) {
                // Other providers embed thinking as <think>...</think> inside content
                let chunk = delta.content as string;
                // Route chunks into thinkingContent or fullContent based on <think> tags
                while (chunk.length > 0) {
                  if (inInlineThink) {
                    const end = chunk.indexOf('</think>');
                    if (end === -1) {
                      thinkingContent += chunk;
                      chunk = '';
                    } else {
                      thinkingContent += chunk.slice(0, end);
                      inInlineThink = false;
                      chunk = chunk.slice(end + '</think>'.length);
                    }
                  } else {
                    const start = chunk.indexOf('<think>');
                    if (start === -1) {
                      fullContent += chunk;
                      chunk = '';
                    } else {
                      fullContent += chunk.slice(0, start);
                      inInlineThink = true;
                      chunk = chunk.slice(start + '<think>'.length);
                    }
                  }
                }
              }

              // Emit full replacement to the UI on every delta that carries reasoning or content
              if (reasoningChunk || delta?.content) {
                const combined = thinkingContent
                  ? `<think>${thinkingContent}${inInlineThink ? '' : '</think>'}${fullContent}`
                  : fullContent;
                onChunk('\x00REPLACE\x00' + combined);
              }

              if (delta?.tool_calls) {
                // Accumulate tool call chunks
                for (const tc of delta.tool_calls) {
                  if (!toolCalls[tc.index]) {
                    toolCalls[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                  }
                  if (tc.id) toolCalls[tc.index].id = tc.id;
                  if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                  if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                }
              }
            } catch { /* skip malformed chunks */ }
          }
        }
      } catch (e: any) {
        // AbortError is expected when stop is pressed — treat as clean finish
        if (e?.name !== 'AbortError') throw e;
      }

      const finalContent = thinkingContent
        ? `<think>${thinkingContent}</think>${fullContent}`
        : fullContent;
      return { content: finalContent, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
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
    const msgReasoning: string =
      choice?.message?.reasoning ??
      (msgReasoningDetails || undefined) ??
      choice?.message?.reasoning_content ??
      choice?.message?.thinking ??
      '';
    // If reasoning came in a separate field, prepend it as <think> tags
    const finalNonStream = msgReasoning
      ? `<think>${msgReasoning}</think>${msgContent}`
      : msgContent;
    return {
      content: finalNonStream,
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
