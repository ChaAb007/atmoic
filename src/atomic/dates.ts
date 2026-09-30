/**
 * Turns relative date words ("aaj", "kal bhejenge", "last Wednesday", "15 tak", "Diwali ke baad") into real
 * dates, once, against the moment the words were said. Dates are local business dates (YYYY-MM-DD).
 */

const DAY_MS = 86_400_000;

export interface ResolvedDate {
  /** A single day. */
  date?: string;
  /** A range; either end may be open. */
  from?: string;
  to?: string;
  /** Time words that do not name a date ("jaldi", "soon"). */
  unresolved?: boolean;
  /** The words that were resolved. */
  phrase: string;
}

export interface DateOptions {
  /** Offset of the business's local time from UTC, in minutes (India: 330). */
  utcOffsetMinutes: number;
  /** Festival name -> its dates, one per year. */
  festivals: Record<string, string[]>;
}

export const DEFAULT_DATE_OPTIONS: DateOptions = {
  utcOffsetMinutes: 330,
  festivals: { diwali: ['2025-10-20', '2026-11-08'] },
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, ravivar: 0, itwar: 0, itvaar: 0,
  monday: 1, mon: 1, somvar: 1, somwar: 1,
  tuesday: 2, tue: 2, tues: 2, mangalvar: 2, mangalwar: 2, mangal: 2,
  wednesday: 3, wed: 3, budhvar: 3, budhwar: 3, budh: 3,
  thursday: 4, thu: 4, thurs: 4, guruvar: 4, guruwar: 4, veervar: 4, brihaspativar: 4,
  friday: 5, fri: 5, shukravar: 5, shukrawar: 5, shukra: 5,
  saturday: 6, sat: 6, shanivar: 6, shaniwar: 6, shani: 6,
};

const PAST = /\b(tha|thi|aaya|aayi|aya|gaya|gayi|gya|kiya|kia|hua|hui|mila|mili|diya|di|was|were|did|received|sent|paid|came|went|yesterday)\b/;
const FUTURE = /\b(dunga|dungi|denge|karunga|karenge|bhejenge|bhejunga|aayega|aayegi|hoga|hogi|jayega|will|shall|tomorrow|kar do|bhej do)\b/;
const VAGUE = /\b(jaldi|soon|asap|kabhi|baad mein|later|jald)\b/;

/** Local calendar date of an instant. */
export function localDate(at: string | Date, utcOffsetMinutes: number): string {
  const ms = (typeof at === 'string' ? Date.parse(at) : at.getTime()) + utcOffsetMinutes * 60_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC instants covering local dates `from`..`to` inclusive, for filtering stored timestamps. */
export function localDayRange(from: string, to: string, utcOffsetMinutes: number): { fromIso: string; toIso: string } {
  const start = Date.parse(`${from}T00:00:00.000Z`) - utcOffsetMinutes * 60_000;
  const end = Date.parse(`${to}T00:00:00.000Z`) + DAY_MS - 1 - utcOffsetMinutes * 60_000;
  return { fromIso: new Date(start).toISOString(), toIso: new Date(end).toISOString() };
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function ymd(year: number, month: number, day: number): string | undefined {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return undefined;
  return value.toISOString().slice(0, 10);
}

function lastDayOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** A day/month without a year: this year, unless that is far in the past (then next year). */
function withYear(today: string, month: number, day: number): string | undefined {
  const year = Number(today.slice(0, 4));
  const candidate = ymd(year, month, day);
  if (candidate && Date.parse(candidate) < Date.parse(today) - 180 * DAY_MS) return ymd(year + 1, month, day);
  return candidate;
}

function isPast(lower: string): boolean {
  return PAST.test(lower) && !FUTURE.test(lower);
}

export function resolveDate(text: string, reference: string | Date, options: DateOptions = DEFAULT_DATE_OPTIONS): ResolvedDate | undefined {
  const lower = ` ${text.toLowerCase()} `;
  const today = localDate(reference, options.utcOffsetMinutes);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const dayOfMonth = Number(today.slice(8, 10));

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(lower);
  if (iso) {
    const date = ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (date) return { date, phrase: iso[0] };
  }

  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(lower) ?? /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/.exec(lower);
  if (numeric) {
    const explicitYear = numeric[3] ? Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : undefined;
    const date = explicitYear
      ? ymd(explicitYear, Number(numeric[2]), Number(numeric[1]))
      : withYear(today, Number(numeric[2]), Number(numeric[1]));
    if (date) return { date, phrase: numeric[0].trim() };
  }

  const monthNames = Object.keys(MONTHS).join('|');
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})\\b`).exec(lower)
    ?? new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(lower);
  if (dayMonth) {
    const [first, second] = [dayMonth[1], dayMonth[2]];
    const day = Number(/^\d/.test(first) ? first : second);
    const monthNumber = MONTHS[/^\d/.test(first) ? second : first];
    const date = withYear(today, monthNumber, day);
    if (date) return { date, phrase: dayMonth[0].trim() };
  }

  for (const [festival, dates] of Object.entries(options.festivals)) {
    const match = new RegExp(`\\b${festival}\\b(\\s+(ke\\s+baad|se\\s+pehle|pe|par|ko))?|\\b(after|before|on)\\s+${festival}\\b`).exec(lower);
    if (!match) continue;
    const next = dates.filter((date) => Date.parse(date) >= Date.parse(today) - 30 * DAY_MS).sort()[0];
    if (!next) continue;
    const words = match[0].trim();
    if (/ke\s+baad|after/.test(words)) return { from: addDays(next, 1), phrase: words };
    if (/se\s+pehle|before/.test(words)) return { from: today, to: addDays(next, -1), phrase: words };
    return { date: next, phrase: words };
  }

  const endOfNamedMonth = new RegExp(`\\b(?:end of|month end of)\\s+(${monthNames})\\b|\\b(${monthNames})\\s+(?:end|ke end|ke aakhir)\\b`).exec(lower);
  if (endOfNamedMonth) {
    const monthNumber = MONTHS[endOfNamedMonth[1] ?? endOfNamedMonth[2]];
    const targetYear = monthNumber < month - 6 ? year + 1 : year;
    return { date: lastDayOfMonth(targetYear, monthNumber), phrase: endOfNamedMonth[0].trim() };
  }
  const monthEnd = /\b(month end|end of (?:the )?month|mahine ke (?:end|aakhir)|month ke end)\b/.exec(lower);
  if (monthEnd) return { date: lastDayOfMonth(year, month), phrase: monthEnd[0] };

  const weekMatch = /\b(next week|agle hafte|agla hafta|this week|is hafte|last week|pichhle hafte|pichle hafte)\b/.exec(lower);
  if (weekMatch) {
    const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
    const shift = /next|agle|agla/.test(weekMatch[0]) ? 7 : /last|pichh?le/.test(weekMatch[0]) ? -7 : 0;
    return { from: addDays(monday, shift), to: addDays(monday, shift + 6), phrase: weekMatch[0] };
  }

  const weekdayNames = Object.keys(WEEKDAYS).sort((left, right) => right.length - left.length).join('|');
  const weekday = new RegExp(`\\b(last|previous|pichh?le|pichhla|next|coming|agle|agla|is|this)?\\s*(${weekdayNames})\\b`).exec(lower);
  if (weekday) {
    const target = WEEKDAYS[weekday[2]];
    const current = weekdayOf(today);
    const modifier = weekday[1] ?? '';
    let offset: number;
    if (/last|previous|pichh?le|pichhla/.test(modifier) || (!modifier && isPast(lower))) {
      offset = -(((current - target + 7) % 7) || 7);
    } else if (/next|agle|agla/.test(modifier)) {
      offset = ((target - current + 7) % 7) || 7;
    } else {
      offset = (target - current + 7) % 7;
    }
    return { date: addDays(today, offset), phrase: weekday[0].trim() };
  }

  const relative = /\b(aaj|today|tonight|kal|tomorrow|yesterday|parson|parso|day after tomorrow|day before yesterday)\b/.exec(lower);
  if (relative) {
    const word = relative[1];
    const past = isPast(lower);
    const offsets: Record<string, number> = {
      aaj: 0, today: 0, tonight: 0, tomorrow: 1, yesterday: -1,
      'day after tomorrow': 2, 'day before yesterday': -2,
      kal: past ? -1 : 1, parson: past ? -2 : 2, parso: past ? -2 : 2,
    };
    return { date: addDays(today, offsets[word]), phrase: word };
  }

  const dayOnly = /\b(\d{1,2})(?:st|nd|rd|th)?\s*(tak|ko|tareekh|tarikh|tarik)\b|\bby\s+(\d{1,2})(?:st|nd|rd|th)\b/.exec(lower);
  if (dayOnly) {
    const day = Number(dayOnly[1] ?? dayOnly[3]);
    if (day >= 1 && day <= 31) {
      const sameMonth = day >= dayOfMonth;
      const targetMonth = sameMonth ? month : (month % 12) + 1;
      const targetYear = sameMonth || month < 12 ? year : year + 1;
      const date = ymd(targetYear, targetMonth, day) ?? lastDayOfMonth(targetYear, targetMonth);
      return { date, phrase: dayOnly[0].trim() };
    }
  }

  const vague = VAGUE.exec(lower);
  if (vague) return { unresolved: true, phrase: vague[1] };
  return undefined;
}
