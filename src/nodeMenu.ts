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

  // Renaming happens inline in the header (see startEditingName) rather
  // than as a field in the General section -- the pencil button swaps
  // `title` for this input, focused and pre-filled with the current name.
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "node-menu-name-input";
  nameInput.hidden = true;
  const editNameButton = document.createElement("button");
  editNameButton.type = "button";
  editNameButton.className = "node-menu-edit-name";
  editNameButton.textContent = "✎";
  editNameButton.title = "Rename";
  editNameButton.addEventListener("click", () => startEditingName());

  function startEditingName(): void {
    if (!currentId) return;
    const node = engine.getNode(currentId);
    if (!node) return;
    nameInput.value = node.label;
    title.hidden = true;
    nameInput.hidden = false;
    nameInput.focus();
    nameInput.select();
  }

  // The only place that actually writes the new label -- both Enter and
  // a plain blur (clicking away) reach this via nameInput's own "blur"
  // listener below, so there's exactly one commit path. Escape instead
  // resets nameInput's value back to the node's current label *before*
  // blurring (see its own keydown handler), so the blur-triggered commit
  // here just writes back the unchanged value -- a harmless no-op rather
  // than a separate cancel path to keep in sync with this one.
  function commitNameEdit(): void {
    if (!currentId) return;
    const value = nameInput.value.trim();
    if (value) update({ label: value });
    // update() doesn't re-render the header itself (only the external
    // node list/waveform/patch graph, via onNodeChanged) -- title's own
    // text needs setting explicitly here rather than staying stale from
    // whenever render() last ran.
    title.textContent = engine.getNode(currentId)?.label ?? value;
    title.hidden = false;
    nameInput.hidden = true;
  }

  nameInput.addEventListener("blur", () => commitNameEdit());
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      nameInput.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (currentId) nameInput.value = engine.getNode(currentId)?.label ?? "";
      nameInput.blur();
    }
  });

  // Opens the motion config grid (see openMotionConfigModal) -- the only
  // way left to turn Fixed/Continuous/Trigger/Fire on or off for
  // Rate/Duration/Position, now that motionValueFields no longer renders
  // those checkboxes inline (see its own doc comment).
  const configButton = document.createElement("button");
  configButton.type = "button";
  configButton.className = "node-menu-config-button";
  configButton.textContent = "⚙";
  configButton.title = "Configure controls";
  configButton.addEventListener("click", () => {
    if (!currentId) return;
    const node = engine.getNode(currentId);
    if (!node) return;
    openMotionConfigModal(node);
  });

  const headerSpacer = document.createElement("span");
  headerSpacer.className = "node-menu-header-spacer";

  // Replaces the old "Armed" checkbox + "Arm mode" select (previously two
  // separate General-section fields) with one 3-way control, in the header
  // slot the close button used to occupy -- see armToggleButtons' own
  // wiring below for what each state actually does.
  type ArmToggleState = "off" | "manual" | "loop";
  const armToggle = document.createElement("div");
  armToggle.className = "node-menu-arm-toggle";
  const armToggleButtons: Record<ArmToggleState, HTMLButtonElement> = {
    off: document.createElement("button"),
    manual: document.createElement("button"),
    loop: document.createElement("button"),
  };
  const armToggleLabels: Record<ArmToggleState, string> = {
    off: "Off",
    manual: "Manual",
    loop: "Loop",
  };
  for (const state of Object.keys(armToggleButtons) as ArmToggleState[]) {
    const button = armToggleButtons[state];
    button.type = "button";
    button.className = "node-menu-arm-button";
    button.textContent = armToggleLabels[state];
    button.addEventListener("click", () => setArmToggle(state));
    armToggle.appendChild(button);
  }

  // "off" (armed: false) now genuinely silences the node -- trigger()
  // itself checks armed regardless of armMode, so a manual click or an
  // inbound graph edge does nothing until switched to "manual"/"loop".
  // "manual"/"loop" both set armed: true (armMode alone used to be the
  // only thing that mattered for triggering; now armed gates it too).
  function setArmToggle(state: ArmToggleState): void {
    if (!currentId) return;
    if (state === "off") {
      engine.setArmed(currentId, false);
    } else {
      engine.setArmed(currentId, true);
      engine.updateNode(currentId, { armMode: state });
    }
    updateArmToggleVisual();
    onNodeChanged();
  }

  function updateArmToggleVisual(): void {
    if (!currentId) return;
    const node = engine.getNode(currentId);
    if (!node) return;
    const state: ArmToggleState = engine.isArmed(currentId)
      ? node.armMode
      : "off";
    for (const key of Object.keys(armToggleButtons) as ArmToggleState[]) {
      armToggleButtons[key].classList.toggle("is-active", key === state);
    }
  }

  header.append(
    swatch,
    title,
    nameInput,
    editNameButton,
    configButton,
    headerSpacer,
    armToggle,
  );

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
  const envelopeSection = createSection("Envelope");
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
    envelopeSection.details,
    rateSection.details,
    durationSection.details,
    firingSection.details,
    positionMotionSection.details,
    sweepSection.details,
    lfoSection.details,
    effectsSection.details,
  );

  // Trigger period + its "snap to selection" shortcut live in one row --
  // built once as plain DOM (like the header's own controls) rather than
  // through renderFields, since Field has no compound "range with an
  // inline button" kind and this is the only thing left in "General"
  // needing one. updateTriggerPeriodDisplay keeps it in sync on every
  // render() (node switch, etc.); the input's own "input" listener
  // updates live during a drag without going through render() at all,
  // same as every other range field.
  const triggerPeriodRow = document.createElement("div");
  triggerPeriodRow.className = "panel-field";
  const triggerPeriodLabel = document.createElement("label");
  triggerPeriodLabel.textContent = "Trigger period";
  const triggerPeriodInput = document.createElement("input");
  triggerPeriodInput.type = "range";
  triggerPeriodInput.min = "0.1";
  triggerPeriodInput.max = "10";
  triggerPeriodInput.step = "0.1";
  const triggerPeriodValue = document.createElement("span");
  triggerPeriodValue.className = "field-value";
  const triggerPeriodSnapButton = document.createElement("button");
  triggerPeriodSnapButton.type = "button";
  triggerPeriodSnapButton.className = "node-menu-snap-button";
  triggerPeriodSnapButton.textContent = "=";
  // Sets the trigger period to exactly the selection's own length at
  // 1.0x (see selectionDurationSeconds) -- with duration motion fixed at
  // 1.0 (a fire always plays the range's full length) and rate motion
  // fixed at 1.0 (no speed change), consecutive triggers then land
  // exactly as the previous fire ends: a clean, continuous loop with no
  // gap or overlap. Not a guarantee once either is on curve/wander
  // instead -- a given fire's own actual duration can then differ from
  // this snapped period.
  triggerPeriodSnapButton.title = "Snap trigger period to selection";

  function updateTriggerPeriodDisplay(seconds: number): void {
    triggerPeriodInput.value = String(seconds);
    triggerPeriodValue.textContent = seconds.toFixed(1);
  }

  triggerPeriodInput.addEventListener("input", () => {
    const value = Number(triggerPeriodInput.value);
    triggerPeriodValue.textContent = value.toFixed(1);
    update({ triggerPeriodSeconds: value });
  });
  triggerPeriodSnapButton.addEventListener("click", () => {
    if (!currentId) return;
    const node = engine.getNode(currentId);
    if (!node) return;
    const seconds = selectionDurationSeconds(node);
    if (seconds === null) return;
    update({ triggerPeriodSeconds: seconds });
    updateTriggerPeriodDisplay(seconds);
  });

  triggerPeriodRow.append(
    triggerPeriodLabel,
    triggerPeriodInput,
    triggerPeriodValue,
    triggerPeriodSnapButton,
  );
  generalSection.body.appendChild(triggerPeriodRow);

  // Playback (Direction, Declick fade) merged into General, keeping
  // General's own title -- a separate child container rather than
  // rendering straight into generalSection.body, since renderFields
  // resets its container's innerHTML on every call (see its own doc
  // comment) and would otherwise wipe out triggerPeriodRow above, which
  // is plain DOM appended once rather than a renderFields output.
  const playbackFieldsContainer = document.createElement("div");
  generalSection.body.appendChild(playbackFieldsContainer);

  let zoomableView: ReturnType<typeof createZoomableWaveformRangeView> | null =
    null;
  let waveformNodeId: string | null = null;

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    // Don't close the whole panel out from under an in-progress rename --
    // nameInput's own keydown handler already handles Escape itself
    // (revert + blur) for that case.
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
    close();
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

  /** Which of a node's four MotionConfig-driven controls the config grid
   * modal covers, in display order -- shared between the modal's own
   * grid rows and nothing else (motionValueFields below reads showFire
   * straight off its own call sites, same as it always did). `showFire:
   * false` on rate mirrors the same `showFireOption: false` reasoning
   * render() used to pass directly into motionFields (see its own
   * removed doc comment: a single fire has no burst to sample
   * fireEnabled's curve position from). Envelope's own Fire mode means
   * something different from the other three rows' (a genuine per-
   * sample-varying shape, not a baked scalar -- see SampleNode.
   * envelopeMotion's own doc comment), but the grid checkbox itself
   * behaves identically either way: it's just "is Fire on for this row." */
  const MOTION_ROWS: {
    key: "rateMotion" | "durationMotion" | "positionMotion" | "envelopeMotion";
    label: string;
    showFire: boolean;
  }[] = [
    { key: "envelopeMotion", label: "Envelope", showFire: true },
    { key: "rateMotion", label: "Rate", showFire: false },
    { key: "durationMotion", label: "Duration", showFire: true },
    { key: "positionMotion", label: "Position", showFire: true },
  ];

  /** The grid popup (opened via configButton) -- the only place left that
   * can turn Fixed/Continuous/Trigger/Fire on or off for any of a node's
   * three MotionConfig-driven controls at once, across all three rows in
   * one compact table instead of six always-visible checkboxes buried in
   * each of three separate accordion sections (see motionValueFields'
   * own doc comment for the other half of this split).
   *
   * "Trigger" is a single checkbox per row, not two -- it's checked
   * whenever either duringTriggerEnabled or acrossTriggersEnabled is
   * already true (a derived OR, not a stored flag of its own), and
   * checking it fresh turns on duringTriggerEnabled as a starting point.
   * The actual choice between "during" and "across" is made back in the
   * node menu itself once this is checked, as a mutually-exclusive
   * select rather than two independent checkboxes (see
   * motionValueFields's own doc comment on why) -- same as wander, which
   * never appears in this grid at all, in any form.
   *
   * `useFixed` stays mutually exclusive with the other three columns
   * here, mirroring evaluateMotion's own short-circuit (useFixed ignores
   * everything else) -- checking Fixed clears Continuous/Trigger/Fire,
   * and checking any of those three clears Fixed, so the grid can never
   * show a combination the engine wouldn't actually honor.
   *
   * Edits a local draft, not the live node -- every checkbox here
   * mutates `draft` and re-renders only this table (renderGrid), never
   * calling update()/onNodeChanged(). "Cancel" (or the × / overlay
   * click) discards the draft outright; "OK" is the one point all three
   * drafted configs get committed together via a single update() call. */
  function openMotionConfigModal(node: SampleNode): void {
    const draft: Record<(typeof MOTION_ROWS)[number]["key"], MotionConfig> = {
      envelopeMotion: { ...node.envelopeMotion },
      rateMotion: { ...node.rateMotion },
      durationMotion: { ...node.durationMotion },
      positionMotion: { ...node.positionMotion },
    };

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal motion-config-modal";
    overlay.appendChild(modal);

    function close(): void {
      overlay.remove();
    }
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });

    const header = document.createElement("div");
    header.className = "modal-header";
    const title = document.createElement("span");
    title.className = "modal-title";
    title.textContent = "Configure motion";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "×";
    closeButton.className = "modal-close-button";
    closeButton.addEventListener("click", close);
    header.append(title, closeButton);
    modal.appendChild(header);

    const body = document.createElement("div");
    body.className = "modal-body";
    modal.appendChild(body);

    const table = document.createElement("table");
    table.className = "motion-config-grid";
    body.appendChild(table);

    function makeCell(
      checked: boolean,
      disabled: boolean,
      onChange: (value: boolean) => void,
    ): HTMLTableCellElement {
      const td = document.createElement("td");
      const cellInput = document.createElement("input");
      cellInput.type = "checkbox";
      cellInput.checked = checked;
      cellInput.disabled = disabled;
      cellInput.addEventListener("change", () => onChange(cellInput.checked));
      td.appendChild(cellInput);
      return td;
    }

    function renderGrid(): void {
      table.innerHTML = "";
      const headRow = document.createElement("tr");
      headRow.appendChild(document.createElement("th"));
      for (const columnLabel of ["Fixed", "Continuous", "Trigger", "Fire"]) {
        const th = document.createElement("th");
        th.textContent = columnLabel;
        headRow.appendChild(th);
      }
      table.appendChild(headRow);

      for (const row of MOTION_ROWS) {
        const config = draft[row.key];
        const tr = document.createElement("tr");
        const rowHeader = document.createElement("th");
        rowHeader.textContent = row.label;
        rowHeader.scope = "row";
        tr.appendChild(rowHeader);

        tr.appendChild(
          makeCell(config.useFixed, false, (checked) => {
            config.useFixed = checked;
            if (checked) {
              config.continuousEnabled = false;
              config.duringTriggerEnabled = false;
              config.acrossTriggersEnabled = false;
              config.fireEnabled = false;
            }
            renderGrid();
          }),
        );
        tr.appendChild(
          makeCell(config.continuousEnabled, false, (checked) => {
            config.continuousEnabled = checked;
            if (checked) config.useFixed = false;
            renderGrid();
          }),
        );
        const triggerActive =
          config.duringTriggerEnabled || config.acrossTriggersEnabled;
        tr.appendChild(
          makeCell(triggerActive, false, (checked) => {
            if (checked) {
              config.duringTriggerEnabled = true;
              config.useFixed = false;
            } else {
              config.duringTriggerEnabled = false;
              config.acrossTriggersEnabled = false;
            }
            renderGrid();
          }),
        );
        tr.appendChild(
          makeCell(config.fireEnabled, !row.showFire, (checked) => {
            config.fireEnabled = checked;
            if (checked) config.useFixed = false;
            renderGrid();
          }),
        );

        table.appendChild(tr);
      }
    }
    renderGrid();

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", close);
    const okButton = document.createElement("button");
    okButton.type = "button";
    okButton.textContent = "OK";
    okButton.addEventListener("click", () => {
      update({
        envelopeMotion: draft.envelopeMotion,
        rateMotion: draft.rateMotion,
        durationMotion: draft.durationMotion,
        positionMotion: draft.positionMotion,
      });
      close();
      render();
    });
    actions.append(cancelButton, okButton);
    modal.appendChild(actions);

    document.body.appendChild(overlay);
  }

  /** Builds the *value* fields for one of a node's four MotionConfig-
   * driven controls (position/duration/rate/envelope) -- Fixed/
   * Continuous/Trigger/Fire are turned on or off exclusively through the
   * config grid modal now (see openMotionConfigModal), not here; this
   * only ever renders the controls relevant to whatever ended up
   * enabled, so an unused domain shows nothing at all rather than a
   * checkbox. Each of Trigger/Continuous/Fire renders as its own field
   * group ending in its own curve editor (triggerCurvePoints/
   * continuousCurvePoints/fireCurvePoints) -- checking more than one in
   * the grid shows more than one group here, each independently
   * drawable rather than forced to share a single curve (see
   * MotionConfig's own doc comment). The one exception to "grid-gated"
   * is `useWander`, which stays a checkbox here, ungated and unmoved --
   * it was never part of the grid (see openMotionConfigModal's own doc
   * comment on why: it's orthogonal to Fixed/Continuous/Trigger/Fire, a
   * noise source layered on top of whatever mode a row is already in,
   * not a mode of its own to pick between). */
  function motionFields(
    node: SampleNode,
    key: "positionMotion" | "durationMotion" | "rateMotion" | "envelopeMotion",
    labelPrefix: string,
    options: {
      /** UI slider bounds for min/max (and fixedValue, unless
       * fixedValueMin/fixedValueMax below override it) -- position/
       * duration work in [0,1] range-local fractions, but rateMotion is a
       * wider multiplier range (see createRateMotion) than its own
       * fixedValue slider needs (see fixedValueMin/fixedValueMax). */
      valueMin?: number;
      valueMax?: number;
      valueStep?: number;
      /** Narrower bounds for just the fixedValue slider, when the
       * "typical, sane" range for a constant value is tighter than
       * min/max's own excursion range -- rateMotion's own case (fixed
       * 0.5..2.0, a modest speed range, vs. min/max's wider 0.1..5 for
       * more extreme curve/wander excursions). Defaults to valueMin/
       * valueMax when omitted, same as before this split existed. */
      fixedValueMin?: number;
      fixedValueMax?: number;
    } = {},
  ): Field[] {
    const {
      valueMin = 0,
      valueMax = 1,
      valueStep = 0.01,
      fixedValueMin = valueMin,
      fixedValueMax = valueMax,
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
    // A visibility-affecting toggle (useWander, or during/across once
    // Trigger is active) needs a full refresh, same reason sweep/lfo's
    // own "Target effect" onChange calls render() -- a value-only field
    // (fixedValue, min, max, a curve edit) doesn't change which other
    // fields should be showing, so it skips this.
    const updateMotionAndRender = (patch: Partial<MotionConfig>) => {
      updateMotion(patch);
      render();
    };

    const triggerActive =
      config.duringTriggerEnabled || config.acrossTriggersEnabled;

    // Wander gets its own checkbox in every mode, Fixed included -- see
    // evaluateMotion's own doc comment on why useFixed no longer fully
    // short-circuits it: wander is a noise source layered on whatever
    // mode a control is in, not an alternative to Fixed. Computed once,
    // used by both branches below.
    const wanderFields: Field[] = [
      {
        key: `${key}-useWander`,
        label: `${labelPrefix} use wander`,
        kind: "checkbox",
        value: config.useWander,
        onChange: (value) => updateMotionAndRender({ useWander: value }),
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
              onChange: (value: number) => updateMotion({ wanderSpeed: value }),
            },
          ]
        : []),
    ];

    if (config.useFixed) {
      return [
        {
          key: `${key}-fixedValue`,
          label: `${labelPrefix} fixed value`,
          kind: "range",
          value: config.fixedValue,
          min: fixedValueMin,
          max: fixedValueMax,
          step: valueStep,
          onChange: (value) => updateMotion({ fixedValue: value }),
        },
        ...wanderFields,
      ];
    }

    return [
      {
        key: `${key}-min`,
        label: `${labelPrefix} min`,
        kind: "range",
        value: config.min,
        min: valueMin,
        max: valueMax,
        step: valueStep,
        onChange: (value) => updateMotion({ min: value }),
      },
      {
        key: `${key}-max`,
        label: `${labelPrefix} max`,
        kind: "range",
        value: config.max,
        min: valueMin,
        max: valueMax,
        step: valueStep,
        onChange: (value) => updateMotion({ max: value }),
      },
      // "During" and "across" are mutually exclusive, not independent
      // checkboxes -- exactly one is on whenever Trigger is checked in
      // the grid (never both, never neither: two checkboxes let both get
      // unchecked at once, which hid this whole block with no way back
      // short of reopening the grid). A select enforces that structurally
      // -- it always has a value.
      //
      // Each of Trigger/Continuous/Fire below is its own self-contained
      // field group ending in its own curve editor -- not one shared
      // curve at the bottom covering whichever domains happen to be on.
      // Checking more than one (e.g. Trigger + Fire) still sums their
      // contributions (evaluateMotion's own formula, unchanged), but
      // each now reads its own independently-drawn shape instead of
      // being forced to reuse the same curve for two conceptually
      // different things -- see MotionConfig's own doc comment.
      ...(triggerActive
        ? ([
            {
              key: `${key}-triggerMode`,
              label: `${labelPrefix} trigger mode`,
              kind: "select",
              value: config.acrossTriggersEnabled ? "across" : "during",
              options: [
                { value: "during", label: "During trigger" },
                { value: "across", label: "Across triggers" },
              ],
              indented: true,
              onChange: (value: string) =>
                updateMotionAndRender({
                  duringTriggerEnabled: value === "during",
                  acrossTriggersEnabled: value === "across",
                }),
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
              key: `${key}-triggerCurve`,
              label: `${labelPrefix} trigger curve`,
              kind: "automation" as const,
              points: config.triggerCurvePoints,
              onChange: (points: AutomationPoint[]) =>
                updateMotion({ triggerCurvePoints: points }),
            },
          ] as Field[])
        : []),
      ...(config.continuousEnabled
        ? ([
            {
              key: `${key}-continuousLoopSeconds`,
              label: `${labelPrefix} continuous loop length (s)`,
              kind: "range",
              value: config.continuousLoopSeconds,
              min: 0.5,
              max: 20,
              step: 0.5,
              indented: true,
              onChange: (value: number) =>
                updateMotion({ continuousLoopSeconds: value }),
            },
            {
              key: `${key}-continuousCurve`,
              label: `${labelPrefix} continuous curve`,
              kind: "automation",
              points: config.continuousCurvePoints,
              onChange: (points: AutomationPoint[]) =>
                updateMotion({ continuousCurvePoints: points }),
            },
          ] as Field[])
        : []),
      ...wanderFields,
      ...(config.fireEnabled
        ? [
            {
              key: `${key}-fireCurve`,
              label: `${labelPrefix} fire curve`,
              kind: "automation" as const,
              points: config.fireCurvePoints,
              onChange: (points: AutomationPoint[]) =>
                updateMotion({ fireCurvePoints: points }),
            },
          ]
        : []),
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
        options: [
          { value: "single", label: "Single" },
          { value: "fixedCount", label: "Fixed count" },
          { value: "fullTrigger", label: "Full trigger" },
          { value: "randomTrigger", label: "Random trigger" },
        ],
        onChange: (value) => {
          update({ firingPattern: value as SampleNode["firingPattern"] });
          // The fields below depend on which pattern is selected -- needs
          // a full refresh, same reason sweep/lfo's own "Target effect"
          // onChange calls render().
          render();
        },
      },
      ...(node.firingPattern === "fixedCount"
        ? [
            {
              key: "fireCount",
              label: "Fire count",
              kind: "number" as const,
              value: node.fireCount,
              min: 1,
              max: 64,
              step: 1,
              indented: true,
              onChange: (value: number) => update({ fireCount: value }),
            },
          ]
        : []),
      ...(node.firingPattern !== "single"
        ? [
            {
              key: "intervalMinMs",
              label: "Interval min (ms)",
              kind: "number" as const,
              value: node.intervalMinMs,
              min: 1,
              max: 5000,
              step: 1,
              indented: true,
              onChange: (value: number) => update({ intervalMinMs: value }),
            },
            {
              key: "intervalMaxMs",
              label: "Interval max (ms)",
              kind: "number" as const,
              value: node.intervalMaxMs,
              min: 1,
              max: 5000,
              step: 1,
              indented: true,
              onChange: (value: number) => update({ intervalMaxMs: value }),
            },
          ]
        : []),
      // fixedCount samples this by fire index, fullTrigger by elapsed
      // time within the trigger (see FiringPattern's own doc comment) --
      // randomTrigger draws each gap uniformly at random instead, with
      // no curve to edit.
      ...(node.firingPattern === "fixedCount" ||
      node.firingPattern === "fullTrigger"
        ? [
            {
              key: "intervalCurve",
              label: "Interval curve",
              kind: "automation" as const,
              points: node.intervalCurve,
              onChange: (points: AutomationPoint[]) =>
                update({ intervalCurve: points }),
            },
          ]
        : []),
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
    updateArmToggleVisual();
    updateTriggerPeriodDisplay(node.triggerPeriodSeconds);

    ensureWaveform(node);

    renderFields(playbackFieldsContainer, playbackFields(node));
    renderFields(
      envelopeSection.body,
      motionFields(node, "envelopeMotion", "Envelope", {
        valueMin: 0,
        valueMax: 1.5,
        valueStep: 0.01,
      }),
    );
    renderFields(
      rateSection.body,
      motionFields(node, "rateMotion", "Rate", {
        valueMin: 0.1,
        valueMax: 5,
        valueStep: 0.01,
        fixedValueMin: 0.5,
        fixedValueMax: 2.0,
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
