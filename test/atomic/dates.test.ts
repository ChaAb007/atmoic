import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DATE_OPTIONS, localDate, localDayRange, resolveDate } from '../../src/atomic/dates.ts';

// Thursday 1 Oct 2026, 10:00 in India.
const THU = '2026-10-01T04:30:00.000Z';

const TABLE: [string, Record<string, unknown> | undefined][] = [
  ['aaj bhejo', { date: '2026-10-01' }],
  ['please make a SO for today', { date: '2026-10-01' }],
  ['kal bhejenge', { date: '2026-10-02' }],
  ['kal aaya tha', { date: '2026-09-30' }],
  ['kal', { date: '2026-10-02' }],
  ['yesterday payment mila', { date: '2026-09-30' }],
  ['tomorrow tak', { date: '2026-10-02' }],
  ['parson dunga', { date: '2026-10-03' }],
  ['parso aaya tha', { date: '2026-09-29' }],
  ['last Wednesday', { date: '2026-09-30' }],
  ['pichhle budhwar ko', { date: '2026-09-30' }],
  ['next Monday', { date: '2026-10-05' }],
  ['agle somvar tak', { date: '2026-10-05' }],
  ['friday tak', { date: '2026-10-02' }],
  ['thursday ko', { date: '2026-10-01' }],
  ['friday ko aaya tha', { date: '2026-09-25' }],
  ['15 tak kar dunga', { date: '2026-10-15' }],
  ['5th tak', { date: '2026-10-05' }],
  ['month end tak', { date: '2026-10-31' }],
  ['end of nov', { date: '2026-11-30' }],
  ['payment 3.2 lakh 15 oct tak', { date: '2026-10-15' }],
  ['oct 20', { date: '2026-10-20' }],
  ['20/10', { date: '2026-10-20' }],
  ['20.10.2026', { date: '2026-10-20' }],
  ['2026-10-15 ko', { date: '2026-10-15' }],
  ['Diwali ke baad', { from: '2026-11-09' }],
  ['diwali se pehle', { from: '2026-10-01', to: '2026-11-07' }],
  ['diwali pe', { date: '2026-11-08' }],
  ['agle hafte', { from: '2026-10-05', to: '2026-10-11' }],
  ['last week', { from: '2026-09-21', to: '2026-09-27' }],
  ['jaldi bhejo', { unresolved: true }],
  ['₹78/kg', undefined],
  ['3 ton nails', undefined],
  ['3.2 lakh', undefined],
  ['holi ke baad', undefined],
];

for (const [text, expected] of TABLE) {
  test(`date words: "${text}"`, () => {
    const resolved = resolveDate(text, THU);
    if (!expected) {
      assert.equal(resolved, undefined);
      return;
    }
    const { phrase: _phrase, ...rest } = resolved!;
    assert.deepEqual(rest, expected);
  });
}

test('the local business day is used, not the UTC day', () => {
  // 01:30 on 1 Oct in India is still 30 Sep in UTC.
  assert.equal(localDate('2026-09-30T20:00:00.000Z', 330), '2026-10-01');
  assert.deepEqual(resolveDate('aaj', '2026-09-30T20:00:00.000Z'), { date: '2026-10-01', phrase: 'aaj' });
  assert.deepEqual(localDayRange('2026-10-01', '2026-10-01', 330), {
    fromIso: '2026-09-30T18:30:00.000Z',
    toIso: '2026-10-01T18:29:59.999Z',
  });
});

test('a past day of the month rolls to next month, and December rolls to January', () => {
  assert.equal(resolveDate('5 tak', '2026-10-20T04:30:00.000Z')!.date, '2026-11-05');
  assert.equal(resolveDate('5 tak', '2026-12-20T04:30:00.000Z')!.date, '2027-01-05');
  assert.equal(resolveDate('31 tak', '2026-02-10T04:30:00.000Z')!.date, '2026-02-28');
  assert.equal(resolveDate('5 jan', '2026-12-20T04:30:00.000Z')!.date, '2027-01-05');
});

test('the festival calendar is supplied by the host', () => {
  const options = { ...DEFAULT_DATE_OPTIONS, festivals: { holi: ['2027-03-22'] } };
  assert.deepEqual(resolveDate('holi ke baad', '2027-03-01T04:30:00.000Z', options), { from: '2027-03-23', phrase: 'holi ke baad' });
});
