# Surface AI (test prototype)

A voice and chat companion with a holographic 3D face whose **only memory is Atomic v2**, kept in a file on the
phone. There is no backend and no chat session.

## How one exchange works

1. You speak (or type) one ask.
2. Atomic v2 recalls the past experiences that match this ask, and only those.
3. Claude (`claude-opus-5-5`, effort `low` by default) gets **exactly one message**: your ask. Everything it knows
   about the past is the recalled memories in its system prompt. Nothing else from earlier is ever sent.
4. The reply streams back and is spoken sentence by sentence while the face's lips move with the words.
5. Your ask and the reply are pushed through Atomic's four layers as one unit and saved to the memory file.

Thumbs up/down on an answer teaches Atomic which memories helped. A follow-up like "no, that's wrong" or
"thanks, perfect" also changes how the earlier exchange is judged.

## Memory on the device

- File: the app's private storage, `atomic/memory-v2.json` (written safely: temp file, then swapped in).
- Embeddings: `Xenova/paraphrase-multilingual-MiniLM-L12-v2` runs on the phone in a background worker
  (downloaded once, ~120 MB, then cached). Until it is available, a basic spelling-based embedder is used; memory
  is rebuilt with the model automatically the next time it loads.
- Settings, including your Claude API key, are stored only on the phone (Capacitor Preferences). The key is sent
  only to Anthropic's API.
- Memory → Export shares the memory file; Memory → Clear deletes it.

## Build the APK

GitHub Actions builds a debug APK on every push (`.github/workflows/android-apk.yml`); download it from the run's
artifacts (`surface-ai-debug-apk`) and install it on the phone (allow installs from unknown sources).

Locally (needs the Android SDK and JDK 21):

```bash
cd app
npm ci --ignore-scripts
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
```

Try it in a browser with `npm run dev` (speech recognition needs Chrome; the memory model needs internet the first
time).

## In-chat preview

`npm run build:preview` builds the same app as one page for a Claude artifact (`src/preview.ts`, output in
`dist-preview/artifact/`). There, replies come from the viewer's own Claude account through the artifact's `sample`
capability (still one prompt per message, no history), memory lives in that browser, Surface speaks but cannot
listen (artifact frames have no microphone), and memory uses the spelling-based embedder because the on-device
model cannot be downloaded inside the frame.

## Notes for the prototype

- Calls go straight from the phone to the Claude API using your key (the SDK's browser mode). Fine for a personal
  test build; a public app would put a server in between.
- Refused requests are retried on Anthropic's recommended fallback model (`fallbacks: "default"`); if the whole
  chain declines, the app says so and nothing is stored.
