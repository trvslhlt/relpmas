// A hand-rolled SVG patch-cable graph, specific to the sample-node domain
// (not a bruit-kit widget) -- extends automationEditor.ts's own
// pointer-capture-drag technique (bruit-kit/src/ui/automationEditor.ts) to
// dragging a connection between two node ports instead of a curve handle.
// Node boxes sit in a fixed grid (no user repositioning in this pass --
// see PLAN's out-of-scope list) so, unlike multiRangeWaveformView.ts, a
// full rebuild on every structural change is safe: the only continuous
// drag gesture here is "draw a new edge," which never touches node
// position and manages its own temporary line directly rather than going
// through a data model rebuild mid-gesture.

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
}

export interface PatchGraphViewOptions {
  width?: number;
  onAddEdge: (
    fromNodeId: string,
    fromEvent: NodeEventType,
    toNodeId: string,
  ) => void;
  onRemoveEdge: (edgeId: string) => void;
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
const OUT_EVENTS: NodeEventType[] = [
  "triggerStart",
  "triggerEnd",
  "fireStart",
  "fireEnd",
];
const OUT_EVENT_LABELS: Record<NodeEventType, string> = {
  triggerStart: "trigS",
  triggerEnd: "trigE",
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

  function nodeOrigin(index: number): { x: number; y: number } {
    const cols = columns();
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      x: col * (BOX_WIDTH + GAP) + GAP,
      y: row * (BOX_HEIGHT + GAP) + GAP,
    };
  }

  function inPortPosition(nodeId: string): PortPosition | null {
    const index = nodes.findIndex((n) => n.id === nodeId);
    if (index === -1) return null;
    const origin = nodeOrigin(index);
    return { x: origin.x, y: origin.y + BOX_HEIGHT / 2 };
  }

  function outPortPosition(
    nodeId: string,
    event: NodeEventType,
  ): PortPosition | null {
    const index = nodes.findIndex((n) => n.id === nodeId);
    if (index === -1) return null;
    const origin = nodeOrigin(index);
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

  function height(): number {
    const rows = Math.ceil(nodes.length / columns());
    return Math.max(BOX_HEIGHT + GAP * 2, rows * (BOX_HEIGHT + GAP) + GAP);
  }

  function render(): void {
    svg.setAttribute("viewBox", `0 0 ${width} ${height()}`);
    svg.setAttribute("height", String(height()));

    edgesGroup.innerHTML = "";
    for (const edge of edges) {
      const from = outPortPosition(edge.fromNodeId, edge.fromEvent);
      const to = inPortPosition(edge.toNodeId);
      if (!from || !to) continue;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", bezierPath(from, to));
      path.setAttribute("class", "patch-graph-edge");
      path.addEventListener("click", () => options.onRemoveEdge(edge.id));
      edgesGroup.appendChild(path);
    }

    nodesGroup.innerHTML = "";
    nodeBoxEls.clear();
    nodes.forEach((node, index) => {
      const origin = nodeOrigin(index);
      const group = document.createElementNS(SVG_NS, "g");

      const box = document.createElementNS(SVG_NS, "rect");
      box.setAttribute("class", "patch-graph-node-box");
      box.setAttribute("x", String(origin.x));
      box.setAttribute("y", String(origin.y));
      box.setAttribute("width", String(BOX_WIDTH));
      box.setAttribute("height", String(BOX_HEIGHT));
      box.setAttribute("stroke", node.color);
      group.appendChild(box);
      nodeBoxEls.set(node.id, box);

      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "patch-graph-node-label");
      label.setAttribute("x", String(origin.x + 8));
      label.setAttribute("y", String(origin.y + 16));
      label.setAttribute("fill", node.color);
      label.textContent = node.label;
      group.appendChild(label);

      const inPort = inPortPosition(node.id);
      if (inPort) {
        const circle = document.createElementNS(SVG_NS, "circle");
        circle.setAttribute("class", "patch-graph-port patch-graph-in-port");
        circle.setAttribute("cx", String(inPort.x));
        circle.setAttribute("cy", String(inPort.y));
        circle.setAttribute("r", "6");
        circle.dataset.nodeId = node.id;
        group.appendChild(circle);
      }

      for (const event of OUT_EVENTS) {
        const pos = outPortPosition(node.id, event);
        if (!pos) continue;
        const circle = document.createElementNS(SVG_NS, "circle");
        circle.setAttribute("class", "patch-graph-port patch-graph-out-port");
        circle.setAttribute("cx", String(pos.x));
        circle.setAttribute("cy", String(pos.y));
        circle.setAttribute("r", "6");
        circle.setAttribute("fill", node.color);
        circle.addEventListener("pointerdown", (pointerEvent) =>
          startDrag(pointerEvent, node.id, event, pos),
        );
        group.appendChild(circle);

        const portLabel = document.createElementNS(SVG_NS, "text");
        portLabel.setAttribute("class", "patch-graph-port-label");
        portLabel.setAttribute("x", String(pos.x - 10));
        portLabel.setAttribute("y", String(pos.y + 3));
        portLabel.setAttribute("text-anchor", "end");
        portLabel.textContent = OUT_EVENT_LABELS[event];
        group.appendChild(portLabel);
      }

      nodesGroup.appendChild(group);
    });
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

    function localPoint(event: PointerEvent): PortPosition {
      const bounds = svg.getBoundingClientRect();
      return {
        x: ((event.clientX - bounds.left) / bounds.width) * width,
        y: ((event.clientY - bounds.top) / bounds.height) * height(),
      };
    }

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
