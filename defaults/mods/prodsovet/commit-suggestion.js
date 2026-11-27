// The suggestion spends the person's model quota, so it runs only while this
// panel is on screen: every hidden ancestor and every stack on the way must
// show it, and the window must be in front. A layout without the block counts
// as shown (the panel then lives somewhere this check can't see).
function onPath(node, id, path = []) {
  if (!node) return null;
  if (node.id === id) return [...path, node];
  for (const child of node.children ?? []) {
    const found = onPath(child, id, [...path, node]);
    if (found) return found;
  }
  return null;
}
export function changesShown(root, win) {
  if (win && win.active === false) return false;
  const path = onPath(root, "changes");
  if (!path) return true;
  return path.every((node, i) => !node.hidden && (node.active == null || !path[i + 1] || node.active === path[i + 1].id));
}

// A suggestion belongs to one complete diff. Late results never cross spaces.
export class CommitSuggestion {
  constructor(call) {
    this.call = call;
    this.cache = new Map();
    this.reset();
  }
  reset() {
    this.epoch = (this.epoch ?? 0) + 1;
    this.value = ''; this.fingerprint = null; this.tried = null;
    this.busy = false; this.error = null;
  }
  async update(root, language, current, notify) {
    if (this.busy || !current()) return;
    const epoch = this.epoch;
    const live = () => epoch === this.epoch && current();
    this.busy = true;
    try {
      const snapshot = await this.call('snapshot', root);
      if (!live()) return;
      if (snapshot.fingerprint !== this.fingerprint) {
        this.value = ''; this.error = null; this.tried = null;
        this.fingerprint = snapshot.fingerprint;
      }
      if (snapshot.empty || snapshot.conflict) { this.value = ''; return; }
      const cacheKey = JSON.stringify([root, language, snapshot.fingerprint]);
      if (this.cache.has(cacheKey)) { this.value = this.cache.get(cacheKey); return; }
      if (this.tried === cacheKey) return;
      this.tried = cacheKey; this.error = null; notify();
      // The helper reads the diff again from `root`: a diff excerpt in argv
      // would pass the 32,767-character command line limit on Windows. The
      // fingerprint check below drops a subject written for a newer diff.
      const result = await this.call('generate', JSON.stringify({ root, language }));
      if (!live()) return;
      const latest = await this.call('snapshot', root);
      if (!live()) return;
      if (latest.fingerprint !== snapshot.fingerprint || latest.empty || latest.conflict) {
        this.value = ''; this.fingerprint = null; this.tried = null; return;
      }
      this.value = result.message;
      this.cache.set(cacheKey, result.message);
      if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
    } catch (e) {
      if (live()) { this.value = ''; this.error = String(e.message ?? e); }
    } finally {
      if (epoch === this.epoch) { this.busy = false; notify(); }
    }
  }
}
