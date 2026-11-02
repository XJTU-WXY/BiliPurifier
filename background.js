function grantSessionAccess() {
  if (!chrome.storage || !chrome.storage.session || !chrome.storage.session.setAccessLevel) return;
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
}

grantSessionAccess();
chrome.runtime.onInstalled.addListener(grantSessionAccess);
chrome.runtime.onStartup.addListener(grantSessionAccess);
