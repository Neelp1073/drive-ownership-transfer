import { FOLDER_MIME } from "./config.js";

export const SKIP_REASONS = {
  SHARED_DRIVE: "Shared Drive item — individual ownership cannot be transferred",
  NOT_OWNER: "Not owned by the signed-in account",
  CANNOT_SHARE: "Google reports this item cannot be shared",
  CANNOT_TRANSFER: "Google reports this item cannot have ownership transferred",
};

export function classifyItem(file, { mode }) {
  const isFolder = file.mimeType === FOLDER_MIME;
  const base = {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    isFolder,
    ownedByMe: file.ownedByMe === true,
    driveId: file.driveId || null,
    canShare: file.capabilities?.canShare !== false,
    canTransferOwnership: null,
    parents: file.parents || [],
    ownerEmails: (file.owners || []).map((o) => o.emailAddress).filter(Boolean),
  };

  if (file.driveId) {
    return { ...base, eligible: false, skipReason: SKIP_REASONS.SHARED_DRIVE, skipCode: "shared_drive" };
  }
  const owned = file.ownedByMe === true || (file.owners || []).some((o) => o.me);
  if (!owned) {
    return { ...base, eligible: false, skipReason: SKIP_REASONS.NOT_OWNER, skipCode: "not_owner" };
  }
  if (file.capabilities && file.capabilities.canShare === false) {
    return { ...base, eligible: false, skipReason: SKIP_REASONS.CANNOT_SHARE, skipCode: "cannot_share" };
  }
  // Immediate owner-role transfer is Workspace-only. Consumer Gmail uses pendingOwner.
  // canTransferOwnership is not returned by files.list, so we do not skip on it here.
  return { ...base, eligible: true, skipReason: null, skipCode: null };
}

export async function scanOwnedItems({ iterate, mode, onProgress }) {
  const eligible = [];
  const skipped = [];
  let seen = 0;
  for await (const file of iterate((page) => {
    seen += page.length;
    if (onProgress) onProgress({ seen, pageSize: page.length });
  })) {
    const classified = classifyItem(file, { mode });
    if (classified.eligible) eligible.push(classified);
    else skipped.push(classified);
  }
  return { eligible, skipped, seen };
}

export function countSkipReasons(skipped) {
  const counts = {};
  for (const item of skipped) {
    const key = item.skipCode || "other";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
