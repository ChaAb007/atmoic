import { SUB_LAYERS } from '@atomic-v2';
import type { Experience, RecallItem, Stats } from '@atomic-v2';
import { describeWhen } from '../llm/prompt.ts';

/** Renders the memory sheet: what Atomic holds, what it recalled for the last answer, and how it layered it. */

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const percent = (value: number) => `${Math.round(value * 100)}`;

function bar(label: string, value: number, tone = '') {
  return `<div class="bar"><span>${label}</span><div class="track"><div class="fill ${tone}" style="width:${percent(Math.min(1, Math.max(0, value)))}%"></div></div><em>${percent(value)}</em></div>`;
}

const LEVEL_NAMES: Record<string, string> = { L1: 'L1 work', L2: 'L2 growth', L3: 'L3 emotion', L4: 'L4 summary' };

export function renderStats(stats: Stats, embedderNote: string): string {
  const cell = (value: number, label: string) => `<div class="stat"><b>${value}</b><small>${label}</small></div>`;
  return `<div class="stats">${cell(stats.byKind.work, 'work')}${cell(stats.byKind.growth, 'growth')}${cell(stats.byKind.emotional, 'emotional')}${cell(stats.byKind.casual, 'casual')}</div>
<p class="note" style="margin-top:8px">${stats.experiences} experiences on this device · ${escape(embedderNote)}</p>`;
}

export function renderRecalled(items: RecallItem[], now: Date): string {
  if (!items.length) return '<p class="empty">Nothing was recalled for the last ask: it was answered with no memory.</p>';
  return items.map(({ experience, similarity, matched }) => `<div class="memory-item">
<header><span class="kind ${experience.kind}">${experience.kind}</span><span>${escape(describeWhen(experience.at, now))}</span><span>match ${percent(similarity)} via ${matched}</span></header>
<p>${escape(experience.summary)}</p></div>`).join('');
}

export function renderExperience(experience: Experience | undefined): string {
  if (!experience) return '<p class="empty">The last exchange has not been saved yet.</p>';
  const total = experience.levelWeights.L1 + experience.levelWeights.L2 + experience.levelWeights.L3 + experience.levelWeights.L4 || 1;
  const levels = (['L1', 'L2', 'L3', 'L4'] as const)
    .map((level) => bar(LEVEL_NAMES[level], experience.levelWeights[level] / total, level === 'L2' ? 'l2' : level === 'L3' ? 'l3' : ''))
    .join('');
  const profile = SUB_LAYERS
    .map((name) => ({ name, value: experience.profile[name] }))
    .sort((left, right) => right.value - left.value)
    .map(({ name, value }) => bar(name, value))
    .join('');
  const pieces = experience.pieces
    .map((piece) => `<div class="piece">${escape(piece.text)}<br><small>${piece.side} · relevance ${percent(piece.relevance)} · importance ${percent(piece.importance)} · ${piece.levels.join(' + ') || 'not allocated'}</small></div>`)
    .join('');
  return `<p class="note"><span class="kind ${experience.kind}">${experience.kind}</span> importance ${percent(experience.importance)} · feeling ${experience.valence >= 0 ? '+' : ''}${experience.valence.toFixed(2)} · satisfaction ${percent(experience.satisfaction)}${experience.historyPull > 0.05 ? ` · history pull ${percent(experience.historyPull)}` : ''}</p>
<h3>Layer 3 · allocation</h3><div class="bars">${levels}</div>
<h3>Layer 2 · importance angles</h3><div class="bars">${profile}</div>
<h3>Layer 1 · pieces by relevance</h3>${pieces}`;
}

export function renderRecent(experiences: Experience[], now: Date, where = 'on this phone'): string {
  if (!experiences.length) return `<p class="empty">No memories yet. Everything you talk about is kept here, ${where}.</p>`;
  return experiences.map((experience) => `<div class="memory-item" data-id="${experience.id}">
<header><span class="kind ${experience.kind}">${experience.kind}</span><span>${escape(describeWhen(experience.at, now))}</span><button data-forget="${experience.id}">Forget</button></header>
<p>${escape(experience.summary)}</p></div>`).join('');
}
