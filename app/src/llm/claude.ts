import Anthropic from '@anthropic-ai/sdk';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ReplyRequest {
  apiKey: string;
  model: string;
  effort: Effort;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  onText(delta: string): void;
}

export interface Reply {
  text: string;
  /** The model (or the whole fallback chain) declined. */
  refused: boolean;
  stopReason: string | null;
  /** Model that produced the final answer (differs when a refusal fallback ran). */
  model: string;
}

export interface ReplyHandle {
  done: Promise<Reply>;
  abort(): void;
}

/** User-facing message for an API failure. */
export function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return 'The API key was rejected. Check it in settings.';
  if (error instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use that model.';
  if (error instanceof Anthropic.NotFoundError) return 'That model was not found. Check the model in settings.';
  if (error instanceof Anthropic.RateLimitError) return 'Too many requests right now. Try again in a moment.';
  if (error instanceof Anthropic.BadRequestError) return `The request was refused: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return 'No connection to Claude. Check the internet connection.';
  if (error instanceof Anthropic.APIError) return `Claude returned an error (${error.status ?? 'unknown'}).`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Streams one reply from Claude, straight from the phone (no backend). Server-side refusal fallback is on:
 * if the model declines, the API re-runs the request on its recommended fallback model in the same call.
 */
export function streamReply(request: ReplyRequest): ReplyHandle {
  const client = new Anthropic({ apiKey: request.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const stream = client.beta.messages.stream({
    model: request.model,
    max_tokens: 16000,
    system: request.system,
    messages: request.messages,
    output_config: { effort: request.effort },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  stream.on('text', (delta) => request.onText(delta));
  const done = stream.finalMessage().then((message): Reply => {
    const refused = message.stop_reason === 'refusal';
    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return { text: refused ? '' : text, refused, stopReason: message.stop_reason, model: message.model };
  });
  return { done, abort: () => stream.abort() };
}
