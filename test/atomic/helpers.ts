import { AtomicEngine } from '../../src/atomic/engine.ts';
import { InMemoryStorage } from '../../src/atomic/memory-storage.ts';
import type { Classifier, Clock, Embedder } from '../../src/atomic/ports.ts';
import type {
  Angles,
  ClassifierResult,
  Facts,
  Fundamental,
  KindGuess,
  StatementKind,
} from '../../src/atomic/types.ts';
import type { AtomicConfig } from '../../src/atomic/config.ts';

/** Deterministic stand-in for a multilingual embedding model: one dimension per business topic. */
const TOPICS: Record<string, string[]> = {
  payment: ['payment', 'paisa', 'dues', 'baaki', 'neft', 'lakh', 'cheque', 'paid', 'pay'],
  order: ['order', 'ton', 'maal', 'piece', 'chahiye', 'bhejo', 'bhej', 'usual'],
  rate: ['rate', '₹', 'price', 'bhav'],
  product: ['nail', 'nails', 'pin', 'pins', 'panel', 'wire', 'u-pin'],
  dispatch: ['dispatch', 'gaadi', 'vehicle', 'truck', 'delivery', 'e-way', 'eway', 'friday'],
  quality: ['rust', 'quality', 'complaint', 'kharab', 'kam'],
  staff: ['advance', 'salary', 'overtime', 'shift'],
  machine: ['machine', 'die', 'header', 'breakdown'],
  smalltalk: ['chai', 'tea', 'cricket', 'diwali', 'happy', 'dhanteras', 'kaise', 'haha', 'lol', '😄', 'jeetega'],
  gst: ['gst', 'gstr', 'return', 'filing', 'tax'],
  packing: ['packing', 'box', 'boxes', 'bags', 'bori', 'carton'],
};
const TOPIC_NAMES = Object.keys(TOPICS);

export function tokens(text: string): string[] {
  return text.toLowerCase().split(/[\s,.;!?()"']+/).filter(Boolean);
}

export const topicEmbedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    const vector = TOPIC_NAMES.map(() => 0);
    const lower = text.toLowerCase();
    for (const token of tokens(text)) {
      TOPIC_NAMES.forEach((topic, index) => {
        if (TOPICS[topic].some((word) => token === word || token.startsWith(word))) vector[index] += 1;
      });
    }
    if (lower.includes('₹')) vector[TOPIC_NAMES.indexOf('rate')] += 1;
    return vector;
  },
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function extractFacts(text: string): Facts {
  const lower = text.toLowerCase();
  const facts: Facts = {};
  const qty = /(\d+(?:\.\d+)?)\s*(ton|kg|carton|boxes|box)\b/.exec(lower);
  if (qty) { facts.qty = Number(qty[1]); facts.unit = qty[2]; }
  const rate = /₹\s?(\d+(?:\.\d+)?)(?!\s*lakh)/.exec(lower);
  if (rate && !/lakh/.test(lower.slice(rate.index, rate.index + 12))) facts.rate = Number(rate[1]);
  const amount = /(\d+(?:\.\d+)?)\s*lakh/.exec(lower);
  if (amount) facts.amount = Math.round(Number(amount[1]) * 100_000);
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(lower);
  const dayMonth = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/.exec(lower);
  if (iso) facts.date = iso[1];
  else if (dayMonth) facts.date = `2026-${String(MONTHS.indexOf(dayMonth[2]) + 1).padStart(2, '0')}-${dayMonth[1].padStart(2, '0')}`;
  const item = /(panel pins?|wire nails?|u-pins?|roofing nails?|drawing pins?)/.exec(lower);
  if (item) facts.item = item[1].replace(/s$/, '');
  return facts;
}

/** Deterministic stand-in for the importance classifier (the real one is a small language model). */
export class KeywordClassifier implements Classifier {
  private readonly scripted = new Map<string, ClassifierResult>();

  script(text: string, result: ClassifierResult): void {
    this.scripted.set(text, result);
  }

  async classify(input: { text: string }): Promise<ClassifierResult> {
    const scripted = this.scripted.get(input.text);
    if (scripted) return structuredClone(scripted);
    const text = input.text;
    const lower = text.toLowerCase();
    const has = (words: string[]) => words.some((word) => lower.includes(word));
    const facts = extractFacts(text);
    const paymentWords = has(['payment', 'dues', 'baaki', 'neft', 'lakh', 'cheque']);
    const orderWords = has(['order', 'ton', 'chahiye', 'bhejo', 'bhej do', 'usual', 'kg']);
    const rateWords = has(['rate', '₹']);
    const joke = has(['haha', 'lol', '😄']);
    const question = text.includes('?');

    const angles: Angles = {
      type: joke ? 'joke' : question ? 'question' : paymentWords ? 'payment' : rateWords ? 'rate'
        : has(['rust', 'kam aaya', 'complaint']) ? 'complaint' : orderWords ? 'order' : 'opinion',
      intent: has(['kar dunga', 'kar denge', 'pakka', 'final', 'confirm']) ? 'commit'
        : has(['chahiye', 'bhejo', 'bhej do', 'kar do']) ? 'request' : 'none',
      stance: has(['nahi', 'no,', 'galat']) ? 'disagree' : has(['haan', 'yes', 'theek']) ? 'agree' : 'neutral',
      emotion: has(['😄', 'haha', 'accha']) ? 'happy' : has(['🙄', 'gussa']) ? 'angry' : has(['jaldi', 'urgent']) ? 'urgent' : 'neutral',
      certainty: has(['maybe', 'shayad', 'sochenge']) ? 'tentative' : 'firm',
      specifics: facts,
      change: 'new',
      risk: has(['kar dunga', 'kar denge', 'pakka', 'chahiye', 'rust']) || paymentWords ? 'high' : question ? 'medium' : 'low',
      trust: has(['late', 'bounce', 'reliable', 'accha tha']),
    };

    const kinds: KindGuess[] = [];
    const add = (kind: StatementKind, confidence: number) => kinds.push({ kind, confidence });
    if (paymentWords) add('payment', 0.8);
    if (orderWords || has(['maal'])) add('order', 0.7);
    if (rateWords) add('rate_negotiation', 0.5);
    if (has(['advance', 'salary', 'overtime'])) add('staff', 0.8);
    if (has(['gaadi', 'vehicle', 'dispatch', 'friday'])) add('dispatch', 0.7);
    if (has(['machine', 'die', 'header'])) add('production', 0.8);
    if (has(['rust', 'kam aaya', 'complaint'])) add('complaint', 0.8);
    if (!kinds.length) add('general_chat', 0.6);
    return { angles, kinds };
  }
}

export class TestClock implements Clock {
  private current: Date;
  constructor(iso: string) { this.current = new Date(iso); }
  now(): Date { return new Date(this.current); }
  set(iso: string): void { this.current = new Date(iso); }
  advanceDays(days: number): void { this.current = new Date(this.current.getTime() + days * 86_400_000); }
  advanceMs(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}

export const ABC_FUNDAMENTAL: Fundamental = {
  businessName: 'ABC Enterprises',
  domain: 'manufacturer of wire nails and pins',
  owner: 'Rakesh',
  approvalRequired: ['rate_change', 'discount', 'credit_terms', 'refund', 'supplier_share'],
  advanceOnly: ['verma'],
  criticalKinds: ['payment'],
  version: 1,
};

export function makeEngine(options: { clock?: TestClock; config?: Partial<AtomicConfig>; fundamental?: Fundamental } = {}) {
  const storage = new InMemoryStorage();
  const classifier = new KeywordClassifier();
  const clock = options.clock ?? new TestClock('2026-10-01T09:00:00.000Z');
  const engine = new AtomicEngine({
    tenantId: 'abc',
    storage,
    models: { embedder: topicEmbedder, classifier },
    fundamental: options.fundamental ?? ABC_FUNDAMENTAL,
    config: options.config,
    clock,
  });
  return { engine, storage, classifier, clock };
}

export function angles(partial: Partial<Angles>): Angles {
  return {
    type: 'opinion', intent: 'none', stance: 'neutral', emotion: 'neutral', certainty: 'firm',
    specifics: {}, change: 'new', risk: 'low', trust: false, ...partial,
  };
}
