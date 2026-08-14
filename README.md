# relpmas

Load one local audio file, then define many simultaneous **sample
nodes** against it — independent selections that can be armed, triggered,
and layered with effects and modulation, then patched together so one
node's playback can trigger another. Built on
[bruit-kit](../bruit-kit), a sibling Web Audio component library.

Everything runs in Docker — no Node or other dependencies need to be
installed on your host machine.

## Prerequisites

This project consumes `bruit-kit` as a sibling directory via a `file:`
dependency (`"bruit-kit": "file:../bruit-kit"` in `package.json`), so it
expects the folder layout:

```
ai_coding_experiments/
├── bruit-kit/
└── relpmas/   <- you are here
```

`bruit-kit` is not published to npm — this project's dev container
bind-mounts it (read-only) and imports its **built** `dist/`, not `src/`.
`make up` (below) always rebuilds it first via bruit-kit's own Makefile,
so you don't need a separate manual step.

## Develop

Start the dev container (hot reload) in the background:

```
make up
```

Then open **http://localhost:5176**. (Not 5173: bruit-kit's own dev
container already reserves that port on the host, and other sibling
projects use 5174/5175 for the same reason.) The page shows a "Click to
enable audio" button first (browser autoplay policy), then the app.

Source files are bind-mounted into the container, so edits on your host
are picked up immediately (Vite hot reload) — no rebuild needed for normal
code changes. You only need `make up` again if you change `package.json`
or the `Dockerfile`.

Useful commands (see the `Makefile` for the full list):

```
make logs      # tail dev server logs
make restart   # restart the dev container
make shell     # drop into a shell inside the container
make down      # stop and remove the container
```

## Code quality

```
make lint       # biome check
make format     # biome check --write
make typecheck  # tsc --noEmit
```

All run inside the already-running dev container (`make up` first).

## Deployable image

```
make build-image  # static production build, served by nginx
make run-image     # run it locally at http://localhost:8080
```

## Concepts

Each sample node combines a few independent controls, which recombine
into a wide range of behaviors rather than needing special cases:

- **Arm / trigger / fire.** Arming a node turns it on (`Off` blocks all
  triggering — manual clicks and graph edges alike). `Manual` mode
  treats a click (or an inbound graph edge — see below) as one trigger;
  `Loop` mode generates a trigger periodically while armed. Each trigger
  produces one fire (`single`); a fixed burst of `fireCount` fires spaced
  by a drawn breakpoint curve sampled by fire index (`fixedCount`); or
  fires continuously for the whole trigger period, spaced either by that
  same curve swept across elapsed time instead (`fullTrigger`) or by
  gaps drawn uniformly at random, no curve (`randomTrigger`).
- **Direction, speed, pitch.** A fire plays its range forward, backward,
  or alternating (which flips every fire, so ping-pong emerges across a
  burst). Rate shifts speed and pitch together; an optional pitch-shift
  effect (see below) can decouple them.
- **Range motion.** A node's range has two independently-modulatable
  scalars — position and length — each able to move through the source
  buffer continuously in real time: off, following a drawn curve, a
  random wander, or both at once.
- **Effects and modulation.** Each node has its own effect chain, and a
  trigger can fire off an automation sweep on any effect's own param —
  either directly, or via a re-triggerable LFO for two-stage modulation
  (e.g. an LFO's own rate sweeps up, while that LFO continuously
  modulates a chorus depth).
- **Patch graph.** Every trigger and fire emits start/end events. Drag
  from a node's out-port to another node's in-port to wire one node's
  event into triggering another — chains and cascades from a single
  loaded file.

There's also a master effects bus (every node's output passes through it
before the speakers) and session recording.

No sample-library integration and no save/load persistence yet — load a
file, build a patch, and it lives for the session.
