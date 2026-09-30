/**
 * Map Drive / OAuth API failures to messages a person can act on.
 */
export function explainError(error, context = {}) {
  const status = error.status || error.code;
  const reason = extractReason(error);
  const message = (error.message || "").toLowerCase();
  const raw = error.message || String(error);

  if (status === 401 || reason === "authError") {
    return "Sign-in expired. Sign in again, then retry.";
  }

  if (
    status === 429 ||
    reason === "rateLimitExceeded" ||
    reason === "userRateLimitExceeded" ||
    reason === "sharingRateLimitExceeded"
  ) {
    return "Google Drive rate limit or quota was hit. The tool backs off and retries automatically. If this keeps happening, wait a few minutes and click Resume.";
  }

  if (reason === "ownershipChangeAcrossDomainNotPermitted" || /different domain|different organization|another domain/.test(message)) {
    return "Google blocked this because the source and target accounts are in different Google Workspace organizations or domains. Ownership can only move within the same organization.";
  }

  if (
    reason === "userCannotOwnFile" ||
    /cannot transfer ownership.*outside|outside of your organization|consumer.*workspace|gmail.*workspace|not a member of the.*domain/.test(message)
  ) {
    return "Google does not allow transferring ownership between a personal Gmail account and a Google Workspace account, or to a user who cannot own this item.";
  }

  if (reason === "ownershipChangingAcrossMyDriveAndTeamDriveNotPermitted" || /shared drive|team drive/.test(message)) {
    return "This item is on a Shared Drive. Shared Drive files belong to the organization, not to a person, so individual ownership cannot be transferred.";
  }

  if (reason === "insufficientFilePermissions" || reason === "fileNotWritable" || /not.*owner|only the owner/.test(message)) {
    return "This item is owned by someone else, or the signed-in account does not have permission to change its owner.";
  }

  if (reason === "forbidden" && /pending|accept/.test(message)) {
    return "The target account has not accepted this pending ownership transfer yet. Sign in as the target account and run Phase 2.";
  }

  if (context.phase === "phase2" && (status === 403 || status === 404)) {
    return "The target account could not accept this transfer. The invitation may still be pending, may have been declined, or this account may not be the pending owner.";
  }

  if (reason === "shareIneligible" || reason === "cannotModifyInheritedPermission" || /cannot be shared/.test(message)) {
    return "Google reports that this item cannot be shared or have its ownership transferred.";
  }

  if (status === 400 && /pendingOwner|transferOwnership/.test(message + reason)) {
    return "This ownership change is not allowed for these two accounts. Personal Gmail uses a pending-owner invite; Workspace uses a same-organization transfer. Mixed Gmail/Workspace and cross-organization transfers are blocked by Google.";
  }

  if (status >= 500) {
    return `Google Drive had a temporary server error (${status}). The tool retries automatically.`;
  }

  return raw || "Unknown error from the Google Drive API.";
}

export function extractReason(error) {
  const errors = error.details?.error?.errors || error.details?.errors;
  if (Array.isArray(errors) && errors[0]?.reason) return errors[0].reason;
  return error.details?.error?.status || error.reason || "";
}

export function isRetryable(error) {
  const status = error.status;
  const reason = extractReason(error);
  if (status === 429 || status >= 500) return true;
  return (
    reason === "rateLimitExceeded" ||
    reason === "userRateLimitExceeded" ||
    reason === "sharingRateLimitExceeded" ||
    reason === "backendError" ||
    reason === "internalError"
  );
}

export class ApiError extends Error {
  constructor(message, { status, details, reason } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
    this.reason = reason;
  }
}
