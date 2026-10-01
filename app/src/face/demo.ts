/** Standalone page for checking the face by eye: state buttons, a fake mic and a silent lip-sync sample. */

import type { FaceState } from '../contracts.ts';
import { HoloFace } from './HoloFace.ts';
import { TextLipSync, buildVisemeTimeline } from './lipsync.ts';

const SAMPLE = 'Namaste! Main aapki madad kar sakti hoon. Aaj mausam bahut acha hai, chalo baat karte hain.';
const CHARS_PER_SECOND = 14;

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`face demo: missing ${selector}`);
  return element;
}

const canvas = required<HTMLCanvasElement>('#face');
const status = required<HTMLElement>('#status');
const stateButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-state]'));
// ?fixed keeps full resolution even when slow (headless screenshots).
const face = new HoloFace(canvas, { adaptiveResolution: !new URLSearchParams(location.search).has('fixed') });
const lipSync = new TextLipSync(face);
let micTimer: number | undefined;
let speechTimer: number | undefined;

function showState(state: FaceState): void {
  face.setState(state);
  status.textContent = state;
  for (const button of stateButtons) button.setAttribute('aria-pressed', String(button.dataset.state === state));
  window.clearInterval(micTimer);
  // A fake microphone so the listening rings have something to react to.
  if (state === 'listening') {
    micTimer = window.setInterval(() => {
      const t = performance.now() / 1000;
      face.setInputLevel(Math.max(0, Math.sin(t * 3.1) * Math.sin(t * 7.3)) * 0.9);
    }, 50);
  }
}

function speakSample(): void {
  window.clearTimeout(speechTimer);
  showState('speaking');
  lipSync.start(SAMPLE, { charsPerSecond: CHARS_PER_SECOND });
  const seconds = buildVisemeTimeline(SAMPLE, CHARS_PER_SECOND).duration;
  speechTimer = window.setTimeout(() => {
    lipSync.stop();
    showState('ready');
  }, seconds * 1000 + 200);
}

const STATES: readonly FaceState[] = ['ready', 'listening', 'thinking', 'speaking'];

function isFaceState(value: string | undefined): value is FaceState {
  return STATES.some((state) => state === value);
}

for (const button of stateButtons) {
  button.addEventListener('click', () => {
    const state = button.dataset.state;
    if (!isFaceState(state)) return;
    lipSync.stop();
    showState(state);
  });
}
required<HTMLButtonElement>('#speak').addEventListener('click', speakSample);

// Handles for scripted visual checks.
Object.assign(window, { face, lipSync, speakSample, showState });
