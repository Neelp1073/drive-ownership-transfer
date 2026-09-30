/**
 * Pick specific owned files/folders. Selecting a folder includes owned children.
 */

export function parseDriveIds(text) {
  const ids = new Set();
  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]+)/g,
    /\/file\/d\/([a-zA-Z0-9_-]+)/g,
    /\/document\/d\/([a-zA-Z0-9_-]+)/g,
    /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/g,
    /\/presentation\/d\/([a-zA-Z0-9_-]+)/g,
    /[?&]id=([a-zA-Z0-9_-]+)/g,
  ];
  const raw = text || "";
  for (const re of patterns) {
    let match;
    while ((match = re.exec(raw))) ids.add(match[1]);
  }
  for (const token of raw.split(/[\s,;]+/)) {
    const t = token.trim();
    if (/^[a-zA-Z0-9_-]{20,}$/.test(t) && !t.includes("http")) ids.add(t);
  }
  return [...ids];
}

export function buildChildrenMap(eligible) {
  const childrenByParent = new Map();
  for (const item of eligible || []) {
    for (const parentId of item.parents || []) {
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(item);
    }
  }
  return childrenByParent;
}

export function folderAndContents(folderId, eligible, childrenByParent) {
  const byId = new Map((eligible || []).map((i) => [i.id, i]));
  const collected = [];
  const seen = new Set();
  const root = byId.get(folderId);
  if (root && !seen.has(root.id)) {
    collected.push(root);
    seen.add(root.id);
  }
  const stack = [...(childrenByParent.get(folderId) || [])];
  while (stack.length) {
    const item = stack.pop();
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    collected.push(item);
    if (item.isFolder) stack.push(...(childrenByParent.get(item.id) || []));
  }
  return collected;
}

export function searchEligible(eligible, query, limit = 40) {
  const q = (query || "").trim().toLowerCase();
  const childrenByParent = buildChildrenMap(eligible);
  if (!q) {
    return (eligible || []).filter((i) => i.isFolder).slice(0, limit);
  }
  const hits = [];
  for (const item of eligible || []) {
    if ((item.name || "").toLowerCase().includes(q) || item.id === query.trim()) {
      hits.push(item);
      if (item.isFolder) {
        const inside = folderAndContents(item.id, eligible, childrenByParent).filter((child) => child.id !== item.id);
        hits.push(...inside.slice(0, 20));
      }
      if (hits.length >= limit) break;
    }
  }
  return hits.slice(0, limit);
}

export function selectedItems(state) {
  const ids = new Set(state.selectedIds || []);
  if (!ids.size) return [];
  return (state.eligible || []).filter((i) => ids.has(i.id));
}
