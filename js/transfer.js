/**
 * Drive ownership mutations.
 *
 * Workspace (same organization): POST permission role=owner with
 * transferOwnership=true. Google keeps the previous owner as a writer.
 *
 * Consumer Gmail: POST writer + pendingOwner=true (Phase 1), then the
 * target account PATCHes that permission with transferOwnership=true (Phase 2).
 * Google does not allow Gmail↔Workspace or cross-organization transfers.
 */
import { MUTATION_GAP_MS } from "./config.js";
import {
  createPermission,
  findPermissionForEmail,
  listPermissions,
  patchPermission,
} from "./drive.js";
import { explainError } from "./errors.js";
import { saveTransferState } from "./state.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveMode({ requestedMode, sourceUser, targetEmail }) {
  if (requestedMode === "workspace" || requestedMode === "consumer") return requestedMode;
  const sourceKind = sourceUser?.hostedDomain ? "workspace" : "consumer";
  const target = (targetEmail || "").toLowerCase();
  const targetLooksGmail = target.endsWith("@gmail.com") || target.endsWith("@googlemail.com");
  const sourceDomain = (sourceUser?.hostedDomain || "").toLowerCase();
  const targetDomain = target.split("@")[1] || "";

  if (sourceKind === "workspace" && sourceDomain && targetDomain === sourceDomain) {
    return "workspace";
  }
  if (sourceKind === "consumer" && targetLooksGmail) return "consumer";
  // Mixed or unknown — still pick a best attempt so the API can return a clear error.
  if (sourceKind === "workspace") return "workspace";
  return "consumer";
}

export function crossAccountWarning({ sourceUser, targetEmail, mode }) {
  const source = (sourceUser?.email || "").toLowerCase();
  const target = (targetEmail || "").toLowerCase();
  if (!source || !target) return null;
  if (source === target) return "Source and target are the same account. Choose a different target email.";

  const sourceHd = (sourceUser?.hostedDomain || "").toLowerCase();
  const targetDomain = target.split("@")[1] || "";
  const targetGmail = target.endsWith("@gmail.com") || target.endsWith("@googlemail.com");
  const sourceGmail = source.endsWith("@gmail.com") || source.endsWith("@googlemail.com");

  if (sourceHd && targetGmail) {
    return "Google does not permit transferring ownership from a Google Workspace account to a personal Gmail account.";
  }
  if (sourceGmail && !targetGmail) {
    return "Google does not permit transferring ownership from a personal Gmail account to a Google Workspace account.";
  }
  if (sourceHd && targetDomain && targetDomain !== sourceHd && !targetGmail) {
    return `Google does not permit transferring ownership across organizations (${sourceHd} → ${targetDomain}). Both accounts must be in the same Workspace organization.`;
  }
  if (mode === "workspace" && (sourceGmail || targetGmail)) {
    return "Workspace same-organization transfer is selected, but at least one account looks like personal Gmail. Use the consumer two-phase flow instead, or confirm both accounts are in the same organization.";
  }
  return null;
}

async function workspaceTransfer(item, targetEmail) {
  const permissions = await listPermissions(item.id);
  const existing = findPermissionForEmail(permissions, targetEmail);
  if (existing?.role === "owner") {
    return { status: "skipped", reason: "Target is already the owner", permissionId: existing.id };
  }
  if (existing) {
    const patched = await patchPermission(
      item.id,
      existing.id,
      { role: "owner" },
      { transferOwnership: "true", sendNotificationEmail: "true" }
    );
    return { status: "succeeded", reason: "Transferred ownership (Workspace)", permissionId: patched.id || existing.id };
  }
  const created = await createPermission(
    item.id,
    { type: "user", role: "owner", emailAddress: targetEmail },
    { transferOwnership: "true", sendNotificationEmail: "true" }
  );
  return {
    status: "succeeded",
    reason: "Transferred ownership (Workspace). Previous owner remains a writer.",
    permissionId: created.id,
  };
}

async function phase1PendingOwner(item, targetEmail) {
  const permissions = await listPermissions(item.id);
  const existing = findPermissionForEmail(permissions, targetEmail);
  if (existing?.role === "owner") {
    return { status: "skipped", reason: "Target is already the owner", permissionId: existing.id };
  }
  if (existing?.pendingOwner) {
    return {
      status: "succeeded",
      reason: "Target is already a pending owner",
      permissionId: existing.id,
      pending: true,
    };
  }
  if (existing) {
    const patched = await patchPermission(item.id, existing.id, { pendingOwner: true, role: "writer" }, {
      sendNotificationEmail: "true",
    });
    return {
      status: "succeeded",
      reason: "Marked existing writer as pending owner",
      permissionId: patched.id || existing.id,
      pending: true,
    };
  }
  const created = await createPermission(
    item.id,
    {
      type: "user",
      role: "writer",
      emailAddress: targetEmail,
      pendingOwner: true,
    },
    { sendNotificationEmail: "true" }
  );
  return {
    status: "succeeded",
    reason: "Added target as writer with pendingOwner=true",
    permissionId: created.id,
    pending: true,
  };
}

async function phase2Accept(item, targetEmail) {
  const permissions = await listPermissions(item.id);
  const existing =
    (item.permissionId && permissions.find((p) => p.id === item.permissionId)) ||
    findPermissionForEmail(permissions, targetEmail);

  if (!existing) {
    return {
      status: "failed",
      reason: "No pending-owner permission found for the target account. The source account must complete Phase 1 first.",
    };
  }
  if (existing.role === "owner") {
    return { status: "skipped", reason: "Already accepted / already owner", permissionId: existing.id };
  }
  if (!existing.pendingOwner) {
    return {
      status: "failed",
      reason: "This item is not waiting for the target account to accept ownership. Sign in as the target, or re-run Phase 1 as the source.",
      permissionId: existing.id,
    };
  }
  const patched = await patchPermission(
    item.id,
    existing.id,
    { role: "owner" },
    { transferOwnership: "true", sendNotificationEmail: "true" }
  );
  return {
    status: "succeeded",
    reason: "Accepted pending ownership. Previous owner remains a writer.",
    permissionId: patched.id || existing.id,
  };
}

async function processOne(item, { phase, targetEmail, dryRun }) {
  if (dryRun) {
    const reason =
      phase === "workspace"
        ? "Dry run: would transfer ownership now (Workspace)"
        : phase === "phase1"
          ? "Dry run: would add target as pending owner"
          : "Dry run: would accept pending ownership as the target account";
    return { status: "dry-run", reason, permissionId: item.permissionId || "" };
  }
  if (phase === "workspace") return workspaceTransfer(item, targetEmail);
  if (phase === "phase1") return phase1PendingOwner(item, targetEmail);
  if (phase === "phase2") return phase2Accept(item, targetEmail);
  throw new Error(`Unknown phase: ${phase}`);
}

/**
 * Sequential processor. Continues after per-item errors. Honors pause/cancel
 * flags on the controller. Saves resumable state after every item.
 */
export async function runQueue({
  state,
  controller,
  onProgress,
  phase,
  targetEmail,
  dryRun,
}) {
  const items = phase === "phase2" && state.pendingTransfers?.length
    ? state.pendingTransfers
    : state.queue || [];

  state.status = "running";
  state.phase = dryRun ? "dry-run" : phase;
  state.dryRun = dryRun;
  state.startedAt = state.startedAt || Date.now();
  await saveTransferState(state);
  controller.cancelled = false;

  for (let i = state.cursor; i < items.length; i += 1) {
    if (controller.cancelled) {
      state.status = "cancelled";
      await saveTransferState(state);
      return state;
    }
    if (controller.paused && !controller.cancelled) {
      state.status = "paused";
      await saveTransferState(state);
      if (onProgress) onProgress(state);
    }
    while (controller.paused && !controller.cancelled) {
      await sleep(200);
    }
    if (controller.cancelled) {
      state.status = "cancelled";
      await saveTransferState(state);
      return state;
    }

    const item = items[i];
    state.status = "running";
    state.currentName = item.name;
    await saveTransferState(state);
    if (onProgress) onProgress(state);

    let outcome;
    try {
      outcome = await processOne(item, { phase, targetEmail, dryRun });
    } catch (error) {
      outcome = {
        status: "failed",
        reason: explainError(error, { phase }),
        error: error.message,
      };
    }

    const result = {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      isFolder: item.isFolder,
      status: outcome.status,
      reason: outcome.reason || "",
      permissionId: outcome.permissionId || "",
      error: outcome.error || "",
      phase,
    };
    state.results.push(result);

    if (outcome.pending && outcome.permissionId) {
      state.pendingTransfers.push({
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        isFolder: item.isFolder,
        permissionId: outcome.permissionId,
      });
    }

    state.cursor = i + 1;
    await saveTransferState(state);
    if (onProgress) onProgress(state);
    if (!dryRun) await sleep(MUTATION_GAP_MS);
  }

  state.status = "done";
  state.currentName = "";
  await saveTransferState(state);
  if (onProgress) onProgress(state);
  return state;
}

export function createController() {
  return { paused: false, cancelled: false };
}
