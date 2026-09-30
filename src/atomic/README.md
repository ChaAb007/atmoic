# Atomic v1 (prototype)

Memory for small businesses: every conversation, task step and business event is recorded raw, scored for
relevance and importance, kept at L1 / L2 / L3 with an L4 summary, and linked to close past experience.
Learning changes link and memory strength, track records and per-business weights. It never rewrites experience
and never changes Fundamental.

## Installing into a host application

The host supplies everything environment-specific:

| What | Interface | Notes |
| --- | --- | --- |
| Database | `StorageAdapter` (`ports.ts`) | One per client, created on demand by `storageFor(tenantId)`. `InMemoryStorage` is a reference for tests only. |
| Embeddings | `Embedder` | Multilingual model (e.g. BGE-M3). |
| Importance | `Classifier` | One call returns all angles and candidate kinds. |
| Splitting, summary | `Splitter`, `Summarizer` | Optional; line splitter and extractive summary are defaults. |
| Outcomes | `OutcomeMatcher` | Optional; default matches payment events by party, deal and amount. |
| Fundamental | `fundamentalFor(tenantId)` | Owner-set rules; frozen inside the engine. |

```ts
const host = new AtomicHost({ storageFor, fundamentalFor, models: { embedder, classifier } });
const abc = await host.open('abc');                 // opened on first use
const { recall } = await abc.onInput(input);         // fast path: recall only
// background: layers 0-3, L4 summary, links
setInterval(() => host.tick(), 60_000);              // learning syncs in each client's own window
setInterval(() => abc.dueCheck(), 86_400_000);      // daily promise vs outcome check
```

## Sync windows

Learning (strength changes, track records, weight changes) is buffered in storage and applied only in the
client's window. Each client gets a fixed slot in the cycle (`slotFor`), so clients never all sync together;
`maxConcurrent` caps clients per tick and `batchSize` caps events per client per tick. Facts that affect what
the agent says right now (a replaced rate, a recorded outcome, a promoted level) land immediately.

## Known V1 limits

- Two agents can give input on the same thread (#46 in the stress test); one listener per thread is deferred.
- Photos and PDFs need an input layer in front of Record.
