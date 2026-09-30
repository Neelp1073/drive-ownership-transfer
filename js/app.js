import {
  DEFAULT_TARGET_EMAIL,
  PLACEHOLDER_CLIENT_ID,
  PLACEHOLDER_TARGET,
} from "./config.js";
import {
  detectAccountKind,
  getExtensionId,
  getRedirectUri,
  loadAuth,
  loadSettings,
  saveSettings,
  signIn,
  signOut,
} from "./auth.js";
import { iterateOwnedFiles, getFile, listOwnedDescendants } from "./drive.js";
import { CSV_HEADERS, downloadCsv, previewRows, toCsv } from "./csv.js";
import { classifyItem, countSkipReasons, scanOwnedItems, SKIP_REASONS } from "./scan.js";
import {
  clearTransferState,
  emptyTransferState,
  loadTransferState,
  saveTransferState,
  summarize,
} from "./state.js";
import {
  buildChildrenMap,
  folderAndContents,
  parseDriveIds,
  searchEligible,
  selectedItems,
} from "./select.js";
import {
  createController,
  crossAccountWarning,
  resolveMode,
  runQueue,
} from "./transfer.js";

const $ = (id) => document.getElementById(id);
const controller = createController();
const logLines = [];

let settings = {};
let auth = null;
let state = emptyTransferState();
let inFlight = false;

function log(message) {
  const time = new Date().toLocaleTimeString();
  logLines.push(`[${time}] ${message}`);
  if (logLines.length > 200) logLines.shift();
  const el = $("log");
  if (el) {
    el.textContent = logLines.join("\n");
    el.scrollTop = el.scrollHeight;
  }
}

function setHtml(id, html) {
  const el = $(id);
  if (el) el.innerHTML = html;
}

function show(id, visible) {
  $(id)?.classList.toggle("hidden", !visible);
}

function setActiveStep(name) {
  document.querySelectorAll("#steps span").forEach((el) => {
    el.classList.toggle("active", el.dataset.step === name);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function runTotal(stateSnap) {
  if (stateSnap.phase === "phase2") return stateSnap.pendingTransfers?.length || 0;
  if (stateSnap.queue?.length) return stateSnap.queue.length;
  return (stateSnap.selectedIds || []).length;
}

function formatEta(stateSnap) {
  const processed = stateSnap.cursor || 0;
  const remaining = Math.max(0, runTotal(stateSnap) - processed);
  if (stateSnap.phase === "phase2") {
    if (!processed || !stateSnap.startedAt) return remaining ? `${remaining} remaining` : "Done";
    const rate = processed / Math.max(Date.now() - stateSnap.startedAt, 1);
    return `${remaining} remaining · ~${formatMs(remaining / Math.max(rate, 1e-9))}`;
  }
  if (!processed || !stateSnap.startedAt) return remaining ? `${remaining} remaining` : "Select items to transfer";
  const rate = processed / Math.max(Date.now() - stateSnap.startedAt, 1);
  return `${remaining} remaining · ~${formatMs(remaining / Math.max(rate, 1e-9))}`;
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "calculating";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

function currentMode() {
  return resolveMode({
    requestedMode: settings.transferMode || "auto",
    sourceUser: auth?.user,
    targetEmail: settings.targetEmail,
  });
}

function renderAccount() {
  if (!auth?.user) {
    $("account-box").textContent = "Not signed in";
    return;
  }
  const kind = detectAccountKind(auth.user);
  $("account-box").innerHTML = `<strong>${auth.user.email}</strong><br /><span class="muted">${kind === "workspace" ? `Workspace (${auth.user.hostedDomain})` : "Personal Gmail"}</span>`;
}

function renderSetup() {
  $("client-id").value = settings.clientId || "";
  $("target-email").value = settings.targetEmail || DEFAULT_TARGET_EMAIL;
  $("transfer-mode").value = settings.transferMode || "auto";
  $("extension-id").value = getExtensionId();
  $("redirect-uri").value = getRedirectUri();
}

function renderSteps() {
  if (!settings.clientId && !settings.manifestClientId) return setActiveStep("setup");
  if (!auth?.user) return setActiveStep("signin");
  if (!state.eligible?.length && state.status === "idle") return setActiveStep("scan");
  if (state.status === "running" || state.status === "paused") return setActiveStep("transfer");
  if (state.eligible?.length) return setActiveStep("review");
  setActiveStep("scan");
}

function renderReview() {
  const hasScan = (state.eligible?.length || 0) + (state.skipped?.length || 0) > 0;
  show("card-review", hasScan);
  if (!hasScan) return;
  const sum = summarize(state);
  $("review-stats").innerHTML = `
    <div class="stat"><b>${sum.selected}</b><span>Selected to transfer</span></div>
    <div class="stat"><b>${sum.eligible}</b><span>Eligible in scan</span></div>
    <div class="stat"><b>${sum.files}</b><span>Eligible files</span></div>
    <div class="stat"><b>${sum.folders}</b><span>Eligible folders</span></div>
    <div class="stat"><b>${sum.skippedScan}</b><span>Skipped in scan</span></div>
  `;
  const counts = countSkipReasons(state.skipped || []);
  const labels = {
    shared_drive: SKIP_REASONS.SHARED_DRIVE,
    not_owner: SKIP_REASONS.NOT_OWNER,
    cannot_share: SKIP_REASONS.CANNOT_SHARE,
    cannot_transfer: SKIP_REASONS.CANNOT_TRANSFER,
  };
  const items = Object.keys(labels).map((code) => {
    const n = counts[code] || 0;
    return `<li><strong>${n}</strong> — ${labels[code]}</li>`;
  });
  if (!state.skipped?.some((s) => s.skipCode === "shared_drive")) {
    items.push("<li>No Shared Drive items were returned in this My Drive owner scan (they are not personally owned).</li>");
  }
  $("skip-summary").innerHTML = items.join("");

  const mode = state.mode || currentMode();
  $("phase-note").innerHTML =
    mode === "workspace"
      ? "Workspace mode: each eligible item is transferred now with <code>transferOwnership=true</code>. The previous owner stays a writer, and Google emails the new owner."
      : "Gmail mode is two-phase. Phase 1 (this account) adds the target as a writer with <code>pendingOwner=true</code>. Ownership does <strong>not</strong> change until the target signs in and accepts in Phase 2.";

  const warn = crossAccountWarning({
    sourceUser: auth?.user,
    targetEmail: settings.targetEmail,
    mode,
  });
  $("review-warning").innerHTML = warn ? `<div class="warn">${warn}</div>` : "";
  $("ack-checkbox").checked = !!state.acknowledged;
  renderPicker();
  updateActionButtons();
}

function renderProgress() {
  const started = state.status !== "idle" || (state.results || []).length > 0 || (state.pendingTransfers || []).length > 0;
  show("card-progress", started || state.status === "running" || state.status === "paused");
  const sum = summarize(state);
  const total = runTotal(state);
  const pct = total ? Math.round((state.cursor / total) * 100) : 0;
  $("progress-bar").style.width = `${pct}%`;
  $("progress-stats").innerHTML = `
    <div class="stat"><b>${sum.processed}</b><span>Processed</span></div>
    <div class="stat"><b>${sum.succeeded}</b><span>Succeeded</span></div>
    <div class="stat"><b>${sum.skipped}</b><span>Skipped</span></div>
    <div class="stat"><b>${sum.failed}</b><span>Failed</span></div>
    <div class="stat"><b>${formatEta(state)}</b><span>Estimate</span></div>
  `;
  $("progress-current").textContent = state.currentName
    ? `Current: ${state.currentName}`
    : state.status === "done"
      ? "Idle — last run finished."
      : state.status === "paused"
        ? "Paused."
        : "";
  const needPhase2 =
    (state.mode === "consumer" || state.phase === "phase1") &&
    (state.pendingTransfers || []).length > 0 &&
    state.status !== "running";
  show("phase2-box", needPhase2);
  $("btn-pause").disabled = !inFlight || controller.paused;
  const canResume =
    (inFlight && controller.paused) ||
    (!inFlight && (state.status === "paused" || state.status === "cancelled") && state.cursor < total);
  $("btn-resume").disabled = !canResume;
  const signed = (auth?.user?.email || "").toLowerCase();
  const target = (settings.targetEmail || state.targetEmail || "").toLowerCase();
  const asTarget = Boolean(signed && target && signed === target);
  const pending = state.pendingTransfers?.length || 0;
  if (needPhase2 && $("phase2-status")) {
    if (!auth?.user) {
      $("phase2-status").innerHTML = `Click <strong>Sign in as target (Phase 2)</strong> above, choose <strong>${settings.targetEmail || "the target Gmail"}</strong>, click Allow, then come back here.`;
    } else if (!asTarget) {
      $("phase2-status").innerHTML = `You are signed in as <strong>${auth.user.email}</strong>. Click <strong>Sign out</strong>, then <strong>Sign in as target (Phase 2)</strong>, and pick <strong>${settings.targetEmail}</strong> — not the work account. Click Allow on Google’s permission screen.`;
    } else {
      $("phase2-status").innerHTML = `Signed in as the target. Click <strong>Accept pending transfers</strong> to finish ${pending} item${pending === 1 ? "" : "s"}.`;
    }
  }
  $("btn-phase2").disabled = inFlight || !asTarget;
}

function renderAll() {
  renderAccount();
  renderReview();
  renderProgress();
  renderSteps();
}

function updateActionButtons() {
  const hasSelection = (state.selectedIds || []).length > 0;
  $("btn-start").disabled = !$("ack-checkbox")?.checked || !hasSelection || inFlight;
  $("btn-dry-run").disabled = !hasSelection || inFlight;
}

function scanMissingFolderTree() {
  const eligible = state.eligible || [];
  if (!eligible.length) return false;
  return !eligible.some((item) => (item.parents || []).length);
}

function renderPicker() {
  if (!$("pick-results")) return;
  const selected = selectedItems(state);
  const files = selected.filter((i) => !i.isFolder).length;
  const folders = selected.length - files;
  $("pick-summary").textContent = selected.length
    ? `${selected.length} selected (${files} files, ${folders} folders). Only these will be transferred.`
    : "0 items selected. Paste links or search — the full scan list is not transferred.";
  $("pick-selected").innerHTML = selected
    .slice(0, 80)
    .map(
      (item) =>
        `<button type="button" class="chip" data-remove-id="${item.id}" title="Remove ${escapeHtml(item.name)}">${escapeHtml(item.name)}${item.isFolder ? " (folder + contents)" : ""} ×</button>`
    )
    .join("");
  if (selected.length > 80) {
    $("pick-selected").insertAdjacentHTML(
      "beforeend",
      `<span class="muted">+${selected.length - 80} more</span>`
    );
  }
  if (scanMissingFolderTree()) {
    setHtml(
      "pick-status",
      `<div class="info">This scan is missing folder paths. Adding a folder will look up its contents in Drive. For faster picks, reload the extension and Scan again.</div>`
    );
  }
  renderPickerResults();
}

function renderPickerResults() {
  const box = $("pick-results");
  if (!box) return;
  const query = $("pick-search")?.value || "";
  const hits = searchEligible(state.eligible, query);
  const selected = new Set(state.selectedIds || []);
  if (!hits.length) {
    box.innerHTML = `<div class="pick-row"><span class="muted">${query.trim() ? "No matching owned items." : "Type a name, or paste Drive links above."}</span></div>`;
    return;
  }
  box.innerHTML = hits
    .map((item) => {
      const already = selected.has(item.id);
      const label = item.isFolder ? "folder" : "file";
      return `<div class="pick-row"><span title="${escapeHtml(item.id)}">${item.isFolder ? "📁" : "📄"} ${escapeHtml(item.name)} <span class="muted">(${label})</span></span><button type="button" class="secondary" data-add-id="${item.id}" ${already ? "disabled" : ""}>${already ? "Added" : item.isFolder ? "Add folder + contents" : "Add"}</button></div>`;
    })
    .join("");
  const folderHit = hits.find((item) => item.isFolder);
  if (query.trim() && folderHit && !hits.some((item) => !item.isFolder)) {
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="pick-row"><span class="muted">Files inside this folder are not listed by name. Click <strong>Add folder + contents</strong> to load the photos from Drive (signed in as the owner).</span></div>`
    );
  }
}

function asPickerItem(file) {
  const classified = classifyItem(file, { mode: state.mode || currentMode() });
  return classified.eligible ? classified : null;
}

async function itemsForId(id, { fetchIfNeeded = true } = {}) {
  const byId = new Map((state.eligible || []).map((item) => [item.id, item]));
  let item = byId.get(id);
  if (!item && fetchIfNeeded) {
    try {
      const file = await getFile(id);
      item = classifyItem(file, { mode: state.mode || currentMode() });
      if (!item.eligible && item.skipCode === "not_owner") {
        throw new Error("not-owner");
      }
    } catch (error) {
      if (error?.message === "not-owner") {
        setHtml(
          "pick-status",
          `<div class="error">This folder is not owned by ${auth?.user?.email || "the signed-in account"}. Sign in as the source (neelp0300work@gmail.com), then add it again.</div>`
        );
        return [];
      }
      setHtml("pick-status", `<div class="error">Could not open that Drive item: ${error.message}</div>`);
      return [];
    }
  }
  if (!item) return [];
  if (!item.isFolder) return [item];
  const collected = folderAndContents(id, state.eligible, buildChildrenMap(state.eligible));
  const seen = new Set(collected.map((entry) => entry.id));
  if (!seen.has(item.id)) {
    collected.unshift(item);
    seen.add(item.id);
  }
  if (fetchIfNeeded) {
    setHtml("pick-status", `<div class="muted">Loading files inside “${escapeHtml(item.name)}” from Drive…</div>`);
    const remote = await listOwnedDescendants(id);
    for (const file of remote) {
      const child = asPickerItem(file);
      if (!child?.eligible || seen.has(child.id)) continue;
      collected.push(child);
      seen.add(child.id);
    }
  }
  return collected;
}

async function addItems(items, { missing = [] } = {}) {
  const eligibleById = new Map((state.eligible || []).map((item) => [item.id, item]));
  const ids = new Set(state.selectedIds || []);
  let added = 0;
  let files = 0;
  let folders = 0;
  for (const item of items) {
    if (!item?.id) continue;
    if (!eligibleById.has(item.id)) {
      state.eligible.push(item);
      eligibleById.set(item.id, item);
    }
    if (!ids.has(item.id)) {
      ids.add(item.id);
      added += 1;
    }
    if (item.isFolder) folders += 1;
    else files += 1;
  }
  state.selectedIds = [...ids];
  await saveTransferState(state);
  const parts = [];
  if (added) {
    parts.push(`Added ${added} item${added === 1 ? "" : "s"} (${files} files, ${folders} folders).`);
  } else if (items.length) {
    parts.push("Those items were already selected.");
  }
  if (items.length <= 1 && items[0]?.isFolder) {
    parts.push(
      `No files were found inside this folder for ${auth?.user?.email || "the signed-in account"}. Sign in as the owner, then click Add folder + contents again.`
    );
  }
  if (missing.length) {
    parts.push(
      `${missing.length} ID${missing.length === 1 ? " was" : "s were"} not in this scan (not owned by ${state.sourceEmail || "this account"}, or not found).`
    );
  }
  const ok = added > 1 || (added === 1 && !items[0]?.isFolder);
  setHtml("pick-status", parts.length ? `<div class="${ok ? "ok" : "warn"}">${parts.join(" ")}</div>` : "");
  renderPicker();
  updateActionButtons();
}

async function onAddLinks() {
  const ids = parseDriveIds($("pick-links")?.value || "");
  if (!ids.length) {
    setHtml("pick-status", `<div class="error">Paste a Drive folder/file link or ID first.</div>`);
    return;
  }
  const missing = [];
  const collected = [];
  for (const id of ids) {
    const items = await itemsForId(id);
    if (!items.length) missing.push(id);
    else collected.push(...items);
  }
  await addItems(collected, { missing: collected.length ? [] : missing });
}

async function onAddFromSearch(id) {
  const items = await itemsForId(id);
  if (!items.length) {
    setHtml("pick-status", `<div class="error">That item is not in the eligible scan list.</div>`);
    return;
  }
  await addItems(items);
}

async function onRemoveSelected(id) {
  const remove = new Set((await itemsForId(id)).map((item) => item.id));
  if (!remove.size) remove.add(id);
  state.selectedIds = (state.selectedIds || []).filter((itemId) => !remove.has(itemId));
  await saveTransferState(state);
  renderPicker();
  updateActionButtons();
}

async function onClearSelection() {
  state.selectedIds = [];
  state.queue = [];
  await saveTransferState(state);
  setHtml("pick-status", `<div class="muted">Selection cleared.</div>`);
  renderPicker();
  updateActionButtons();
}

async function persistAck() {
  state.acknowledged = $("ack-checkbox").checked;
  await saveTransferState(state);
  updateActionButtons();
}

async function onSaveSetup() {
  const clientId = $("client-id").value.trim();
  const targetEmail = $("target-email").value.trim();
  const transferMode = $("transfer-mode").value;
  if (!clientId || clientId === PLACEHOLDER_CLIENT_ID) {
    setHtml("setup-status", `<div class="error">Paste a real OAuth client ID from Google Cloud Console.</div>`);
    return;
  }
  if (!targetEmail || targetEmail === PLACEHOLDER_TARGET || !targetEmail.includes("@")) {
    setHtml("setup-status", `<div class="error">Replace the target email with the new owner’s Gmail or Workspace address.</div>`);
    return;
  }
  settings = await saveSettings({ clientId, targetEmail, transferMode });
  setHtml("setup-status", `<div class="ok">Saved. Extension ID <code>${getExtensionId()}</code> — put the redirect URI in your OAuth client before signing in.</div>`);
  log("Setup saved.");
  renderSteps();
}

let signingIn = false;

async function onSignIn(asTarget) {
  if (signingIn) {
    setHtml("auth-status", `<div class="warn">Sign-in is already running. Close any Google window, or reload the extension on brave://extensions.</div>`);
    return;
  }
  signingIn = true;
  $("btn-signin-source").disabled = true;
  $("btn-signin-target").disabled = true;
  try {
    setHtml("auth-status", `<div class="muted">Opening Google sign-in…</div>`);
    auth = await signIn({ promptSelectAccount: true });
    const email = auth.user?.email || "";
    if (asTarget) {
      const target = (settings.targetEmail || "").toLowerCase();
      if (email.toLowerCase() !== target) {
        setHtml(
          "auth-status",
          `<div class="error">Signed in as ${email}, but the target is ${settings.targetEmail}. Sign out and choose the target account.</div>`
        );
        log(`Phase 2 sign-in mismatch: ${email}`);
        renderAccount();
        return;
      }
    }
    setHtml(
      "auth-status",
      `<div class="ok">Signed in as ${email}. ${detectAccountKind(auth.user) === "workspace" ? "Detected Google Workspace." : "Detected personal Gmail."}</div>`
    );
    log(`Signed in as ${email}`);
    renderAll();
  } catch (error) {
    setHtml("auth-status", `<div class="error">${error.message}</div>`);
    log(`Sign-in failed: ${error.message}`);
  } finally {
    signingIn = false;
    $("btn-signin-source").disabled = false;
    $("btn-signin-target").disabled = false;
  }
}

async function onSignOut() {
  await signOut();
  auth = null;
  setHtml("auth-status", `<div class="muted">Signed out. Local transfer state is still saved so you can resume.</div>`);
  renderAll();
}

async function onScan() {
  if (!auth?.user) {
    setHtml("scan-status", "Sign in as the source account first.");
    return;
  }
  const mode = currentMode();
  $("btn-scan").disabled = true;
  setHtml("scan-status", "Scanning…");
  log(`Scan started (${mode} mode).`);
  try {
    const result = await scanOwnedItems({
      iterate: iterateOwnedFiles,
      mode,
      onProgress: ({ seen }) => {
        setHtml("scan-status", `Scanning… ${seen} items seen`);
      },
    });
    state = emptyTransferState();
    state.status = "scanned";
    state.sourceEmail = auth.user.email;
    state.targetEmail = settings.targetEmail;
    state.mode = mode;
    state.eligible = result.eligible;
    state.skipped = result.skipped;
    state.selectedIds = [];
    state.queue = [];
    await saveTransferState(state);
    setHtml(
      "scan-status",
      `Done. ${result.eligible.length} eligible, ${result.skipped.length} skipped (${result.seen} listed).`
    );
    log(`Scan finished: ${result.eligible.length} eligible, ${result.skipped.length} skipped.`);
    renderAll();
  } catch (error) {
    setHtml("scan-status", `<span style="color:var(--red)">${error.message}</span>`);
    log(`Scan failed: ${error.message}`);
  } finally {
    $("btn-scan").disabled = false;
  }
}

function exportCsv(name) {
  const csv = toCsv(previewRows(state), CSV_HEADERS);
  downloadCsv(name, csv);
}

async function startRun({ dryRun, phase, resume }) {
  if (inFlight && controller.paused && resume) {
    controller.paused = false;
    state.status = "running";
    await saveTransferState(state);
    log("Resumed.");
    renderProgress();
    return;
  }
  if (inFlight) {
    log("A run is already in progress. Pause or wait for it to finish.");
    return;
  }
  if (!auth?.user) {
    log("Sign in before transferring.");
    return;
  }
  if (!dryRun && !$("ack-checkbox").checked) {
    log("Check the confirmation box before Start Transfer or Phase 2 accept.");
    return;
  }
  if (phase !== "phase2" && !state.eligible?.length) {
    log("Scan first so there is a review list.");
    return;
  }
  if (phase !== "phase2" && !resume && !selectedItems(state).length) {
    log("Select specific files or folders first. The full scan list is not transferred.");
    setHtml(
      "pick-status",
      `<div class="error">Add at least one file or folder above. Nothing is transferred until you select it.</div>`
    );
    return;
  }
  if (phase === "phase2" && !state.pendingTransfers?.length) {
    log("No pending transfers are saved. Run Phase 1 as the source account first.");
    return;
  }
  if (!dryRun && phase === "phase2") {
    const signed = (auth.user.email || "").toLowerCase();
    const target = (settings.targetEmail || "").toLowerCase();
    if (signed !== target) {
      log(`Phase 2 must be signed in as ${settings.targetEmail}, not ${auth.user.email}.`);
      return;
    }
  }

  if (!resume) {
    state.cursor = 0;
    state.startedAt = null;
    if (phase !== "phase2") {
      state.queue = selectedItems(state);
      state.results = [];
      state.resultOffset = 0;
      if (!dryRun) state.pendingTransfers = [];
    } else {
      state.resultOffset = (state.results || []).length;
    }
    state.acknowledged = $("ack-checkbox").checked;
    state.targetEmail = settings.targetEmail;
    state.mode = state.mode || currentMode();
  }

  controller.paused = false;
  controller.cancelled = false;
  inFlight = true;
  show("card-progress", true);
  setActiveStep("transfer");
  renderProgress();
  log(dryRun ? "Dry run started — no Drive changes." : `Transfer started (${phase}).`);

  try {
    await runQueue({
      state,
      controller,
      phase,
      targetEmail: settings.targetEmail,
      dryRun,
      onProgress: () => {
        renderProgress();
        const last = state.results[state.results.length - 1];
        if (last && (last.status === "failed" || last.status === "skipped")) {
          log(`${last.status}: ${last.name} — ${last.reason || last.error}`);
        } else if (last && state.cursor % 10 === 0) {
          log(`Processed ${state.cursor}…`);
        }
      },
    });
    log(`Run finished with status ${state.status}.`);
  } finally {
    inFlight = false;
    renderAll();
  }
}

async function onClearState() {
  if (!confirm("Clear saved scan, progress, and pending-transfer IDs from this browser?")) return;
  state = await clearTransferState();
  $("ack-checkbox").checked = false;
  show("card-review", false);
  show("card-progress", false);
  show("phase2-box", false);
  log("Saved state cleared.");
  renderAll();
}

async function init() {
  settings = await loadSettings();
  if (!settings.targetEmail) {
    settings = await saveSettings({ targetEmail: DEFAULT_TARGET_EMAIL });
  }
  auth = await loadAuth();
  state = await loadTransferState();
  state.selectedIds = state.selectedIds || [];
  state.queue = state.queue || [];
  renderSetup();
  renderAll();
  if (state.status === "running") {
    state.status = "paused";
    await saveTransferState(state);
    log("Previous run was interrupted. Click Resume to continue.");
    renderProgress();
  } else if (state.eligible?.length) {
    log("Restored saved scan / transfer state.");
  }

  $("save-setup").addEventListener("click", onSaveSetup);
  $("btn-signin-source").addEventListener("click", () => onSignIn(false));
  $("btn-signin-target").addEventListener("click", () => onSignIn(true));
  $("btn-signout").addEventListener("click", onSignOut);
  $("btn-scan").addEventListener("click", onScan);
  $("ack-checkbox").addEventListener("change", persistAck);
  $("btn-add-links").addEventListener("click", onAddLinks);
  $("pick-search").addEventListener("input", renderPickerResults);
  $("btn-clear-selection").addEventListener("click", onClearSelection);
  $("pick-results").addEventListener("click", (event) => {
    const button = event.target.closest("[data-add-id]");
    if (button) onAddFromSearch(button.dataset.addId);
  });
  $("pick-selected").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-id]");
    if (button) onRemoveSelected(button.dataset.removeId);
  });
  $("btn-dry-run").addEventListener("click", () =>
    startRun({ dryRun: true, phase: currentMode() === "workspace" ? "workspace" : "phase1", resume: false })
  );
  $("btn-start").addEventListener("click", () =>
    startRun({
      dryRun: false,
      phase: currentMode() === "workspace" ? "workspace" : "phase1",
      resume: false,
    })
  );
  $("btn-phase2").addEventListener("click", () => startRun({ dryRun: false, phase: "phase2", resume: false }));
  $("btn-pause").addEventListener("click", () => {
    controller.paused = true;
    log("Pause requested after the current item.");
  });
  $("btn-resume").addEventListener("click", () => {
    const phase =
      state.phase === "dry-run"
        ? currentMode() === "workspace"
          ? "workspace"
          : "phase1"
        : state.phase || (currentMode() === "workspace" ? "workspace" : "phase1");
    startRun({ dryRun: !!(state.dryRun || state.phase === "dry-run"), phase, resume: true });
  });
  $("btn-cancel").addEventListener("click", () => {
    controller.cancelled = true;
    controller.paused = false;
    log("Cancel requested. Progress is kept so you can export a report.");
  });
  $("btn-export-preview").addEventListener("click", () => exportCsv("drive-ownership-preview.csv"));
  $("btn-export-report").addEventListener("click", () => exportCsv("drive-ownership-report.csv"));
  $("btn-clear-state").addEventListener("click", onClearState);
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const input = $(btn.dataset.copy);
      await navigator.clipboard.writeText(input.value);
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.textContent = "Copy";
      }, 1200);
    });
  });
}

init();
