export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ModelTurn {
  message: ChatMessage;
  model: string;
  identityVerified?: boolean;
  usage: { input: number; output: number; cached: number; reasoning: number } | null;
  reportedUsage?: unknown;
  nativeToolAttempts?: number;
}
export interface ChatModel {
  id: string;
  settings?: Record<string, unknown>;
  complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelTurn>;
}
export interface ApiOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export function apiEndpoint(baseUrl: string, route: string): string {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('API base must not contain credentials, query or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('API requires HTTPS except for a loopback test server');
  }
  return `${url.href.replace(/\/$/, '')}/${route}`;
}

export class ApiModel implements ChatModel {
  readonly id: string;
  readonly settings: Record<string, unknown>;
  constructor(private readonly options: ApiOptions) {
    if (!options.model || !options.apiKey) throw new Error('Model and API key are required');
    apiEndpoint(options.baseUrl, 'chat/completions');
    this.id = options.model;
    this.settings = { backend: 'chat-completions', reasoningEffort: options.reasoningEffort ?? null, temperature: options.temperature ?? null, maxOutputTokens: options.maxOutputTokens ?? null };
  }
  async complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelTurn> {
    const o = this.options;
    const response = await fetch(apiEndpoint(o.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: o.model, messages, stream: false,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        ...(o.reasoningEffort ? { reasoning_effort: o.reasoningEffort } : {}),
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
        ...(o.maxOutputTokens ? { max_completion_tokens: o.maxOutputTokens } : {}),
      }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Model API returned HTTP ${response.status}`);
    const body = await response.json() as {
      model?: string;
      choices?: Array<{ message?: ChatMessage }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const message = body.choices?.[0]?.message;
    if (!message || message.role !== 'assistant') throw new Error('Model API did not return an assistant message');
    if (message.content !== null && typeof message.content !== 'string') throw new Error('Unsupported model message content');
    for (const call of message.tool_calls ?? []) {
      if (!call.id || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') {
        throw new Error('Invalid model tool call');
      }
    }
    const u = body.usage;
    return {
      message, model: body.model ?? o.model, identityVerified: typeof body.model === 'string' && body.model.length > 0,
      usage: u ? { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0, reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0 } : null,
    };
  }
}
