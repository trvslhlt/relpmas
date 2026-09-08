// A single node's own authored config, saveable/loadable independently of
// the rest of the patch (no edges, no other nodes) -- deliberately NOT
// whole-patch persistence, which doesn't exist in this app at all yet (see
// PLAN's own out-of-scope notes). Backed by localStorage rather than a
// server: this is a solo instrument, and every other piece of state here
// (the loaded sample, the patch graph) is already session-only.

import type { SampleNode } from "./sampleNode";

const STORAGE_KEY = "relpmas.nodePresets";

export interface NodePreset {
  name: string;
  createdAt: number;
  /** Everything a SampleNode carries except its own identity (id/label/
   * color) and its own fileId -- the same field set duplicateSampleNode
   * already treats as "everything transferable" (see its own doc comment
   * in sampleNode.ts), minus fileId: a preset should apply to whichever
   * of the currently loaded files it's loaded against, not lock in the
   * one it happened to be authored on. */
  data: Omit<SampleNode, "id" | "label" | "color" | "fileId">;
}

function readStore(): Record<string, NodePreset> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    // Corrupted or foreign localStorage content under this key -- treat
    // as an empty library rather than throwing and losing the rest of
    // the app.
    return {};
  }
}

function writeStore(store: Record<string, NodePreset>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

/** Overwrites any existing preset with the same name -- no separate
 * "rename"/"already exists" flow, matching how little ceremony the rest
 * of this app's save-style actions (e.g. duplicating a node) already
 * have. */
export function savePreset(name: string, node: SampleNode): void {
  const { id, label, color, fileId, ...data } = structuredClone(node);
  const store = readStore();
  store[name] = { name, createdAt: Date.now(), data };
  writeStore(store);
}

/** Newest first -- the preset just saved is the one most likely wanted
 * next. */
export function listPresets(): NodePreset[] {
  return Object.values(readStore()).sort((a, b) => b.createdAt - a.createdAt);
}

export function deletePreset(name: string): void {
  const store = readStore();
  delete store[name];
  writeStore(store);
}
