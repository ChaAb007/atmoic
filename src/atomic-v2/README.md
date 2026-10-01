# Atomic v2

Memory built from **units**: one ask plus one response, embedded once and pushed through four layers. Every
layer works on vectors; the raw text is kept only so exact figures can be read back when answering.

```
ASK + RESPONSE ─► embedded (ask, response, ask+response, each sentence)
   │
   ├─ Layer 1  Relevance   each piece vs the other side; most relevant goes through first
   ├─ Layer 2  Importance  15 sub-layers per piece
   │             reference checks: facts, intelligence, intent, decision, commitment, time,
   │                               pressure*, risk, relationship*, emotion*, attention*
   │             task ↔ response:  correctness
   │             memory checks:    novelty, trust, situation (+ history pull)
   │             (* read only from the person, never from the AI's reply)
   ├─ Layer 3  Allocation  L1 work/current · L2 past/future/growth/decision · L3 emotional
   │                       (a piece can go to several) · L4 small summary of both
   └─ Layer 4  Experience  combined vector = whole unit + importance-weighted level vectors;
                           the dominant level gives the kind (work / growth / emotional / casual);
                           components are stored too, so no meaning is lost
```

## Reference checks calibrate themselves

Each sub-layer has example sentences in English, Hindi and Hinglish (`anchors.ts`). Its direction is the mean of
its examples minus the mean of all examples (topics cancel out, the shared meaning stays), and its threshold
sits halfway between how its own examples and everyone else's project onto it. So the same code works with any
sentence embedder without hand tuning, and a topic word inside an example does not make unrelated text score.

## Learning

- **History pull:** if the same thing went badly before (negative feeling or low satisfaction), it is more
  important now.
- **Reactions:** an ask within 30 minutes that praises or corrects ("thanks, perfect" / "no, that's wrong")
  changes the satisfaction of the related earlier exchange.
- **Feedback:** thumbs up/down sets satisfaction and strengthens or weakens the exchange and the memories that
  were recalled for it. Strength decays with time when read; reading never writes.

## No chat session

`recall(ask)` returns only experiences that match the ask (similarity ≥ `recallMinSimilarity`). Nothing comes
back just because it was recent, so whatever uses Atomic can only know the past through what it recalls.

## Storage

`MemoryStore` reads and writes one JSON text. Vectors are stored as int8 with a scale (about 4× smaller than
float32, ~1% cosine error). The file records the embedder id; opening it with a different embedder rebuilds every
experience from its raw text and keeps what was learned (satisfaction, strength, feedback). Anchor vectors are
cached in the file.

```ts
const atomic = await AtomicV2.open({ embedder, store });
const { items } = await atomic.recall(ask);
const experience = await atomic.process({ ask, response, recalled: items.map((item) => item.experience.id) });
await atomic.feedback(experience.id, true);
```

Tests: `test/atomic-v2/` (deterministic concept embedder).
