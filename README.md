# fable-workflow

A configurable, data-model-agnostic workflow engine for Fable.

Two things live here. The boring, solved part: an append-only event log that is the
source of truth for a unit of work, with time metrics folded on every write. The
interesting part: a state machine defined entirely in config, where roles gate who can
move work forward and arbitrary data decides when a move is allowed. The engine never
imports your schema. It reaches your data only through a resolver you supply, so one
engine drives any domain.

## Install

```
npm install fable-workflow
```

Peer concepts come from the Retold stack: it registers as a Fable service provider and
resolves data addresses with Manyfest. It works standalone too (the core has no Fable
or database dependency).

## The idea in one minute

- An **event log** per subject is the truth. Opening a subject, entering and leaving
  states, an actor starting and stopping work, a note, a prompt: all are appended,
  never mutated.
- Two **projections** are folded onto that log on every event, so you never replay it
  to answer a question:
  - a **metrics rollup** (elapsed, active, stalled, effort, overlap, time in each
    state, time per actor), and
  - an **eligibility set** (the exits open right now, each with its readiness flag and
    its gate).
- Because readiness is precomputed on write, the agency questions ("what can this
  person move forward", "who can act on this item") are flat reads, not a sweep of
  guards or a pile of SQL.
- A **workflow is config**: states, transitions with multiple exits, role gates, and
  readiness guards. Guards are structured condition trees over addresses into your
  data. The engine resolves those addresses through a **context resolver** you provide,
  which is the one and only place it touches your model.

## Quick start

```javascript
const libFable = require('fable');
const libFableWorkflow = require('fable-workflow');

let tmpFable = new libFable();
tmpFable.serviceManager.addServiceType('Workflow', libFableWorkflow);
let tmpWorkflow = tmpFable.serviceManager.instantiateServiceProvider('Workflow');

// 1. Define the workflow. This is pure config; no code knows what an "article" is.
tmpWorkflow.defineWorkflow(
	{
		Key: 'editorial',
		Name: 'Editorial Review',
		States:
		[
			{ Key: 'draft',     Name: 'Draft',     IsInitial: true },
			{ Key: 'review',    Name: 'In Review' },
			{ Key: 'copyedit',  Name: 'Copy Edit' },
			{ Key: 'published', Name: 'Published', IsTerminal: true }
		],
		Transitions:
		[
			{ From: 'draft',    To: 'review',    RequiresEntitlement: 'author.submit',  Guard: { address: 'Article.WordCount', op: '>=', value: 500 } },
			{ From: 'review',   To: 'copyedit',  RequiresEntitlement: 'editor.approve', Guard: { address: 'Article.Score', op: '>=', value: 3 } },
			{ From: 'review',   To: 'draft',     RequiresEntitlement: 'editor.approve' },
			{ From: 'copyedit', To: 'published', RequiresEntitlement: 'editor.publish' }
		]
	});

// 2. Tell the engine how to reach your data. It calls this with a subject id.
let _Articles = { 'a-42': { WordCount: 320, Score: 0 } };
tmpWorkflow.setContextResolver((pSubjectId) => ({ Article: _Articles[pSubjectId] }));

// 3. Drive a subject. An actor is { ID, Entitlements: [] }.
let _Jan = { ID: 'jan', Entitlements: ['author.submit'] };
tmpWorkflow.open('a-42', 'editorial', _Jan);

tmpWorkflow.advance('a-42', 'review', _Jan);   // { ok: false, reason: 'the readiness guard for "review" is not satisfied' }

_Articles['a-42'].WordCount = 900;             // the author keeps writing
tmpWorkflow.reevaluate('a-42');                // re-fold eligibility against the new data
tmpWorkflow.advance('a-42', 'review', _Jan);   // { ok: true, state: { CurrentStates: ['review'], ... } }
```

The engine has no idea what an article is. Point the resolver at units, tickets,
candidates, or loans and the same five methods run that domain with zero new code. The
`example/editorial-review.js` script proves this by running a second, unrelated domain
(a hardware return) on the same engine.

## Concepts

### States and transitions

A state has a `Key`, an optional `Name` and `Category`, and the flags `IsInitial` and
`IsTerminal`. If you do not mark an initial state, the first one is used. Entering a
terminal state closes the subject and stops its clocks.

A transition is a directed exit from one state to another. A state can have several
exits (approve, send back, reject), each with its own gate and guard.

### Guards: readiness from your data

A guard answers "is this move allowed by the data yet". It is a structured condition
tree, not a string to be parsed:

```javascript
// a leaf
{ address: 'Article.WordCount', op: '>=', value: 500 }

// branches: all / any / not
{ all: [ { address: 'Article.Score', op: '>=', value: 3 },
         { address: 'Article.Media[].Kind', op: 'includesAny', value: ['image', 'video'] } ] }
```

Addresses are resolved through your context resolver with Manyfest, so wildcards like
`Media[].Kind` work. A missing guard means "no condition", which is always satisfied.

Operators: `==` `===` `!=` `>` `>=` `<` `<=` `in` `nin` `exists` `empty` `truthy`
`falsy`, plus the collection reductions `includesAny` `includesAll` `countGte` for
wildcard addresses.

Guards can also read two engine-owned namespaces the engine layers onto the context:
`State.Current` (the array of current state keys) and `Metrics` (the rollup below), so
a guard can depend on elapsed time or the current state if you want it to.

### Gates: roles and designated actors

A transition can require an entitlement (`RequiresEntitlement: 'editor.approve'`); an
actor must carry that string in its `Entitlements` to make the move. A transition can
also name a `ActorAddress`, an address into your data that resolves to a specific actor
id (for example "only the assigned reviewer"); only the actor whose `ID` matches may
move it.

A move succeeds only when the guard is satisfied and the actor clears the gate.
`advance` returns `{ ok: true, state }` or `{ ok: false, reason }`.

### The context resolver: the one seam to your model

`setContextResolver((pSubjectId) => object)` is the entire coupling between the engine
and your data. Guards address into the object it returns. This is the backbone you
build visualizations and reports on as well: one read, many consumers.

### Projections: metrics and eligibility

Every event folds the metrics rollup:

| Field | Meaning |
| --- | --- |
| `OpenedAt`, `ClosedAt` | open and close timestamps |
| `ElapsedMS` | wall-clock from open to now (or to close) |
| `ActiveMS` | time at least one actor was working |
| `StalledMS` | elapsed minus active |
| `EffortMS` | sum of every actor's working time |
| `OverlapMS` | effort minus active (concurrent work) |
| `StateTime` | milliseconds spent in each state |
| `ActorTime` | milliseconds worked by each actor |

Active, effort, and overlap come from `actor.start` and `actor.stop` events you emit
when work begins and pauses. State time accrues automatically as states are entered and
left.

The eligibility set is the list of exits open from the current state, each with
`ToState`, `GuardSatisfied`, `RequiredEntitlement`, and `ResolvedActor`. When a guard
flips from unsatisfied to satisfied during a `reevaluate`, the engine appends an
`exit.became-available` event so you can react to work becoming ready.

### Agency queries

Because eligibility is materialized, these are indexed reads:

- `whatCanAdvance(actor)` returns the subject ids this actor can move forward right now.
- `whoCanActOn(subjectId)` returns the open exits and what each requires.

### Parallel states

Set `AllowParallelStates: true` on a workflow and a subject can occupy more than one
state at once (a design phase and a documentation phase running together). By default a
subject holds a single state and entering a new one exits the prior automatically.

## API

All methods are on the service (`fable.Workflow`) and delegate to the pure engine.

| Method | Purpose |
| --- | --- |
| `defineWorkflow(definition)` | register a workflow from config |
| `getWorkflow(key)` | the normalized definition |
| `setContextResolver(fn)` | supply `(subjectId) => data` |
| `open(subjectId, workflowKey, actor, at?)` | start a subject in its initial state |
| `advance(subjectId, toState, actor, at?)` | attempt a governed move; returns `{ ok, reason?, state? }` |
| `emit(subjectId, event, at?)` | append an event (`actor.start` / `actor.stop` / a note / a prompt / anything) |
| `reevaluate(subjectId, at?)` | re-fold eligibility after the subject's data changes |
| `hydrate(subjectId, workflowKey, events)` | rebuild a subject's state and projections by replaying a stored event log (for a server that persists the log instead of holding the engine in memory) |
| `getState(subjectId)` | current states and closed flag |
| `getTimeline(subjectId)` | the full event log |
| `getMetrics(subjectId)` | the metrics rollup |
| `getAvailableExits(subjectId)` | the eligibility set |
| `whatCanAdvance(actor)` | subject ids this actor can move forward |
| `whoCanActOn(subjectId)` | who has agency on this subject now |

The `at` argument is an optional millisecond timestamp; omit it to use the clock. An
actor is `{ ID, Entitlements: [] }`.

### Event types

`opened`, `state.enter`, `state.exit`, `exit.became-available`, `actor.start`,
`actor.stop`, `closed`, plus any custom event you emit. Every event carries an `ID`, an
`At`, a `Type`, and usually an `Actor`.

## Design

The code is split so the interesting part is testable without any framework:

- `source/Workflow-Engine.js` is the pure core. No Fable, no database, no DOM. The clock
  and the address resolver are injected.
- `source/Workflow-Guards.js` is the guard tree evaluator, with dependency extraction
  and structural validation.
- `source/Fable-Workflow.js` is the thin Fable service provider that wires Manyfest in
  as the resolver and exposes the API.

Both the engine and the guards are exported for direct use:

```javascript
const libFableWorkflow = require('fable-workflow');
libFableWorkflow.WorkflowEngine;   // the pure engine class
libFableWorkflow.WorkflowGuards;   // the guard evaluator class
```

## Test and example

```
npm test        # Mocha TDD
npm run example # the narrated editorial + hardware-return walkthrough
```

## License

MIT
