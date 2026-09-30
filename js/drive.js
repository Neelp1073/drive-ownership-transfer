import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  DRIVE_API,
  FOLDER_MIME,
  MAX_RETRIES,
} from "./config.js";
import { getValidAccessToken } from "./auth.js";
import { ApiError, extractReason, isRetryable } from "./errors.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 250);
  return exp + jitter;
}

async function parseBody(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text } };
  }
}

/**
 * Drive API v3 helper with exponential backoff for quota and 5xx errors.
 */
export async function driveRequest(path, { method = "GET", query, body, retryAuth = true } = {}) {
  const url = new URL(path.startsWith("http") ? path : `${DRIVE_API}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const token = await getValidAccessToken();
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await parseBody(res);

    if (res.ok) return data;

    const message = data.error?.message || res.statusText || "Drive API request failed";
    lastError = new ApiError(message, {
      status: res.status,
      details: data,
      reason: extractReason({ details: data }),
    });

    if (res.status === 401 && retryAuth && attempt === 0) {
      lastError = new ApiError("Sign-in expired. Sign in again, then click Resume.", {
        status: 401,
        details: data,
      });
      throw lastError;
    }

    if (!isRetryable(lastError) || attempt === MAX_RETRIES) {
      throw lastError;
    }
    await sleep(backoffMs(attempt));
  }
  throw lastError;
}

export async function getAboutUser() {
  return driveRequest("/about", {
    query: { fields: "user(displayName,emailAddress,permissionId)" },
  });
}

/**
 * List every non-trashed item in My Drive owned by the signed-in user.
 * Shared Drive files are requested so we can report them, then skipped.
 */
export async function* iterateOwnedFiles(onPage) {
  let pageToken;
  do {
    const data = await driveRequest("/files", {
      query: {
        q: "trashed = false and 'me' in owners",
        pageSize: 100,
        pageToken,
        corpora: "user",
        spaces: "drive",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        fields: [
          "nextPageToken,",
          "files(",
          "id,name,mimeType,ownedByMe,driveId,trashed,shared,parents,",
          "capabilities(canShare),",
          "owners(displayName,emailAddress,me)",
          ")",
        ].join("")
      },
    });
    const files = data.files || [];
    if (onPage) onPage(files, data.nextPageToken);
    for (const file of files) yield file;
    pageToken = data.nextPageToken;
  } while (pageToken);
}

/**
 * Recursively list owned, non-trashed files and folders inside a folder.
 */
export async function listOwnedDescendants(folderId) {
  const collected = [];
  const seen = new Set();
  const stack = [folderId];
  while (stack.length) {
    const parent = stack.pop();
    if (!/^[a-zA-Z0-9_-]+$/.test(parent)) continue;
    let pageToken;
    do {
      const data = await driveRequest("/files", {
        query: {
          q: `'${parent}' in parents and trashed = false and 'me' in owners`,
          pageSize: 1000,
          pageToken,
          corpora: "user",
          spaces: "drive",
          fields: [
            "nextPageToken,",
            "files(id,name,mimeType,ownedByMe,driveId,trashed,shared,parents,",
            "capabilities(canShare),owners(displayName,emailAddress,me))",
          ].join(""),
        },
      });
      for (const file of data.files || []) {
        if (!file?.id || seen.has(file.id)) continue;
        seen.add(file.id);
        collected.push(file);
        if (file.mimeType === FOLDER_MIME) stack.push(file.id);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
  return collected;
}

export async function getFile(fileId) {
  const file = await driveRequest(`/files/${encodeURIComponent(fileId)}`, {
    query: {
      supportsAllDrives: "true",
      fields: [
        "id,name,mimeType,ownedByMe,driveId,trashed,shared,parents,",
        "capabilities(canShare),owners(displayName,emailAddress,me),",
        "shortcutDetails(targetId,targetMimeType)",
      ].join(""),
    },
  });
  if (file.mimeType === "application/vnd.google-apps.shortcut" && file.shortcutDetails?.targetId) {
    return getFile(file.shortcutDetails.targetId);
  }
  return file;
}

export async function listPermissions(fileId) {
  const data = await driveRequest(`/files/${encodeURIComponent(fileId)}/permissions`, {
    query: {
      supportsAllDrives: "false",
      fields: "permissions(id,type,emailAddress,role,pendingOwner,deleted)",
    },
  });
  return data.permissions || [];
}

export async function createPermission(fileId, permission, query = {}) {
  return driveRequest(`/files/${encodeURIComponent(fileId)}/permissions`, {
    method: "POST",
    query: {
      supportsAllDrives: "false",
      ...query,
    },
    body: permission,
  });
}

export async function patchPermission(fileId, permissionId, permission, query = {}) {
  return driveRequest(
    `/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
    {
      method: "PATCH",
      query: {
        supportsAllDrives: "false",
        ...query,
      },
      body: permission,
    }
  );
}

export function findPermissionForEmail(permissions, email) {
  const needle = (email || "").toLowerCase();
  return (permissions || []).find(
    (p) => (p.emailAddress || "").toLowerCase() === needle && !p.deleted
  );
}
