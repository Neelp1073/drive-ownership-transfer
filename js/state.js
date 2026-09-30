import { STORAGE_KEYS } from "./config.js";

export function emptyTransferState() {
  return {
    version: 1,
    status: "idle", // idle | scanned | running | paused | cancelled | done
    phase: null, // workspace | phase1 | phase2 | dry-run
    sourceEmail: null,
    targetEmail: null,
    mode: null,
    acknowledged: false,
    eligible: [],
    selectedIds: [],
    queue: [],
    skipped: [],
    results: [],
    resultOffset: 0,
    cursor: 0,
    pendingTransfers: [],
    startedAt: null,
    updatedAt: Date.now(),
    currentName: "",
    dryRun: false,
  };
}

export async function loadTransferState() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.TRANSFER);
  return data[STORAGE_KEYS.TRANSFER] || emptyTransferState();
}

export async function saveTransferState(state) {
  const next = { ...state, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEYS.TRANSFER]: next });
  return next;
}

export async function clearTransferState() {
  const blank = emptyTransferState();
  await chrome.storage.local.set({ [STORAGE_KEYS.TRANSFER]: blank });
  return blank;
}

export function summarize(state) {
  const eligible = state.eligible || [];
  const folders = eligible.filter((i) => i.isFolder).length;
  const files = eligible.length - folders;
  const selected = (state.selectedIds || []).length;
  const runResults = (state.results || []).slice(state.resultOffset || 0);
  const succeeded = runResults.filter((r) => r.status === "succeeded" || r.status === "dry-run").length;
  const failed = runResults.filter((r) => r.status === "failed").length;
  const skipped = runResults.filter((r) => r.status === "skipped").length;
  const processed = runResults.length;
  const queueLength =
    state.phase === "phase2"
      ? (state.pendingTransfers || []).length
      : state.queue?.length || selected;
  const remaining = Math.max(0, queueLength - (state.cursor || 0));
  return {
    eligible: eligible.length,
    files,
    folders,
    selected,
    skippedScan: (state.skipped || []).length,
    processed,
    succeeded,
    failed,
    skipped,
    remaining,
    currentName: state.currentName || "",
  };
}
