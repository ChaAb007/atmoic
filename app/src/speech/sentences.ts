/**
 * Cuts streamed text into sentences as they complete, so speech can start on the first sentence while the
 * rest is still being written.
 */
export class SentenceStream {
  private buffer = '';
  private readonly minimumLength: number;

  constructor(minimumLength = 12) {
    this.minimumLength = minimumLength;
  }

  /** Add streamed text; returns any sentences that are now complete. */
  push(text: string): string[] {
    this.buffer += text;
    const sentences: string[] = [];
    const boundary = /[.!?।]+["')\]]*\s+|\n+/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.buffer))) {
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(start, end).trim();
      if (sentence.length >= this.minimumLength || /\n/.test(match[0])) {
        if (sentence) sentences.push(sentence);
        start = end;
      }
    }
    this.buffer = this.buffer.slice(start);
    return sentences;
  }

  /** Whatever is left once the stream ends. */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }
}

/** Strip characters that should not be read aloud (markdown symbols, emoji). */
export function speakable(text: string): string {
  return text
    .replace(/[*_#`>|~]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
