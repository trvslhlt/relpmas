// A hand-rolled SVG patch-cable graph, specific to the sample-node domain
// (not a bruit-kit widget) -- extends automationEditor.ts's own
// pointer-capture-drag technique (bruit-kit/src/ui/automationEditor.ts) to
// dragging a connection between two node ports instead of a curve handle,
// and now also to dragging a node itself to reposition it. Node boxes
// default to a fixed grid (nodeOrigins/gridOrigin below) but any node the
// user has dragged keeps its own free-form position from then on
// (nodePositions) -- not persisted (resets on reload, same as the rest of
// the patch), just a session-local layout override. Because a node can now
// move continuously mid-gesture, edges connected to it are re-routed
// directly (updateEdgesTouching) rather than going through a full
// `render()` rebuild on every pointermove; `render()` stays the rebuild
// path for genuinely structural changes (nodes/edges added or removed).

import { createKnob } from "bruit-kit/ui";
import type { NodeEventType } from "./sampleNodeEngine";

export interface PatchGraphNode {
  id: string;
  label: string;
  color: string;
}

export interface PatchGraphEdge {
  id: string;
  fromNodeId: string;
  fromEvent: NodeEventType;
  toNodeId: string;
  probability: number;
  /** Per-edge override of the probability knob's own min/max (0-100,
   * i.e. percent) and scale, set via that knob's own right-click menu --
   * see GraphEdge's own doc comment on these two (sampleNodeEngine.ts):
   * setEdges passes the engine's own edge objects straight through, so
   * mutating these here (see openProbabilityPopup) already is mutating
   * the engine's own state, same as `probability` itself already does. */
  probabilityRange?: { min: number; max: number };
  probabilityScale?: "linear" | "log";
}

export interface PatchGraphViewOptions {
  width?: number;
  onAddEdge: (
    fromNodeId: string,
    fromEvent: NodeEventType,
    toNodeId: string,
  ) => void;
  onRemoveEdge: (edgeId: string) => void;
  /** Fired live as the probability popup's own slider moves (see
   * openProbabilityPopup) -- every input event, not just on close, same
   * "live" convention setNodeEffectsLive already uses elsewhere in this
   * app for a value-only drag. */
  onSetProbability: (edgeId: string, probability: number) => void;
  /** Fired on a plain click anywhere on a node's own box/label (not its
   * ports -- those have their own pointerdown-driven drag-to-connect
   * gesture, see startDrag) -- this graph is the one place left a node
   * can be selected now that the separate node-list is gone, so this is
   * also how a host app opens that node's own params menu. Suppressed
   * (see suppressNextClick) when the same pointerdown/up actually
   * dragged the node instead of clicking it. */
  onSelect?: (id: string) => void;
  /** Fired by a click on a node's own bottom-left fire glyph -- a manual,
   * one-node-at-a-time trigger the same shape as main.ts's own toolbar
   * "Trigger (pattern)" button, just reachable without selecting the node
   * first. Deliberately not its own bypass-everything "immediate" fire
   * (that used to be a separate engine.fireNow() call, which skipped
   * arm/trigger and so could never cascade to other nodes over an edge)
   * -- a host app should wire this straight to the same trigger(id) the
   * toolbar button uses. */
  onFireNow?: (id: string) => void;
}

export interface PatchGraphViewHandle {
  setNodes(nodes: PatchGraphNode[]): void;
  setEdges(edges: PatchGraphEdge[]): void;
  /** Briefly highlights a node's box -- wire straight to
   * SampleNodeEngine.onNodeEvent for live feedback as triggers/fires
   * actually happen. */
  flashNode(id: string): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const BOX_WIDTH = 150;
const BOX_HEIGHT = 84;
const GAP = 30;
/** Screen-pixel movement (not svg-viewBox units) before a node's own
 * pointerdown is treated as a drag rather than a stationary click -- see
 * startNodeDrag. */
const DRAG_THRESHOLD_PX = 4;
const OUT_EVENTS: NodeEventType[] = [
  "triggerStart",
  "triggerEnd",
  "periodEnd",
  "fireStart",
  "fireEnd",
];
const OUT_EVENT_LABELS: Record<NodeEventType, string> = {
  triggerStart: "trigS",
  triggerEnd: "trigE",
  periodEnd: "perE",
  fireStart: "fireS",
  fireEnd: "fireE",
};

interface PortPosition {
  x: number;
  y: number;
}

export function createPatchGraphView(
  container: HTMLDivElement,
  options: PatchGraphViewOptions,
): PatchGraphViewHandle {
  const width = options.width ?? 720;

  let nodes: PatchGraphNode[] = [];
  let edges: PatchGraphEdge[] = [];
  const nodeBoxEls = new Map<string, SVGRectElement>();
  const nodeGroupEls = new Map<string, SVGGElement>();
  const edgePathEls = new Map<string, SVGPathElement>();
  /** A "NN%" label at each edge's own midpoint, only actually populated
   * with text below 100% (see refreshEdgeVisual) -- keeps the common
   * always-fires case uncluttered while still surfacing a lowered
   * probability without needing to open its popup. */
  const edgeLabelEls = new Map<string, SVGTextElement>();
  /** Only holds an entry once a node has actually been dragged -- everything
   * else falls back to gridOrigin(index) in refreshOrigins(). */
  const nodePositions = new Map<string, PortPosition>();
  /** Every node's *current* origin (dragged override or grid default),
   * kept in sync by refreshOrigins() on every structural render and
   * updated directly, per-node, during a live drag -- render(), height(),
   * inPortPosition/outPortPosition, and startNodeDrag all read this
   * rather than recomputing a grid position inline, so a dragged node's
   * position is the single source of truth everywhere at once. */
  const nodeOrigins = new Map<string, PortPosition>();
  /** Set true the instant a node-drag gesture actually moves (see
   * startNodeDrag) so the native `click` that a pointerdown/up pair can
   * still produce on the same element doesn't also select the node --
   * consumed (reset false) by the very next click. Only one drag gesture
   * can be in flight at a time (pointer capture), so a single shared flag
   * is enough. */
  let suppressNextClick = false;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "patch-graph-svg");
  // Without this, the default preserveAspectRatio ("xMidYMid meet")
  // letterboxes the viewBox to fit within the actual (wider) rendered
  // box instead of stretching to fill it -- localPoint()'s mouse-to-SVG
  // conversion assumes the bounding box maps 1:1 onto the viewBox, which
  // silently breaks (the drag line tracks faster than the cursor) the
  // moment there's a mismatch between the two aspect ratios. Every other
  // SVG widget in this codebase (zoomableWaveformRangeView.ts,
  // multiMarkerWaveformView.ts, ...) already sets this for the same
  // reason.
  svg.setAttribute("preserveAspectRatio", "none");
  container.innerHTML = "";
  container.appendChild(svg);

  const edgesGroup = document.createElementNS(SVG_NS, "g");
  const nodesGroup = document.createElementNS(SVG_NS, "g");
  const dragGroup = document.createElementNS(SVG_NS, "g");
  svg.append(edgesGroup, nodesGroup, dragGroup);

  function columns(): number {
    return Math.max(1, Math.floor((width + GAP) / (BOX_WIDTH + GAP)));
  }

  function gridOrigin(index: number): PortPosition {
    const cols = columns();
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      x: col * (BOX_WIDTH + GAP) + GAP,
      y: row * (BOX_HEIGHT + GAP) + GAP,
    };
  }

  /** Rebuilds nodeOrigins from the current node list + any dragged
   * overrides, and prunes nodePositions entries for nodes that no longer
   * exist. Grid positions are a pure function of a node's index, so
   * repeated calls (this runs on every setNodes/setEdges, which happens
   * often -- e.g. every node-menu field edit re-syncs the graph) never
   * jitter an undragged node's position between renders. */
  function refreshOrigins(): void {
    for (const id of [...nodePositions.keys()]) {
      if (!nodes.some((n) => n.id === id)) nodePositions.delete(id);
    }
    nodeOrigins.clear();
    nodes.forEach((node, index) => {
      nodeOrigins.set(node.id, nodePositions.get(node.id) ?? gridOrigin(index));
    });
  }

  function inPortPosition(nodeId: string): PortPosition | null {
    const origin = nodeOrigins.get(nodeId);
    if (!origin) return null;
    return { x: origin.x, y: origin.y + BOX_HEIGHT / 2 };
  }

  function outPortPosition(
    nodeId: string,
    event: NodeEventType,
  ): PortPosition | null {
    const origin = nodeOrigins.get(nodeId);
    if (!origin) return null;
    const eventIndex = OUT_EVENTS.indexOf(event);
    const spacing = BOX_HEIGHT / (OUT_EVENTS.length + 1);
    return {
      x: origin.x + BOX_WIDTH,
      y: origin.y + spacing * (eventIndex + 1),
    };
  }

  function bezierPath(a: PortPosition, b: PortPosition): string {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  /** Tallest extent of any node's own origin (dragged or grid), not just a
   * row-count formula -- with free-form positions a dragged node can sit
   * well below where the grid alone would ever place it. For an all-grid
   * layout this produces exactly the same numbers the old row-based
   * formula did. */
  function height(): number {
    let maxY = 0;
    for (const origin of nodeOrigins.values()) {
      maxY = Math.max(maxY, origin.y + BOX_HEIGHT);
    }
    return Math.max(BOX_HEIGHT + GAP * 2, maxY + GAP);
  }

  function resizeCanvas(): void {
    svg.setAttribute("viewBox", `0 0 ${width} ${height()}`);
    svg.setAttribute("height", String(height()));
  }

  function applyNodeTransform(nodeId: string): void {
    const group = nodeGroupEls.get(nodeId);
    const origin = nodeOrigins.get(nodeId);
    if (!group || !origin) return;
    group.setAttribute("transform", `translate(${origin.x}, ${origin.y})`);
  }

  /** Re-routes just the edges touching one node (either end) -- called
   * during a live node drag instead of a full render(), same "don't
   * rebuild the world for a continuous gesture" reasoning startDrag's own
   * temporary line already uses for drawing a new edge. */
  function updateEdgesTouching(nodeId: string): void {
    for (const edge of edges) {
      if (edge.fromNodeId !== nodeId && edge.toNodeId !== nodeId) continue;
      const path = edgePathEls.get(edge.id);
      const label = edgeLabelEls.get(edge.id);
      const from = outPortPosition(edge.fromNodeId, edge.fromEvent);
      const to = inPortPosition(edge.toNodeId);
      if (!from || !to) continue;
      path?.setAttribute("d", bezierPath(from, to));
      label?.setAttribute("x", String((from.x + to.x) / 2));
      label?.setAttribute("y", String((from.y + to.y) / 2 - 6));
    }
  }

  /** Sets an edge's own path opacity (a quiet always-visible cue for a
   * lowered probability, floored so a near-0% edge stays visible/
   * clickable) and its midpoint "NN%" label (blank at 100%, see
   * edgeLabelEls' own doc comment) -- called once per edge on every
   * render() and again live from the probability popup's own slider, so
   * both paths keep the same two elements in sync rather than each
   * having its own drawing logic. */
  function refreshEdgeVisual(edgeId: string): void {
    const edge = edges.find((e) => e.id === edgeId);
    const path = edgePathEls.get(edgeId);
    const label = edgeLabelEls.get(edgeId);
    if (!edge || !path) return;
    path.style.opacity = String(Math.max(0.25, edge.probability));
    if (label) {
      const from = outPortPosition(edge.fromNodeId, edge.fromEvent);
      const to = inPortPosition(edge.toNodeId);
      if (from && to) {
        label.setAttribute("x", String((from.x + to.x) / 2));
        label.setAttribute("y", String((from.y + to.y) / 2 - 6));
      }
      label.textContent =
        edge.probability < 1 ? `${Math.round(edge.probability * 100)}%` : "";
    }
  }

  /** Opens a small popup (reusing the same .modal-* chrome
   * effectsFields.ts's own param-range popup and nodeMenu.ts's motion
   * config grid already use) for editing one edge's own probability, in
   * place of the old "click an edge to remove it" behavior -- removal
   * moves to an explicit button here instead, since a single click is no
   * longer an unambiguous "get rid of this" gesture once there's a value
   * to tune first. */
  function openProbabilityPopup(edge: PatchGraphEdge): void {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });

    const modal = document.createElement("div");
    modal.className = "modal";
    overlay.appendChild(modal);

    const header = document.createElement("div");
    header.className = "modal-header";
    const title = document.createElement("span");
    title.className = "modal-title";
    title.textContent = "Connection probability";
    const closeButton = document.createElement("button");
    closeButton.className = "modal-close-button";
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => close());
    header.append(title, closeButton);
    modal.appendChild(header);

    const body = document.createElement("div");
    body.className = "modal-body";
    const row = document.createElement("div");
    row.className = "panel-field";
    const fieldLabel = document.createElement("label");
    fieldLabel.textContent = "Fires";
    const knobEl = document.createElement("div");
    createKnob(knobEl, {
      value: Math.round(edge.probability * 100),
      min: edge.probabilityRange?.min ?? 0,
      max: edge.probabilityRange?.max ?? 100,
      step: 1,
      scale: edge.probabilityScale ?? "linear",
      initialValue: 100,
      onChange: (value) => {
        const probability = value / 100;
        edge.probability = probability;
        refreshEdgeVisual(edge.id);
        options.onSetProbability(edge.id, probability);
      },
      onBoundsChange: (min, max) => {
        edge.probabilityRange = { min, max };
      },
      onScaleChange: (scale) => {
        edge.probabilityScale = scale;
      },
    });
    row.append(fieldLabel, knobEl);
    body.appendChild(row);
    modal.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const removeButton = document.createElement("button");
    removeButton.textContent = "Remove connection";
    removeButton.addEventListener("click", () => {
      options.onRemoveEdge(edge.id);
      close();
    });
    actions.appendChild(removeButton);
    modal.appendChild(actions);

    function close(): void {
      overlay.remove();
    }

    document.body.appendChild(overlay);
  }

  /** Converts a pointer event's client coordinates into svg-viewBox
   * coordinates, assuming the bounding box maps 1:1 onto the viewBox (see
   * preserveAspectRatio="none" above) -- shared by both drag gestures
   * (drawing a new edge, and now moving a node), rather than each
   * recomputing it locally. */
  function localPoint(event: PointerEvent): PortPosition {
    const bounds = svg.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * width,
      y: ((event.clientY - bounds.top) / bounds.height) * height(),
    };
  }

  function render(): void {
    refreshOrigins();
    resizeCanvas();

    edgesGroup.innerHTML = "";
    edgePathEls.clear();
    edgeLabelEls.clear();
    for (const edge of edges) {
      const from = outPortPosition(edge.fromNodeId, edge.fromEvent);
      const to = inPortPosition(edge.toNodeId);
      if (!from || !to) continue;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", bezierPath(from, to));
      path.setAttribute("class", "patch-graph-edge");
      path.addEventListener("click", () => openProbabilityPopup(edge));
      edgesGroup.appendChild(path);
      edgePathEls.set(edge.id, path);

      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "patch-graph-edge-probability");
      label.setAttribute("text-anchor", "middle");
      edgesGroup.appendChild(label);
      edgeLabelEls.set(edge.id, label);

      refreshEdgeVisual(edge.id);
    }

    nodesGroup.innerHTML = "";
    nodeBoxEls.clear();
    nodeGroupEls.clear();
    for (const node of nodes) {
      const origin = nodeOrigins.get(node.id)!;
      const group = document.createElementNS(SVG_NS, "g");
      group.setAttribute("class", "patch-graph-node-group");
      group.setAttribute("transform", `translate(${origin.x}, ${origin.y})`);
      // A port's own pointerdown (startDrag) can produce a trailing
      // native "click" on the same element if the pointer never moves --
      // that bubbles up to this same listener, so a quick click on a
      // port both starts (and immediately abandons) a drag AND selects
      // the node it's on. Harmless: the node was already the one being
      // dragged from, so selecting it too is never surprising. A node
      // *drag* (see startNodeDrag) sets suppressNextClick instead, since
      // that gesture's whole point is repositioning, not selecting.
      group.addEventListener("click", () => {
        if (suppressNextClick) {
          suppressNextClick = false;
          return;
        }
        options.onSelect?.(node.id);
      });

      // Every child below is positioned in coordinates local to the
      // group's own translate -- moving the node during a drag is then
      // just updating this one transform (applyNodeTransform), not every
      // child's own x/y.
      const box = document.createElementNS(SVG_NS, "rect");
      box.setAttribute("class", "patch-graph-node-box");
      box.setAttribute("x", "0");
      box.setAttribute("y", "0");
      box.setAttribute("width", String(BOX_WIDTH));
      box.setAttribute("height", String(BOX_HEIGHT));
      box.setAttribute("stroke", node.color);
      box.addEventListener("pointerdown", (event) =>
        startNodeDrag(event, node),
      );
      group.appendChild(box);
      nodeBoxEls.set(node.id, box);

      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "patch-graph-node-label");
      label.setAttribute("x", "8");
      label.setAttribute("y", "16");
      label.setAttribute("fill", node.color);
      label.textContent = node.label;
      label.addEventListener("pointerdown", (event) =>
        startNodeDrag(event, node),
      );
      group.appendChild(label);

      // Bottom-left fire glyph -- a circle hit-target (same "circle plus
      // its own listener" shape as the in/out ports below) with a
      // pointer-events:none glyph drawn on top, rather than relying on
      // the text glyph's own tight bounding box as the hit area. Its own
      // click listener stops propagation so it doesn't also bubble up to
      // the group's click (which would select the node and, since
      // onSelect opens the full node menu, pop that open on every fire).
      const fireButton = document.createElementNS(SVG_NS, "circle");
      fireButton.setAttribute("class", "patch-graph-node-fire");
      fireButton.setAttribute("cx", "14");
      fireButton.setAttribute("cy", String(BOX_HEIGHT - 14));
      fireButton.setAttribute("r", "9");
      fireButton.addEventListener("click", (event) => {
        event.stopPropagation();
        options.onFireNow?.(node.id);
      });
      group.appendChild(fireButton);

      const fireGlyph = document.createElementNS(SVG_NS, "text");
      fireGlyph.setAttribute("class", "patch-graph-node-fire-glyph");
      fireGlyph.setAttribute("x", "14");
      fireGlyph.setAttribute("y", String(BOX_HEIGHT - 10));
      fireGlyph.setAttribute("text-anchor", "middle");
      fireGlyph.textContent = "▶";
      group.appendChild(fireGlyph);

      const inPort = document.createElementNS(SVG_NS, "circle");
      inPort.setAttribute("class", "patch-graph-port patch-graph-in-port");
      inPort.setAttribute("cx", "0");
      inPort.setAttribute("cy", String(BOX_HEIGHT / 2));
      inPort.setAttribute("r", "6");
      inPort.dataset.nodeId = node.id;
      group.appendChild(inPort);

      const spacing = BOX_HEIGHT / (OUT_EVENTS.length + 1);
      OUT_EVENTS.forEach((event, eventIndex) => {
        const localY = spacing * (eventIndex + 1);
        const outPort = document.createElementNS(SVG_NS, "circle");
        outPort.setAttribute("class", "patch-graph-port patch-graph-out-port");
        outPort.setAttribute("cx", String(BOX_WIDTH));
        outPort.setAttribute("cy", String(localY));
        outPort.setAttribute("r", "6");
        outPort.setAttribute("fill", node.color);
        outPort.addEventListener("pointerdown", (pointerEvent) => {
          const pos = outPortPosition(node.id, event);
          if (pos) startDrag(pointerEvent, node.id, event, pos);
        });
        group.appendChild(outPort);

        const portLabel = document.createElementNS(SVG_NS, "text");
        portLabel.setAttribute("class", "patch-graph-port-label");
        portLabel.setAttribute("x", String(BOX_WIDTH - 10));
        portLabel.setAttribute("y", String(localY + 3));
        portLabel.setAttribute("text-anchor", "end");
        portLabel.textContent = OUT_EVENT_LABELS[event];
        group.appendChild(portLabel);
      });

      nodesGroup.appendChild(group);
      nodeGroupEls.set(node.id, group);
    }
  }

  /** Repositions a node in response to a pointerdown on its own box/label
   * -- a stationary click still selects it as before (via the group's own
   * click listener); only once the pointer actually moves past
   * DRAG_THRESHOLD_PX does this start writing a new position, so a quick
   * click doesn't jitter the node by a sub-pixel amount first. Mirrors
   * startDrag's own pointer-capture technique below, just moving a node
   * instead of drawing an edge. */
  function startNodeDrag(
    pointerEvent: PointerEvent,
    node: PatchGraphNode,
  ): void {
    const target = pointerEvent.currentTarget as SVGGraphicsElement;
    target.setPointerCapture(pointerEvent.pointerId);

    const startClientX = pointerEvent.clientX;
    const startClientY = pointerEvent.clientY;
    const startPoint = localPoint(pointerEvent);
    const startOrigin = nodeOrigins.get(node.id) ?? { x: 0, y: 0 };
    // Preserves wherever within the box the user actually grabbed it,
    // rather than snapping the box's own top-left corner under the
    // cursor the instant the drag starts.
    const grabDx = startPoint.x - startOrigin.x;
    const grabDy = startPoint.y - startOrigin.y;
    let moved = false;

    function onMove(event: PointerEvent): void {
      if (
        !moved &&
        Math.hypot(event.clientX - startClientX, event.clientY - startClientY) <
          DRAG_THRESHOLD_PX
      ) {
        return;
      }
      moved = true;
      const point = localPoint(event);
      const newX = Math.min(
        Math.max(0, point.x - grabDx),
        Math.max(0, width - BOX_WIDTH),
      );
      const newY = Math.max(0, point.y - grabDy);
      nodePositions.set(node.id, { x: newX, y: newY });
      nodeOrigins.set(node.id, { x: newX, y: newY });
      applyNodeTransform(node.id);
      updateEdgesTouching(node.id);
      resizeCanvas();
    }

    function onUp(): void {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      if (moved) suppressNextClick = true;
    }

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  function startDrag(
    pointerEvent: PointerEvent,
    fromNodeId: string,
    fromEvent: NodeEventType,
    from: PortPosition,
  ): void {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", "patch-graph-drag-line");
    line.setAttribute("x1", String(from.x));
    line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(from.x));
    line.setAttribute("y2", String(from.y));
    dragGroup.appendChild(line);

    const target = pointerEvent.currentTarget as SVGCircleElement;
    target.setPointerCapture(pointerEvent.pointerId);

    function onMove(event: PointerEvent): void {
      const point = localPoint(event);
      line.setAttribute("x2", String(point.x));
      line.setAttribute("y2", String(point.y));
    }

    function onUp(event: PointerEvent): void {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      dragGroup.removeChild(line);

      const dropTarget = document
        .elementsFromPoint(event.clientX, event.clientY)
        .find(
          (el): el is SVGCircleElement =>
            el instanceof SVGCircleElement &&
            el.classList.contains("patch-graph-in-port"),
        );
      const toNodeId = dropTarget?.dataset.nodeId;
      if (toNodeId) options.onAddEdge(fromNodeId, fromEvent, toNodeId);
    }

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  return {
    setNodes(newNodes) {
      nodes = newNodes;
      render();
    },
    setEdges(newEdges) {
      edges = newEdges;
      render();
    },
    flashNode(id) {
      const box = nodeBoxEls.get(id);
      if (!box) return;
      box.classList.add("patch-graph-node-flash");
      setTimeout(() => box.classList.remove("patch-graph-node-flash"), 220);
    },
  };
}
