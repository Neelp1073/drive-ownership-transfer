/**
 * App-wide constants. The target email is a default only — the user can
 * change it in the UI. Never put OAuth client secrets or tokens here.
 */
export const DEFAULT_TARGET_EMAIL = "REPLACE_WITH_THE_NEW_ACCOUNT_EMAIL";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/** Full Drive scope is required to list every owned file and change owners. */
export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
].join(" ");

export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Sequential by default. Keep this at 1 unless you raise Drive quotas. */
export const TRANSFER_CONCURRENCY = 1;

/** Pause between mutating API calls to reduce sharing-rate-limit errors. */
export const MUTATION_GAP_MS = 400;

export const MAX_RETRIES = 6;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 32000;

export const FILES_PAGE_SIZE = 100;

export const STORAGE_KEYS = {
  SETTINGS: "settings",
  AUTH: "auth",
  TRANSFER: "transferState",
};

export const PLACEHOLDER_CLIENT_ID = "YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com";
export const PLACEHOLDER_TARGET = "REPLACE_WITH_THE_NEW_ACCOUNT_EMAIL";

/** Chrome-extension OAuth client (used by chrome.identity.getAuthToken). */
export const CHROME_EXTENSION_CLIENT_ID =
  "542515017914-0c133gqipk1gllg0i222pcvfd9187nrl.apps.googleusercontent.com";

/** Web OAuth client (used by launchWebAuthFlow). */
export const WEB_CLIENT_ID =
  "542515017914-b54dhnh4ioocvn93g52mdp0v5is7qnqm.apps.googleusercontent.com";
