import { AtomicV2 } from '../../src/atomic-v2/engine.ts';
import { InMemoryStore } from '../../src/atomic-v2/store.ts';
import type { Embedder } from '../../src/atomic-v2/types.ts';
import type { AtomicV2Config } from '../../src/atomic-v2/config.ts';

/**
 * Deterministic stand-in for a multilingual sentence embedder: one dimension per concept, each word
 * adds to the concepts it belongs to. Enough to test the layer maths; real meaning comes from the model.
 */
const CONCEPTS: Record<string, string[]> = {
  number: ['rupees', 'lakh', 'hazaar', 'percent', '%', '₹', 'kg', 'pieces', 'number', 'gst', 'नंबर'],
  reason: ['reason', 'because', 'lesson', 'how', 'isliye', 'कारण', 'formula', 'works', 'first', 'reduces', 'warna'],
  want: ['want', 'please', 'need', 'help', 'chahiye', 'fill', 'make', 'send', 'बनाना', 'मुझे', 'apply'],
  decide: ['decided', 'decide', 'final', 'approve', 'agreed', 'फैसला', 'cancel', "let's", 'going'],
  promise: ['will', "i'll", 'promise', 'dunga', 'दूंगा', 'done', 'pakka', 'consider'],
  time: ['tomorrow', 'deadline', 'monday', 'kal', 'parson', 'आज', 'hours', 'month', 'diwali', 'today', 'friday', 'october', 'शाम'],
  urgent: ['urgent', 'now', 'hurry', 'jaldi', 'asap', 'abhi', 'अभी', 'delays', 'excuses', 'possible', 'waiting'],
  risk: ['risk', 'lose', 'cost', 'penalty', 'नुकसान', 'careful', 'legal', 'bounces', 'margin', 'break', 'miss'],
  boss: ['boss', 'sir', 'malik', 'owner', "owner's", 'manager', 'मैनेजर', 'director', 'ordered', 'personally', 'behalf'],
  happy: ['happy', 'thank', 'thanks', 'great', 'badhiya', 'खुशी', 'wonderful', 'love', 'perfect', 'haha', 'proud', 'maza', 'funny'],
  sad: ['upset', 'frustrating', 'worried', 'gussa', 'परेशान', 'stressed', 'terrible', 'sad', 'angry', 'alone', 'tired'],
  engaged: ['more', 'explain', 'really', 'aur', 'batao', 'दिलचस्प', 'follow-up', 'deeper', 'interesting', 'next?'],
  bored: ['hmm', 'whatever', 'fine', 'k', 'chhodo', 'mind', 'ठीक', 'theek'],
  fail: ['sorry', "couldn't", 'error', "don't", 'paya', 'नहीं', 'unavailable', 'failed', 'unable'],
  wrong: ['wrong', 'misunderstood', 'galat', 'गलत', 'correct,', 'again', 'aisa', 'asked'],
  greet: ['hello', 'hi', 'how', 'are', 'you', 'haal', 'नमस्ते', 'morning', 'okay', 'weather', "what's", 'up', 'kya'],
  nails: ['nails', 'nail', 'pins', 'wire'],
  excel: ['excel', 'sheet', 'spreadsheet'],
  discount: ['discount', 'discounted'],
  avi: ['avi', 'enterprise'],
  order: ['order', 'orders', 'so-1041'],
  invoice: ['invoice', 'bill'],
  payment: ['payment', 'paid', 'pay', 'cheque'],
  cricket: ['cricket', 'match', 'india'],
  family: ['mother', 'maa', 'family', 'sister'],
  gym: ['gym', 'workout', 'run'],
};
const NAMES = Object.keys(CONCEPTS);

export function tokens(text: string): string[] {
  return text.toLowerCase().split(/[\s,.!?;:()"]+/).filter(Boolean);
}

export class ConceptEmbedder implements Embedder {
  readonly id: string;
  calls = 0;
  texts = 0;
  constructor(id = 'concept-test-v1') {
    this.id = id;
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    this.texts += texts.length;
    return texts.map((text) => {
      const vector = NAMES.map(() => 0);
      for (const token of tokens(text)) {
        NAMES.forEach((name, index) => {
          if (CONCEPTS[name].includes(token)) vector[index] += 1;
        });
        if (/^\d/.test(token)) vector[NAMES.indexOf('number')] += 1;
      }
      // A faint shared component so no vector is all zeros (real embedders never return zero vectors).
      return [...vector, 0.05];
    });
  }
}

export class TestClock {
  private current: number;
  constructor(iso: string) {
    this.current = Date.parse(iso);
  }
  now = () => new Date(this.current);
  set(iso: string) {
    this.current = Date.parse(iso);
  }
  advanceMinutes(minutes: number) {
    this.current += minutes * 60_000;
  }
  advanceDays(days: number) {
    this.current += days * 86_400_000;
  }
}

export async function openAtomic(options: { store?: InMemoryStore; embedder?: ConceptEmbedder; clock?: TestClock; config?: Partial<AtomicV2Config> } = {}) {
  const store = options.store ?? new InMemoryStore();
  const embedder = options.embedder ?? new ConceptEmbedder();
  const clock = options.clock ?? new TestClock('2026-10-01T04:30:00.000Z');
  const atomic = await AtomicV2.open({ embedder, store, now: clock.now, config: options.config });
  return { atomic, store, embedder, clock };
}

export const DISCOUNT_ASK = 'Fill details for the new order in the excel sheet and apply a 3 percent discount for AVI, ordered by the boss';
export const DISCOUNT_RESPONSE = 'Excel sheet created for the AVI order. A 3 percent discount is applied on the total.';
