import type { RecallItem } from '@atomic-v2';

/**
 * Builds the request for one ask. There is no chat session: the model receives exactly one user message,
 * and everything it knows about the past arrives as memories recalled by Atomic for that message.
 */

export interface PromptInput {
  ask: string;
  now: Date;
  userName?: string;
  memories: RecallItem[];
  timeZone?: string;
}

const MAX_MEMORY_CHARS = 600;

function clip(text: string): string {
  return text.length > MAX_MEMORY_CHARS ? `${text.slice(0, MAX_MEMORY_CHARS - 1)}…` : text;
}

function escapeTag(text: string): string {
  return text.replace(/<\/?memor(y|ies)[^>]*>/gi, '');
}

export function describeWhen(at: string, now: Date, timeZone?: string): string {
  const then = new Date(at);
  const minutes = Math.round((now.getTime() - then.getTime()) / 60_000);
  const relative = minutes < 1 ? 'just now'
    : minutes < 60 ? `${minutes} min ago`
    : minutes < 24 * 60 ? `${Math.round(minutes / 60)} h ago`
    : `${Math.round(minutes / (24 * 60))} days ago`;
  const absolute = new Intl.DateTimeFormat('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone,
  }).format(then);
  return `${relative} (${absolute})`;
}

export function renderMemories(memories: RecallItem[], now: Date, timeZone?: string): string {
  if (!memories.length) return '(No memories match this message.)';
  return memories.map(({ experience, similarity }) => [
    `<memory when="${describeWhen(experience.at, now, timeZone)}" kind="${experience.kind}" importance="${experience.importance.toFixed(2)}" match="${similarity.toFixed(2)}">`,
    `Person: ${escapeTag(clip(experience.ask))}`,
    `You: ${escapeTag(clip(experience.response))}`,
    '</memory>',
  ].join('\n')).join('\n');
}

export function buildSystemPrompt(input: PromptInput): string {
  const now = new Intl.DateTimeFormat('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: input.timeZone,
  }).format(input.now);
  const name = input.userName?.trim();
  return `You are Surface, a warm and sharp voice companion${name ? ` talking with ${name}` : ''}. It is now ${now}.

How your memory works: you never see earlier messages. Each message reaches you on its own. All you know about the past is the memories below, which Atomic recalled for this message; they can be incomplete. Use a memory only when it genuinely helps, and mention it naturally. Never invent past conversations or details that are not in the memories; if the person refers to something you have no memory of, say so honestly and ask. Exact figures such as amounts, percentages and dates must come from a memory's exact words.

How to reply: your reply is spoken aloud. Keep it short and conversational, usually one to three sentences, with no lists, markdown, headings or emoji. Reply in the person's language and style, including Hindi or Hinglish, in the same script they used.

<memories>
${renderMemories(input.memories, input.now, input.timeZone)}
</memories>`;
}

/** Exactly one message: the current ask. */
export function buildMessages(ask: string): { role: 'user'; content: string }[] {
  return [{ role: 'user', content: ask }];
}
