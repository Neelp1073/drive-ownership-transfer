import {
  OAUTH_AUTH_URL,
  OAUTH_SCOPES,
  OAUTH_TOKEN_URL,
  OAUTH_REVOKE_URL,
  PLACEHOLDER_CLIENT_ID,
  STORAGE_KEYS,
  USERINFO_URL,
  WEB_CLIENT_ID,
} from "./config.js";
import { ApiError } from "./errors.js";

function getAuthTokenFromIdentity(interactive) {
  if (!chrome.identity?.getAuthToken) {
    return Promise.reject(new Error("chrome.identity.getAuthToken is not available"));
  }
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err || !token) reject(new Error(err?.message || "Identity token request failed"));
      else resolve(token);
    });
  });
}

function storageGet(key) {
  return chrome.storage.local.get(key).then((r) => r[key]);
}

function storageSet(key, value) {
  return chrome.storage.local.set({ [key]: value });
}

function bytesToBase64Url(bytes) {
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Base64Url(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return bytesToBase64Url(new Uint8Array(hash));
}

export function getRedirectUri() {
  // Brave / Chromium identity redirect, e.g. https://<extension-id>.chromiumapp.org/
  return chrome.identity.getRedirectURL();
}

export function getExtensionId() {
  return chrome.runtime.id;
}

export async function loadSettings() {
  const settings = (await storageGet(STORAGE_KEYS.SETTINGS)) || {};
  const manifestClient = chrome.runtime.getManifest().oauth2?.client_id || "";
  return {
    clientId: settings.clientId || "",
    targetEmail: settings.targetEmail || "",
    transferMode: settings.transferMode || "auto",
    manifestClientId: manifestClient,
  };
}

export async function saveSettings(partial) {
  const current = (await storageGet(STORAGE_KEYS.SETTINGS)) || {};
  const next = { ...current, ...partial };
  await storageSet(STORAGE_KEYS.SETTINGS, next);
  return next;
}

export async function resolveClientId() {
  const settings = await loadSettings();
  const fromUi = (settings.clientId || "").trim();
  if (fromUi && fromUi !== PLACEHOLDER_CLIENT_ID) return fromUi;
  const fromManifest = (settings.manifestClientId || "").trim();
  if (fromManifest && fromManifest !== PLACEHOLDER_CLIENT_ID) return fromManifest;
  return "";
}

async function saveAuth(auth) {
  await storageSet(STORAGE_KEYS.AUTH, auth);
}

export async function loadAuth() {
  return (await storageGet(STORAGE_KEYS.AUTH)) || null;
}

export async function clearAuth() {
  await chrome.storage.local.remove(STORAGE_KEYS.AUTH);
}

function parseRedirectParams(redirectUrl) {
  const url = new URL(redirectUrl);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const query = url.searchParams;
  return {
    code: query.get("code") || hash.get("code"),
    accessToken: hash.get("access_token") || query.get("access_token"),
    expiresIn: Number(hash.get("expires_in") || query.get("expires_in") || 0),
    error: query.get("error") || hash.get("error"),
    errorDescription: query.get("error_description") || hash.get("error_description"),
  };
}

function explainAuthLaunchError(message, redirectUri) {
  const text = message || "";
  if (/only one web auth flow/i.test(text)) {
    return "Brave still has a stuck sign-in from the last attempt. Open brave://extensions, click Reload on this extension, reopen the transfer tool, then sign in once.";
  }
  if (/authorization page could not be loaded/i.test(text)) {
    return (
      "Brave could not finish Google sign-in (authorization page could not be loaded). " +
      "Close other Google popups, reload this extension on brave://extensions, reopen the transfer tab, and click Sign in once. " +
      `Google Cloud’s Web client must include this redirect URI exactly: ${redirectUri}`
    );
  }
  return text;
}

async function launchAuth(url, redirectUri) {
  let redirectUrl;
  let errorMessage = "";
  let usedBackground = false;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "LAUNCH_WEB_AUTH_FLOW",
      url,
    });
    if (response && (response.error || "redirectUrl" in response)) {
      usedBackground = true;
      if (response.error) errorMessage = response.error;
      else redirectUrl = response.redirectUrl;
    }
  } catch {
    usedBackground = false;
  }
  if (!usedBackground) {
    try {
      redirectUrl = await chrome.identity.launchWebAuthFlow({
        url,
        interactive: true,
      });
    } catch (error) {
      errorMessage = error?.message || String(error);
    }
  }
  if (errorMessage) {
    throw new ApiError(explainAuthLaunchError(errorMessage, redirectUri));
  }
  if (!redirectUrl) {
    throw new ApiError("Sign-in was cancelled or Brave did not return a redirect URL.");
  }
  return parseRedirectParams(redirectUrl);
}

async function signInWithIdentity() {
  const manifestClient = chrome.runtime.getManifest().oauth2?.client_id || "";
  if (!manifestClient || manifestClient === PLACEHOLDER_CLIENT_ID) return null;
  const accessToken = await getAuthTokenFromIdentity(true);
  const user = await fetchUserInfo(accessToken);
  const auth = {
    accessToken,
    refreshToken: null,
    expiresAt: Date.now() + 45 * 60 * 1000,
    clientId: manifestClient,
    user,
    via: "getAuthToken",
  };
  await saveAuth(auth);
  return auth;
}

async function signInImplicit(clientId, { promptSelectAccount, redirectUri }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: OAUTH_SCOPES,
    include_granted_scopes: "true",
  });
  if (promptSelectAccount) params.set("prompt", "select_account");
  const result = await launchAuth(`${OAUTH_AUTH_URL}?${params.toString()}`, redirectUri);
  if (result.error) {
    throw new ApiError(result.errorDescription || result.error);
  }
  if (!result.accessToken) {
    throw new ApiError("Google did not return an access token in the redirect.");
  }
  return {
    accessToken: result.accessToken,
    expiresAt: Date.now() + Math.max(result.expiresIn, 60) * 1000,
    refreshToken: null,
    clientId,
  };
}

/**
 * Sign in via launchWebAuthFlow + a Web OAuth client.
 * Brave mishandles chrome.identity.getAuthToken (Chrome-extension clients),
 * which produces Google's "Custom URI scheme is not supported on Chrome apps".
 * Use one implicit window only — chaining PKCE then implicit makes Brave fail
 * with "Authorization page could not be loaded".
 */
export async function signIn({ promptSelectAccount = true } = {}) {
  const clientId = WEB_CLIENT_ID;
  const redirectUri = getRedirectUri();
  const auth = await signInImplicit(clientId, { promptSelectAccount, redirectUri });
  const user = await fetchUserInfo(auth.accessToken);
  auth.user = user;
  await saveAuth(auth);
  return auth;
}

async function exchangeCode({ clientId, code, verifier, redirectUri }) {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint =
      data.error === "invalid_client" || data.error === "unauthorized_client"
        ? " Use a Desktop or Chrome extension OAuth client, or a Web client whose redirect URI exactly matches the value shown in Setup. This extension never uses a client secret."
        : "";
    throw new ApiError((data.error_description || data.error || "Token exchange failed.") + hint, {
      status: res.status,
      details: data,
    });
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: Date.now() + Math.max(data.expires_in || 3600, 60) * 1000,
    clientId,
  };
}

async function refreshAccessToken(auth) {
  if (!auth?.refreshToken) return null;
  const body = new URLSearchParams({
    client_id: auth.clientId,
    refresh_token: auth.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const next = {
    ...auth,
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max(data.expires_in || 3600, 60) * 1000,
  };
  if (data.refresh_token) next.refreshToken = data.refresh_token;
  await saveAuth(next);
  return next;
}

export async function fetchUserInfo(accessToken) {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error_description || "Could not read the signed-in Google account.", {
      status: res.status,
      details: data,
    });
  }
  return {
    email: data.email,
    name: data.name || data.email,
    // `hd` is present for Google Workspace accounts and absent for consumer Gmail.
    hostedDomain: data.hd || null,
    picture: data.picture || null,
  };
}

export function detectAccountKind(user) {
  if (user?.hostedDomain) return "workspace";
  const email = (user?.email || "").toLowerCase();
  if (email.endsWith("@gmail.com") || email.endsWith("@googlemail.com")) return "consumer";
  // Custom domain without `hd` is still usually Workspace.
  return "workspace";
}

export async function getValidAccessToken() {
  let auth = await loadAuth();
  if (!auth?.accessToken) {
    throw new ApiError("Not signed in.");
  }
  if (auth.expiresAt && Date.now() < auth.expiresAt - 60_000) {
    return auth.accessToken;
  }
  const refreshed = await refreshAccessToken(auth);
  if (refreshed?.accessToken) return refreshed.accessToken;
  if (auth.via === "getAuthToken") {
    try {
      const token = await getAuthTokenFromIdentity(false);
      auth = { ...auth, accessToken: token, expiresAt: Date.now() + 45 * 60 * 1000 };
      await saveAuth(auth);
      return token;
    } catch {
      // Fall through to a re-login error.
    }
  }
  throw new ApiError("Access token expired. Sign in again.");
}

export async function signOut() {
  const auth = await loadAuth();
  if (auth?.accessToken) {
    try {
      await fetch(`${OAUTH_REVOKE_URL}?token=${encodeURIComponent(auth.accessToken)}`, {
        method: "POST",
      });
    } catch {
      // Revoke is best-effort; always clear local tokens.
    }
    try {
      await new Promise((resolve) => {
        chrome.identity.removeCachedAuthToken({ token: auth.accessToken }, resolve);
      });
    } catch {
      // Not used when sign-in went through launchWebAuthFlow.
    }
  }
  await clearAuth();
}
