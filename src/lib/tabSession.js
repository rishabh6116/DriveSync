// window.name persists across normal navigations within the SAME tab —
// just like sessionStorage. But unlike sessionStorage, Chrome does NOT
// restore window.name when a closed tab is reopened (Ctrl+Shift+T) or a
// previous browser session is restored. That difference is exactly what
// we need: if sessionStorage claims "authenticated" but this marker is
// missing, the tab was closed and reopened — treat it as logged out.

const TAB_MARKER = 'drivesync_active_tab';

export function markTabActive() {
  window.name = TAB_MARKER;
}

export function isSameTabSession() {
  return window.name === TAB_MARKER;
}

export function clearTabMarker() {
  window.name = '';
}
