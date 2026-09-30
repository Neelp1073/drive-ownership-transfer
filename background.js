// MV3 service worker. Transfer work runs in app.html so it is not killed
// when this worker goes idle. Clicking the toolbar icon still opens the popup.

let authFlowPending = false;

chrome.runtime.onInstalled.addListener(() => {
  console.log("Drive Bulk Ownership Transfer installed.");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "LAUNCH_WEB_AUTH_FLOW") return undefined;
  if (authFlowPending) {
    sendResponse({
      error:
        "Brave still has a stuck sign-in from the last attempt. Open brave://extensions, click Reload on this extension, reopen the transfer tool, then sign in once.",
    });
    return true;
  }
  authFlowPending = true;
  chrome.identity
    .launchWebAuthFlow({ url: message.url, interactive: true })
    .then((redirectUrl) => {
      sendResponse({ redirectUrl: redirectUrl || "" });
    })
    .catch((error) => {
      sendResponse({ error: error?.message || String(error) });
    })
    .finally(() => {
      authFlowPending = false;
    });
  return true;
});
