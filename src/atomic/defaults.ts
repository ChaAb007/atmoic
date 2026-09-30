import type { OutcomeMatcher, SplitStatement, Splitter, Summarizer } from './ports.ts';
import type { Experience, Level, Memory } from './types.ts';

/** One statement per line; "Name: text" marks the speaker. Hosts can plug in a model-based splitter. */
export const lineSplitter: Splitter = {
  async split(raw: string): Promise<SplitStatement[]> {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^([^:]{1,40}):\s*(.+)$/.exec(line);
        return match ? { speaker: match[1].trim(), text: match[2].trim() } : { text: line };
      });
  },
};

/** L1 lines first, then L2; falls back to the first raw line. Hosts can plug in a model-based summarizer. */
export const extractiveSummarizer: Summarizer = {
  async summarize(experience: Experience, kept: { text: string; level: Level }[]): Promise<string> {
    const l1 = kept.filter((item) => item.level === 'L1').map((item) => item.text);
    if (l1.length) return l1.join('; ');
    const l2 = kept.filter((item) => item.level === 'L2').slice(0, 3).map((item) => item.text);
    if (l2.length) return l2.join('; ');
    return experience.raw.split(/\r?\n/)[0].slice(0, 200);
  },
};

/**
 * First business event for the same party (and deal, when the memory has one) after the promise was made.
 * When both sides carry an amount, the event must cover the promised amount.
 */
export const defaultOutcomeMatcher: OutcomeMatcher = {
  match(memory: Memory, events: Experience[]): Experience | undefined {
    const created = Date.parse(memory.createdAt);
    return events
      .filter((event) => event.event && Date.parse(event.occurredAt) >= created)
      .filter((event) => event.context.partyId === memory.partyId)
      .filter((event) => !memory.dealId || event.context.dealId === memory.dealId)
      .filter((event) => {
        const promised = memory.facts.amount;
        const paid = event.event?.facts?.amount;
        return promised === undefined || paid === undefined || paid >= promised;
      })
      .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))[0];
  },
};
