// The right-click params panel for one node -- everything that used to be
// an always-visible section (arm/trigger/fire config, range motion,
// modulation route, effect chain) lives here instead, docked as a
// persistent sidebar (see index.html's #node-menu-panel) rather than a
// small popup, opened on demand by right-clicking a node. A single
// instance is reused across every node; opening a different node's menu
// re-renders this same panel's contents rather than creating a new one.
//
// The header/waveform/params/effects sections are built once and kept as
// persistent DOM children of the panel -- render() updates their content
// in place (mostly via renderFields, which already does its own
// container.innerHTML reset internally) rather than tearing down the
// whole panel every time, specifically so the embedded zoomable waveform
// (see ensureWaveform) keeps its zoom/pan state across an unrelated
// re-render (e.g. adding an effect), rather than snapping back to fully
// zoomed out every time.

import { type AutomationPoint, getEffectParamOptions } from "bruit-kit/audio";
import {
  EFFECT_TABLE,
  type Field,
  type WaveformRange,
  createZoomableWaveformRangeView,
  effectsFields,
  renderFields,
} from "bruit-kit/ui";
import {
  type LfoRoute,
  type MotionConfig,
  NO_TARGET_EFFECT,
  type SampleNode,
  type SweepRoute,
  wrappedLength,
} from "./sampleNode";
import type { SampleNodeEngine } from "./sampleNodeEngine";

/** Options for a "target effect" <select>, from the node's *current*
 * effects list -- never free-typed (see targetParamOptions' own doc for
 * why this matters). Always includes a "None" entry (NO_TARGET_EFFECT). */
function targetEffectOptions(
  node: SampleNode,
): { value: string; label: string }[] {
  return [
    { value: String(NO_TARGET_EFFECT), label: "None" },
    ...node.effects.map((spec, i) => ({
      value: String(i),
      label: `${i}: ${EFFECT_TABLE.find((e) => e.type === spec.type)?.label ?? spec.type}`,
    })),
  ];
}

/** Options for a "target param" <select>, populated from bruit-kit's
 * getEffectParamOptions for whichever effect targetEffectIndex currently
 * resolves to -- this is the whole point of the split from the old
 * free-text "target param" field: the user picks from what that specific
 * effect actually exposes, never types a property name from memory.
 * Empty (not undefined) when the index doesn't resolve or that effect
 * type exposes nothing modulatable (e.g. "gain", "pitchShift"). */
function targetParamOptions(
  node: SampleNode,
  targetEffectIndex: number,
): { value: string; label: string }[] {
  const spec = node.effects[targetEffectIndex];
  if (!spec) return [];
  return getEffectParamOptions(spec.type).map((opt) => ({
    value: opt.key,
    label: opt.label,
  }));
}

export interface NodeMenuHandle {
  open(id: string): void;
  close(): void;
  isOpenFor(id: string): boolean;
  /** Pushes a live (motion-drifted) start position onto the embedded
   * waveform's marker, if this menu is currently open for `id` -- a no-op
   * otherwise, so a caller can call this unconditionally from its own
   * polling loop without checking isOpenFor itself first. */
  updateLiveMarker(id: string, position: number | null): void;
  /** Pushes a newly-loaded sample onto the embedded waveform, if the menu
   * is currently showing one -- otherwise a no-op, since ensureWaveform
   * already pulls the current buffer from the engine whenever it next
   * builds a view for a node. Needed because loading a new file doesn't
   * change which node is open, so ensureWaveform's "same node, skip
   * rebuild" path would otherwise never see the new buffer. */
  setBuffer(buffer: AudioBuffer): void;
  /** Pushes an externally-changed range (e.g. dragged on the main overview
   * waveform, not through this menu's own embedded editor) onto the
   * embedded waveform, if this menu is currently open for `id` -- a no-op
   * otherwise, same unconditionally-callable pattern as updateLiveMarker.
   * Cheap (setRange only, no full field re-render), safe to call on every
   * pointermove of a drag. */
  syncRange(id: string, range: WaveformRange): void;
}

export function createNodeMenu(
  engine: SampleNodeEngine,
  panelEl: HTMLElement,
  onNodeChanged: () => void,
): NodeMenuHandle {
  let currentId: string | null = null;

  const header = document.createElement("div");
  header.className = "node-menu-header";
  const swatch = document.createElement("span");
  swatch.className = "node-menu-swatch";
  const title = document.createElement("span");
  title.className = "node-menu-title";
  const closeButton = document.createElement("button");
  closeButton.textContent = "×";
  closeButton.className = "node-menu-close";
  closeButton.addEventListener("click", () => close());
  header.append(swatch, title, closeButton);

  const waveformContainer = document.createElement("div");
  waveformContainer.className = "node-menu-waveform";

  // The node's *current* range length at 1.0x, deliberately not
  // rate-adjusted (see selectionDurationSeconds) -- what "Snap to
  // selection" below sets triggerPeriodSeconds to. A persistent element
  // updated directly rather than a field in generalFields, so a drag on
  // the embedded waveform can refresh it without paying a full panel
  // re-render per pointermove (see ensureWaveform's onChange).
  const selectionDurationEl = document.createElement("div");
  selectionDurationEl.className = "node-menu-selection-duration";

  /** One collapsible section (a native <details>/<summary>), built once so
   * its open/closed state survives re-renders -- render() only ever
   * touches `body`'s contents via renderFields, never recreates the
   * <details> element itself. */
  function createSection(title: string): {
    details: HTMLDetailsElement;
    body: HTMLDivElement;
  } {
    const details = document.createElement("details");
    details.className = "node-menu-section";
    details.open = true;
    const summary = document.createElement("summary");
    summary.className = "node-menu-section-summary";
    summary.textContent = title;
    const body = document.createElement("div");
    body.className = "node-menu-section-body";
    details.append(summary, body);
    return { details, body };
  }

  const generalSection = createSection("General");
  const playbackSection = createSection("Playback");
  const rateSection = createSection("Rate");
  const durationSection = createSection("Duration");
  const firingSection = createSection("Firing pattern");
  const positionMotionSection = createSection("Position motion");
  const sweepSection = createSection("Sweep");
  const lfoSection = createSection("LFO");
  const effectsSection = createSection("Effects");

  panelEl.append(
    header,
    waveformContainer,
    selectionDurationEl,
    generalSection.details,
    playbackSection.details,
    rateSection.details,
    durationSection.details,
    firingSection.details,
    positionMotionSection.details,
    sweepSection.details,
    lfoSection.details,
    effectsSection.details,
  );

  let zoomableView: ReturnType<typeof createZoomableWaveformRangeView> | null =
    null;
  let waveformNodeId: string | null = null;

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") close();
  }

  function close(): void {
    panelEl.hidden = true;
    currentId = null;
    document.removeEventListener("keydown", handleKeydown, true);
  }

  function update(patch: Partial<SampleNode>): void {
    if (!currentId) return;
    engine.updateNode(currentId, patch);
    onNodeChanged();
  }

  /** How long the node's *current* range is at 1.0x -- deliberately not
   * rate-adjusted. rateMotion's curve mode is a per-fire value (sampled
   * fresh per fire in a burst, see SampleNodeEngine.trigger()'s own
   * rateMultiplier computation), so factoring it into this single preview
   * number produced confusing, cascading behavior once rate curves were
   * in play (which fire's rate would even apply?) -- this now stays a
   * plain, predictable "how much of the buffer is selected" readout, and
   * "Snap to selection" (below) sets triggerPeriodSeconds to exactly that
   * unadjusted length. null before a sample is loaded. */
  function selectionDurationSeconds(node: SampleNode): number | null {
    const buffer = engine.getBuffer();
    if (!buffer) return null;
    return wrappedLength(node.range.start, node.range.end) * buffer.duration;
  }

  function updateSelectionDurationDisplay(node: SampleNode): void {
    const seconds = selectionDurationSeconds(node);
    selectionDurationEl.textContent =
      seconds === null ? "Selection: --" : `Selection: ${seconds.toFixed(3)}s`;
  }

  /** Builds the fields for one of a node's three MotionConfig-driven
   * controls (position/duration/rate) -- a checklist, not a single-select
   * mode, since more than one can be checked at once and their curve
   * samplings sum (see MotionConfig's own doc comment). Only the fields
   * relevant to the config's *current* state render at all: fixedValue
   * alone while useFixed is on; the checklist (plus min/max) once it's
   * off; each domain's own extra field (continuous's loop length) only
   * once that domain is checked; the shared curve editor only once at
   * least one curve domain is checked -- so an unused control stays a
   * single checkbox rather than a wall of dead fields (this was the
   * whole point of moving off a single mode <select>: nothing has to be
   * visible all the time). */
  function motionFields(
    node: SampleNode,
    key: "positionMotion" | "durationMotion" | "rateMotion",
    labelPrefix: string,
    options: {
      /** UI slider bounds for fixedValue/min/max -- position/duration
       * work in [0,1] range-local fractions, but rateMotion is a
       * multiplier (0.1..5 by default, see createRateMotion). */
      valueMin?: number;
      valueMax?: number;
      valueStep?: number;
      /** Hides the "per fire" checkbox -- rateMotion's own case: for a
       * single fire (the common/default firing pattern), fireEnabled has
       * no burst to sample a position from and always freezes at the
       * curve's own start (see evaluateMotion's own doc comment), which
       * reads as "the curve does nothing" for anyone not specifically
       * using curveSpaced. What's actually wanted there -- continuous
       * pitch movement *during* a single fire's own playback -- isn't
       * built yet (see TODO.md); hiding this in the meantime rather than
       * leaving a checkbox that looks broken. Still fully enabled for
       * position/duration, and still honored by the engine even for rate
       * if a curveSpaced node's config already has it set from before
       * this was hidden. */
      showFireOption?: boolean;
    } = {},
  ): Field[] {
    const {
      valueMin = 0,
      valueMax = 1,
      valueStep = 0.01,
      showFireOption = true,
    } = options;
    const config = node[key];
    // Reads the freshest config at call time, not the `config` captured
    // above -- these fields' onChange handlers all survive from the last
    // render() with no re-render in between (update() never re-renders;
    // only effectsFields' own onChange, and the explicit render() calls
    // below, do), so spreading the stale closured `config` here would
    // silently revert whatever an earlier field's own change in this
    // same visit had just set.
    const updateMotion = (patch: Partial<MotionConfig>) => {
      const current = engine.getNode(node.id)?.[key] ?? config;
      update({ [key]: { ...current, ...patch } });
    };
    // A visibility-affecting toggle (useFixed, or any of the three domain
    // checkboxes) needs a full refresh, same reason sweep/lfo's own
    // "Target effect" onChange calls render() -- a value-only field
    // (fixedValue, min, max, a curve edit) doesn't change which other
    // fields should be showing, so it skips this.
    const updateMotionAndRender = (patch: Partial<MotionConfig>) => {
      updateMotion(patch);
      render();
    };

    const anyCurveDomainEnabled =
      config.duringTriggerEnabled ||
      config.fireEnabled ||
      config.acrossTriggersEnabled ||
      config.continuousEnabled;

    return [
      {
        key: `${key}-useFixed`,
        label: `${labelPrefix} use fixed value`,
        kind: "checkbox",
        value: config.useFixed,
        onChange: (value) => updateMotionAndRender({ useFixed: value }),
      },
      ...(config.useFixed
        ? [
            {
              key: `${key}-fixedValue`,
              label: `${labelPrefix} fixed value`,
              kind: "range" as const,
              value: config.fixedValue,
              min: valueMin,
              max: valueMax,
              step: valueStep,
              indented: true,
              onChange: (value: number) => updateMotion({ fixedValue: value }),
            },
          ]
        : [
            {
              key: `${key}-min`,
              label: `${labelPrefix} min`,
              kind: "range" as const,
              value: config.min,
              min: valueMin,
              max: valueMax,
              step: valueStep,
              indented: true,
              onChange: (value: number) => updateMotion({ min: value }),
            },
            {
              key: `${key}-max`,
              label: `${labelPrefix} max`,
              kind: "range" as const,
              value: config.max,
              min: valueMin,
              max: valueMax,
              step: valueStep,
              indented: true,
              onChange: (value: number) => updateMotion({ max: value }),
            },
            {
              key: `${key}-duringTriggerEnabled`,
              label: `${labelPrefix} during trigger`,
              kind: "checkbox" as const,
              value: config.duringTriggerEnabled,
              onChange: (value: boolean) =>
                updateMotionAndRender({ duringTriggerEnabled: value }),
            },
            ...(showFireOption
              ? [
                  {
                    key: `${key}-fireEnabled`,
                    label: `${labelPrefix} per fire`,
                    kind: "checkbox" as const,
                    value: config.fireEnabled,
                    onChange: (value: boolean) =>
                      updateMotionAndRender({ fireEnabled: value }),
                  },
                ]
              : []),
            {
              key: `${key}-acrossTriggersEnabled`,
              label: `${labelPrefix} across triggers`,
              kind: "checkbox" as const,
              value: config.acrossTriggersEnabled,
              onChange: (value: boolean) =>
                updateMotionAndRender({ acrossTriggersEnabled: value }),
            },
            ...(config.acrossTriggersEnabled
              ? [
                  {
                    key: `${key}-triggerCycleLength`,
                    label: `${labelPrefix} trigger cycle length`,
                    kind: "number" as const,
                    value: config.triggerCycleLength,
                    min: 1,
                    max: 64,
                    step: 1,
                    indented: true,
                    onChange: (value: number) =>
                      updateMotion({ triggerCycleLength: value }),
                  },
                ]
              : []),
            {
              key: `${key}-continuousEnabled`,
              label: `${labelPrefix} continuously`,
              kind: "checkbox" as const,
              value: config.continuousEnabled,
              onChange: (value: boolean) =>
                updateMotionAndRender({ continuousEnabled: value }),
            },
            ...(config.continuousEnabled
              ? [
                  {
                    key: `${key}-continuousLoopSeconds`,
                    label: `${labelPrefix} continuous loop length (s)`,
                    kind: "range" as const,
                    value: config.continuousLoopSeconds,
                    min: 0.5,
                    max: 20,
                    step: 0.5,
                    indented: true,
                    onChange: (value: number) =>
                      updateMotion({ continuousLoopSeconds: value }),
                  },
                ]
              : []),
            {
              key: `${key}-useWander`,
              label: `${labelPrefix} use wander`,
              kind: "checkbox" as const,
              value: config.useWander,
              onChange: (value: boolean) =>
                updateMotionAndRender({ useWander: value }),
            },
            ...(config.useWander
              ? [
                  {
                    key: `${key}-wanderSpeed`,
                    label: `${labelPrefix} wander speed`,
                    kind: "range" as const,
                    value: config.wanderSpeed,
                    min: 0,
                    max: 1,
                    step: 0.01,
                    indented: true,
                    onChange: (value: number) =>
                      updateMotion({ wanderSpeed: value }),
                  },
                ]
              : []),
            ...(anyCurveDomainEnabled
              ? [
                  {
                    key: `${key}-curve`,
                    label: `${labelPrefix} curve`,
                    kind: "automation" as const,
                    points: config.curvePoints,
                    onChange: (points: AutomationPoint[]) =>
                      updateMotion({ curvePoints: points }),
                  },
                ]
              : []),
          ]),
    ];
  }

  function sweepRouteFields(node: SampleNode): Field[] {
    const route = node.sweepRoute;
    // Same stale-closure hazard as motionFields' updateMotion -- reads the
    // freshest route at call time rather than the one captured above.
    // Goes through engine.setNodeSweepRoute (not the generic update())
    // since that's also where a disabled/retargeted route's pending
    // automation gets cancelled -- see its own doc comment.
    const updateRoute = (patch: Partial<SweepRoute>) => {
      const current = engine.getNode(node.id)?.sweepRoute ?? route;
      engine.setNodeSweepRoute(node.id, { ...current, ...patch });
      onNodeChanged();
    };
    const paramOptions = targetParamOptions(node, route.targetEffectIndex);
    return [
      {
        key: "sweep-enabled",
        label: "Sweep enabled",
        kind: "checkbox",
        value: route.enabled,
        onChange: (value) => updateRoute({ enabled: value }),
      },
      {
        key: "sweep-effect",
        label: "Target effect",
        kind: "select",
        value: String(route.targetEffectIndex),
        options: targetEffectOptions(node),
        indented: true,
        onChange: (value) => {
          const targetEffectIndex = Number(value);
          const options = targetParamOptions(node, targetEffectIndex);
          updateRoute({
            targetEffectIndex,
            targetParamKey: options[0]?.value ?? "",
          });
          // The param dropdown below's options depend on this selection --
          // needs a full refresh to show the newly-targeted effect's own
          // params instead of the previous effect's.
          render();
        },
      },
      {
        key: "sweep-param",
        label: "Target param",
        kind: "select",
        value: route.targetParamKey,
        options:
          paramOptions.length > 0
            ? paramOptions
            : [{ value: "", label: "(no params)" }],
        indented: true,
        onChange: (value) => updateRoute({ targetParamKey: value }),
      },
      {
        key: "sweep-value-min",
        label: "Value min",
        kind: "number",
        value: route.valueMin,
        step: 1,
        indented: true,
        onChange: (value) => updateRoute({ valueMin: value }),
      },
      {
        key: "sweep-value-max",
        label: "Value max",
        kind: "number",
        value: route.valueMax,
        step: 1,
        indented: true,
        onChange: (value) => updateRoute({ valueMax: value }),
      },
      {
        key: "sweep-curve",
        label: "Sweep curve",
        kind: "automation",
        points: route.curvePoints,
        onChange: (points) => updateRoute({ curvePoints: points }),
      },
    ];
  }

  function lfoRouteFields(node: SampleNode): Field[] {
    const route = node.lfoRoute;
    const updateRoute = (patch: Partial<LfoRoute>) => {
      const current = engine.getNode(node.id)?.lfoRoute ?? route;
      engine.setNodeLfoRoute(node.id, { ...current, ...patch });
      onNodeChanged();
    };
    const paramOptions = targetParamOptions(node, route.targetEffectIndex);
    return [
      {
        key: "lfo-enabled",
        label: "LFO enabled",
        kind: "checkbox",
        value: route.enabled,
        onChange: (value) => updateRoute({ enabled: value }),
      },
      {
        key: "lfo-effect",
        label: "Target effect",
        kind: "select",
        value: String(route.targetEffectIndex),
        options: targetEffectOptions(node),
        indented: true,
        onChange: (value) => {
          const targetEffectIndex = Number(value);
          const options = targetParamOptions(node, targetEffectIndex);
          updateRoute({
            targetEffectIndex,
            targetParamKey: options[0]?.value ?? "",
          });
          render();
        },
      },
      {
        key: "lfo-param",
        label: "Target param",
        kind: "select",
        value: route.targetParamKey,
        options:
          paramOptions.length > 0
            ? paramOptions
            : [{ value: "", label: "(no params)" }],
        indented: true,
        onChange: (value) => updateRoute({ targetParamKey: value }),
      },
      {
        key: "lfo-rate-min",
        label: "Rate min (Hz)",
        kind: "number",
        value: route.valueMin,
        step: 1,
        indented: true,
        onChange: (value) => updateRoute({ valueMin: value }),
      },
      {
        key: "lfo-rate-max",
        label: "Rate max (Hz)",
        kind: "number",
        value: route.valueMax,
        step: 1,
        indented: true,
        onChange: (value) => updateRoute({ valueMax: value }),
      },
      {
        key: "lfo-rate-curve",
        label: "Rate curve",
        kind: "automation",
        points: route.curvePoints,
        onChange: (points) => updateRoute({ curvePoints: points }),
      },
      {
        key: "lfo-depth-min",
        label: "Depth min",
        kind: "number",
        value: route.depthMin,
        step: 1,
        indented: true,
        onChange: (value) => updateRoute({ depthMin: value }),
      },
      {
        key: "lfo-depth-max",
        label: "Depth max",
        kind: "number",
        value: route.depthMax,
        step: 1,
        indented: true,
        onChange: (value) => updateRoute({ depthMax: value }),
      },
      {
        key: "lfo-depth-curve",
        label: "Depth curve",
        kind: "automation",
        points: route.depthCurvePoints,
        onChange: (points) => updateRoute({ depthCurvePoints: points }),
      },
    ];
  }

  function generalFields(node: SampleNode): Field[] {
    return [
      {
        key: "label",
        label: "Name",
        kind: "text",
        value: node.label,
        onChange: (value) => update({ label: value }),
      },
      {
        key: "armed",
        label: "Armed",
        kind: "checkbox",
        value: engine.isArmed(node.id),
        onChange: (value) => {
          engine.setArmed(node.id, value);
          onNodeChanged();
        },
      },
      {
        key: "armMode",
        label: "Arm mode",
        kind: "select",
        value: node.armMode,
        options: ["manual", "loop"],
        onChange: (value) =>
          update({ armMode: value as SampleNode["armMode"] }),
      },
      {
        key: "triggerPeriodSeconds",
        label: "Trigger period (s)",
        kind: "range",
        value: node.triggerPeriodSeconds,
        min: 0.1,
        max: 10,
        step: 0.1,
        indented: true,
        onChange: (value) => update({ triggerPeriodSeconds: value }),
      },
      {
        key: "triggerPeriodSnap",
        label: "Snap to selection",
        kind: "button",
        // Sets the trigger period to exactly the selection's own length at
        // 1.0x (see selectionDurationSeconds) -- with duration motion
        // fixed at 1.0 (a fire always plays the range's full length) and
        // rate motion fixed at 1.0 (no speed change), consecutive
        // triggers then land exactly as the previous fire ends: a clean,
        // continuous loop with no gap or overlap. Not a guarantee once
        // either is on curve/wander instead -- a given fire's own actual
        // duration can then differ from this snapped period.
        onClick: () => {
          const seconds = selectionDurationSeconds(node);
          if (seconds === null) return;
          update({ triggerPeriodSeconds: seconds });
          render();
        },
      },
    ];
  }

  function playbackFields(node: SampleNode): Field[] {
    return [
      {
        key: "direction",
        label: "Direction",
        kind: "select",
        value: node.direction,
        options: ["forward", "backward", "alternating"],
        onChange: (value) =>
          update({ direction: value as SampleNode["direction"] }),
      },
      {
        key: "fadeMs",
        label: "Declick fade (ms)",
        kind: "range",
        value: node.fadeMs,
        min: 0,
        max: 50,
        step: 1,
        onChange: (value) => update({ fadeMs: value }),
      },
    ];
  }

  function firingFields(node: SampleNode): Field[] {
    return [
      {
        key: "firingPattern",
        label: "Firing pattern",
        kind: "select",
        value: node.firingPattern,
        options: ["single", "curveSpaced"],
        onChange: (value) =>
          update({ firingPattern: value as SampleNode["firingPattern"] }),
      },
      {
        key: "fireCount",
        label: "Fire count",
        kind: "number",
        value: node.fireCount,
        min: 1,
        max: 64,
        step: 1,
        indented: true,
        onChange: (value) => update({ fireCount: value }),
      },
      {
        key: "intervalMinMs",
        label: "Interval min (ms)",
        kind: "number",
        value: node.intervalMinMs,
        min: 1,
        max: 5000,
        step: 1,
        indented: true,
        onChange: (value) => update({ intervalMinMs: value }),
      },
      {
        key: "intervalMaxMs",
        label: "Interval max (ms)",
        kind: "number",
        value: node.intervalMaxMs,
        min: 1,
        max: 5000,
        step: 1,
        indented: true,
        onChange: (value) => update({ intervalMaxMs: value }),
      },
      {
        key: "intervalCurve",
        label: "Interval curve (per fire)",
        kind: "automation",
        points: node.intervalCurve,
        onChange: (points) => update({ intervalCurve: points }),
      },
    ];
  }

  /** (Re)creates the embedded zoomable range view only when switching to a
   * different node than whatever it was last built for -- re-rendering
   * the rest of the panel (e.g. after an effect add/remove) must not reset
   * an in-progress zoom/pan on the same node's own waveform. */
  function ensureWaveform(node: SampleNode): void {
    if (waveformNodeId === node.id && zoomableView) {
      // Still the same node -- just make sure the range reflects any
      // external change (e.g. dragged on the main overview waveform)
      // without touching zoom/pan.
      zoomableView.setRange(node.range);
      updateSelectionDurationDisplay(node);
      return;
    }
    zoomableView = createZoomableWaveformRangeView(waveformContainer, {
      initialRange: node.range,
      onChange: (range) => {
        update({ range });
        updateSelectionDurationDisplay(node);
      },
    });
    const buffer = engine.getBuffer();
    if (buffer) zoomableView.setBuffer(buffer);
    waveformNodeId = node.id;
    updateSelectionDurationDisplay(node);
  }

  function render(): void {
    if (!currentId) return;
    const node = engine.getNode(currentId);
    if (!node) {
      close();
      return;
    }

    swatch.style.background = node.color;
    title.textContent = node.label;

    ensureWaveform(node);

    renderFields(generalSection.body, generalFields(node));
    renderFields(playbackSection.body, playbackFields(node));
    renderFields(
      rateSection.body,
      motionFields(node, "rateMotion", "Rate", {
        valueMin: 0.1,
        valueMax: 5,
        valueStep: 0.01,
        showFireOption: false,
      }),
    );
    renderFields(
      durationSection.body,
      motionFields(node, "durationMotion", "Duration"),
    );
    renderFields(firingSection.body, firingFields(node));
    renderFields(
      positionMotionSection.body,
      motionFields(node, "positionMotion", "Position"),
    );
    renderFields(sweepSection.body, sweepRouteFields(node));
    renderFields(lfoSection.body, lfoRouteFields(node));
    renderFields(
      effectsSection.body,
      effectsFields(
        () => engine.getNode(node.id)?.effects ?? [],
        (next) => {
          engine.setNodeEffects(node.id, next);
          render();
        },
        (next) => engine.setNodeEffectsLive(node.id, next),
      ),
    );
  }

  return {
    open(id) {
      currentId = id;
      panelEl.hidden = false;
      document.addEventListener("keydown", handleKeydown, true);
      render();
    },
    close,
    isOpenFor(id) {
      return currentId === id && !panelEl.hidden;
    },
    updateLiveMarker(id, position) {
      if (id === currentId) zoomableView?.setLiveMarker(position);
    },
    setBuffer(buffer) {
      zoomableView?.setBuffer(buffer);
    },
    syncRange(id, range) {
      if (id !== currentId) return;
      zoomableView?.setRange(range);
      const node = engine.getNode(id);
      if (node) updateSelectionDurationDisplay(node);
    },
  };
}
