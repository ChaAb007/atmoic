import './styles.css';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { AtomicV2 } from '@atomic-v2';
import type { Embedder } from '@atomic-v2';
import type { Face, FaceState, LipSync, Voice } from './contracts.ts';
import { Conversation } from './conversation.ts';
import type { TurnView } from './conversation.ts';
import { HashEmbedder } from './embed/hash.ts';
import { loadModelEmbedder } from './embed/model.ts';
import { HoloFace } from './face/HoloFace.ts';
import { TextLipSync } from './face/lipsync.ts';
import { describeError, streamReply } from './llm/claude.ts';
import { createMemoryStore } from './memory/stores.ts';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings.ts';
import type { Settings } from './settings.ts';
import { icons } from './ui/icons.ts';
import { renderExperience, renderRecalled, renderRecent, renderStats } from './ui/inspector.ts';
import { createVoice } from './voice/voice.ts';

const root = document.querySelector<HTMLDivElement>('#app')!;
root.innerHTML = `
<header class="top">
  <div class="brand">${icons.logo}<span>Surface AI</span></div>
  <span class="status" data-state="ready"><i></i><span>Ready</span></span>
  <span class="spacer"></span>
  <button class="icon-button" data-open="memory" aria-label="Memory">${icons.memory}</button>
  <button class="icon-button" data-open="settings" aria-label="Settings">${icons.settings}</button>
</header>
<main class="stage">
  <p class="banner" hidden></p>
  <div class="face-wrap"><canvas aria-label="Surface face"></canvas></div>
  <section class="caption"><h1>Hey, I'm Surface.</h1><p>Talk or type. I remember only what Atomic keeps on this phone.</p></section>
  <section class="turn" hidden aria-live="polite">
    <div class="you"><b>You</b> · <span class="ask"></span></div>
    <div class="reply"></div>
    <div class="meta"></div>
  </section>
  <div class="mic-row"><button class="mic" data-mode="ready" aria-label="Talk">${icons.mic}</button><span class="mic-label">Tap to talk</span></div>
</main>
<form class="composer">
  <textarea rows="1" placeholder="Ask anything… (or tap the mic to talk)" aria-label="Message"></textarea>
  <button class="send" type="submit" aria-label="Send">${icons.send}</button>
</form>
<div class="sheet" data-sheet="settings"><div class="scrim" data-close></div><div class="panel">
  <h2>Settings <button class="icon-button" data-close aria-label="Close">${icons.close}</button></h2>
  <p class="note">Everything stays on this phone. Your Claude API key is sent only to Anthropic's API.</p>
  <label class="field"><span>Claude API key</span><input name="apiKey" type="password" autocomplete="off" placeholder="sk-ant-..."></label>
  <label class="field"><span>Your name (optional)</span><input name="userName" autocomplete="off"></label>
  <label class="field"><span>Model</span><input name="model" autocomplete="off"></label>
  <label class="field"><span>Effort (lower answers faster)</span><select name="effort"><option>low</option><option>medium</option><option>high</option></select></label>
  <label class="field"><span>Voice language</span><select name="language"><option value="en-IN">English (India)</option><option value="hi-IN">Hindi</option><option value="en-US">English (US)</option><option value="en-GB">English (UK)</option></select></label>
  <label class="field"><span>Speech rate</span><input name="speechRate" type="number" min="0.6" max="1.6" step="0.1"></label>
  <label class="field row"><span>Speak replies aloud</span><input name="speakReplies" type="checkbox"></label>
  <div class="actions"><button class="primary" data-save-settings>Save</button></div>
</div></div>
<div class="sheet" data-sheet="memory"><div class="scrim" data-close></div><div class="panel">
  <h2>Atomic memory <button class="icon-button" data-close aria-label="Close">${icons.close}</button></h2>
  <div data-stats></div>
  <h3>Recalled for the last answer</h3><div data-recalled></div>
  <h3>Last exchange</h3><div data-experience></div>
  <h3>Recent memories</h3><div data-recent></div>
  <div class="actions"><button class="secondary" data-export>Export memory file</button><button class="danger" data-clear>Clear all memory</button></div>
</div></div>
<div class="boot"><div class="box"><h2>Preparing memory</h2><p data-boot-text>Loading…</p><div class="progress"><div></div></div><button class="secondary" data-skip-model hidden>Use basic memory for now</button></div></div>`;

const $ = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
const status = $<HTMLSpanElement>('.status');
const caption = { title: $<HTMLHeadingElement>('.caption h1'), text: $<HTMLParagraphElement>('.caption p') };
const turnBox = $<HTMLElement>('.turn');
const mic = $<HTMLButtonElement>('.mic');
const micLabel = $<HTMLSpanElement>('.mic-label');
const input = $<HTMLTextAreaElement>('.composer textarea');
const banner = $<HTMLParagraphElement>('.banner');
const boot = $<HTMLDivElement>('.boot');

let settings: Settings = { ...DEFAULT_SETTINGS };
let atomic: AtomicV2 | undefined;
let embedderNote = '';
let lastTurn: TurnView | undefined;
let listening = false;

// Face
let face: Face | undefined;
let lipSync: LipSync | undefined;
try {
  face = new HoloFace($<HTMLCanvasElement>('.face-wrap canvas'));
  lipSync = new TextLipSync(face);
  window.addEventListener('resize', () => face?.resize());
} catch {
  $<HTMLDivElement>('.face-wrap').innerHTML = '<div class="face-fallback"></div>';
}

const voice: Voice = createVoice();

function setMode(state: FaceState | 'error', title?: string, text?: string) {
  status.dataset.state = state;
  status.querySelector('span')!.textContent = { ready: 'Ready', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', error: 'Error' }[state];
  mic.dataset.mode = state;
  micLabel.textContent = state === 'listening' ? 'Tap to stop' : state === 'ready' || state === 'error' ? 'Tap to talk' : 'Tap to interrupt';
  mic.innerHTML = state === 'ready' || state === 'error' ? icons.mic : icons.stop;
  if (state !== 'error') face?.setState(state);
  if (title !== undefined) caption.title.textContent = title;
  if (text !== undefined) caption.text.textContent = text;
}

function showTurn(turn: TurnView) {
  lastTurn = turn;
  turnBox.hidden = false;
  turnBox.querySelector('.ask')!.textContent = turn.ask;
  const reply = turnBox.querySelector<HTMLDivElement>('.reply')!;
  reply.classList.toggle('error', turn.phase === 'error');
  reply.textContent = turn.phase === 'error' ? turn.error ?? 'Something went wrong.' : turn.reply || '…';
  const meta = turnBox.querySelector<HTMLDivElement>('.meta')!;
  const used = `<button type="button" class="chip" data-open="memory">${turn.memories.length ? `Used ${turn.memories.length} ${turn.memories.length === 1 ? 'memory' : 'memories'}` : 'No memory used'}</button>`;
  const saved = turn.experience ? `<span class="chip">Saved · ${turn.experience.kind}</span>` : '';
  const vote = turn.experience
    ? `<span class="spacer"></span><button type="button" class="chip ${turn.experience.feedback === 'good' ? 'good' : ''}" data-vote="good" aria-label="Good answer">${icons.up}</button><button type="button" class="chip ${turn.experience.feedback === 'bad' ? 'bad' : ''}" data-vote="bad" aria-label="Bad answer">${icons.down}</button>`
    : '';
  meta.innerHTML = used + saved + vote;
  turnBox.scrollTop = turnBox.scrollHeight;
  if (turn.phase === 'thinking') setMode('thinking', 'Thinking…', turn.memories.length ? `Recalled ${turn.memories.length} from memory` : 'Nothing in memory about this');
  else if (turn.phase === 'speaking') setMode('speaking', 'Speaking…', '');
  else if (turn.phase === 'error') setMode('error', 'Something went wrong', 'Tap the mic or type to try again.');
  else setMode('ready', "Hey, I'm Surface.", turn.experience ? 'Saved to memory.' : '');
}

const conversation = new Conversation({
  memory: {
    recall: (ask) => atomic!.recall(ask),
    process: (experience) => atomic!.process(experience),
  },
  startReply: ({ settings: current, system, messages, onText }) =>
    streamReply({ apiKey: current.apiKey, model: current.model, effort: current.effort, system, messages, onText }),
  settings: () => settings,
  voice,
  face,
  lipSync,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  onTurn: showTurn,
  describeError,
});

async function send(text: string) {
  if (!text.trim()) return;
  if (!settings.apiKey) {
    openSheet('settings');
    return;
  }
  if (!atomic) return;
  input.value = '';
  await conversation.ask(text);
}

async function listen() {
  if (!voice.canListen) {
    caption.text.textContent = 'Speech recognition is not available here. Type instead.';
    return;
  }
  if (!(await voice.init())) {
    caption.text.textContent = 'Microphone permission is needed to talk.';
    return;
  }
  listening = true;
  setMode('listening', 'Listening…', 'You can speak naturally');
  const heard = await voice.listen({
    lang: settings.language,
    onPartial: (text) => { caption.text.textContent = text; },
    onLevel: (level) => face?.setInputLevel(level),
  }).finally(() => { listening = false; face?.setInputLevel(0); });
  if (heard.trim()) await send(heard);
  else setMode('ready', "Hey, I'm Surface.", "I didn't catch that. Tap the mic and try again.");
}

mic.addEventListener('click', () => {
  if (listening) void voice.stopListening();
  else if (conversation.busy) conversation.interrupt();
  else void listen();
});

$<HTMLFormElement>('.composer').addEventListener('submit', (event) => {
  event.preventDefault();
  void send(input.value);
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void send(input.value);
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(120, input.scrollHeight)}px`;
});

turnBox.addEventListener('click', async (event) => {
  const vote = (event.target as HTMLElement).closest<HTMLElement>('[data-vote]');
  if (!vote || !lastTurn?.experience || !atomic) return;
  await atomic.feedback(lastTurn.experience.id, vote.dataset.vote === 'good');
  showTurn({ ...lastTurn, experience: atomic.get(lastTurn.experience.id) });
});

// Sheets
function openSheet(name: 'settings' | 'memory') {
  const sheet = root.querySelector<HTMLDivElement>(`[data-sheet="${name}"]`)!;
  if (name === 'settings') fillSettings();
  else renderMemory();
  sheet.classList.add('open');
}

root.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const open = target.closest<HTMLElement>('[data-open]');
  if (open) openSheet(open.dataset.open as 'settings' | 'memory');
  if (target.closest('[data-close]')) target.closest('.sheet')?.classList.remove('open');
});

const settingsPanel = root.querySelector<HTMLDivElement>('[data-sheet="settings"]')!;
const field = <T extends HTMLInputElement | HTMLSelectElement>(name: keyof Settings) => settingsPanel.querySelector<T>(`[name="${name}"]`)!;

function fillSettings() {
  field<HTMLInputElement>('apiKey').value = settings.apiKey;
  field<HTMLInputElement>('userName').value = settings.userName;
  field<HTMLInputElement>('model').value = settings.model;
  field<HTMLSelectElement>('effort').value = settings.effort;
  field<HTMLSelectElement>('language').value = settings.language;
  field<HTMLInputElement>('speechRate').value = String(settings.speechRate);
  field<HTMLInputElement>('speakReplies').checked = settings.speakReplies;
}

settingsPanel.querySelector('[data-save-settings]')!.addEventListener('click', async () => {
  settings = {
    apiKey: field<HTMLInputElement>('apiKey').value.trim(),
    userName: field<HTMLInputElement>('userName').value.trim(),
    model: field<HTMLInputElement>('model').value.trim() || DEFAULT_SETTINGS.model,
    effort: field<HTMLSelectElement>('effort').value as Settings['effort'],
    language: field<HTMLSelectElement>('language').value,
    speechRate: Math.min(1.6, Math.max(0.6, Number(field<HTMLInputElement>('speechRate').value) || 1)),
    speakReplies: field<HTMLInputElement>('speakReplies').checked,
  };
  await saveSettings(settings);
  settingsPanel.classList.remove('open');
});

const memoryPanel = root.querySelector<HTMLDivElement>('[data-sheet="memory"]')!;

function renderMemory() {
  if (!atomic) return;
  const now = new Date();
  memoryPanel.querySelector('[data-stats]')!.innerHTML = renderStats(atomic.stats(), embedderNote);
  memoryPanel.querySelector('[data-recalled]')!.innerHTML = renderRecalled(lastTurn?.memories ?? [], now);
  memoryPanel.querySelector('[data-experience]')!.innerHTML = renderExperience(lastTurn?.experience);
  memoryPanel.querySelector('[data-recent]')!.innerHTML = renderRecent(atomic.list(30), now);
}

memoryPanel.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  if (!atomic) return;
  const forget = target.closest<HTMLElement>('[data-forget]');
  if (forget) {
    await atomic.forget(forget.dataset.forget!);
    renderMemory();
  } else if (target.closest('[data-clear]')) {
    if (confirm('Clear all memory on this phone? This cannot be undone.')) {
      await atomic.clear();
      renderMemory();
    }
  } else if (target.closest('[data-export]')) {
    await exportMemory(atomic.exportJson());
  }
});

async function exportMemory(json: string) {
  const name = `surface-memory-${new Date().toISOString().slice(0, 10)}.json`;
  if (Capacitor.isNativePlatform()) {
    const { uri } = await Filesystem.writeFile({ path: name, data: json, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: 'Atomic memory', files: [uri] });
    return;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

// Boot: settings, then the memory model, then Atomic.
async function chooseEmbedder(): Promise<Embedder> {
  const text = boot.querySelector<HTMLParagraphElement>('[data-boot-text]')!;
  const fill = boot.querySelector<HTMLDivElement>('.progress div')!;
  const skip = boot.querySelector<HTMLButtonElement>('[data-skip-model]')!;
  text.textContent = 'Loading the on-device language model for memory (about 120 MB, downloaded once).';
  const skipped = new Promise<'skip'>((resolve) => {
    setTimeout(() => { skip.hidden = false; }, 4000);
    skip.addEventListener('click', () => resolve('skip'), { once: true });
  });
  const model = loadModelEmbedder(({ loaded, total }) => {
    if (total > 0) fill.style.width = `${Math.round((loaded / total) * 100)}%`;
    text.textContent = `Downloading the memory model once: ${(loaded / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB.`;
  });
  try {
    const winner = await Promise.race([model, skipped]);
    if (winner !== 'skip') {
      embedderNote = 'on-device multilingual model';
      return winner;
    }
    model.catch(() => undefined);
    embedderNote = 'basic memory (spelling only) until the model loads';
  } catch (error) {
    embedderNote = 'basic memory (spelling only): the model could not load';
    banner.textContent = `Basic memory mode: ${error instanceof Error ? error.message : String(error)}. Memory upgrades itself when the model loads next time.`;
    banner.hidden = false;
  }
  return new HashEmbedder();
}

async function start() {
  settings = await loadSettings();
  const embedder = await chooseEmbedder();
  const text = boot.querySelector<HTMLParagraphElement>('[data-boot-text]')!;
  atomic = await AtomicV2.open({
    embedder,
    store: createMemoryStore(),
    onProgress: (stage, done, total) => {
      text.textContent = stage === 'anchors' ? `Calibrating memory layers… ${done}/${total}` : `Upgrading memory to the new model… ${done}/${total}`;
    },
  });
  boot.hidden = true;
  if (!settings.apiKey) openSheet('settings');
}

start().catch((error) => {
  boot.querySelector('h2')!.textContent = 'Memory could not start';
  boot.querySelector('[data-boot-text]')!.textContent = error instanceof Error ? error.message : String(error);
});
