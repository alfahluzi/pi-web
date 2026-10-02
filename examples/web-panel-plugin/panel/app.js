// Minimal panel ↔ pi-web bridge.
//
// On load the host appends ?cwd=&sessionId=&theme= to this document's URL and
// also pushes the same values over postMessage, so read the query params for the
// first paint and listen for later workspace switches.

const params = new URLSearchParams(location.search);
let contextMessages = 0;

const set = (id, value) => {
  document.getElementById(id).textContent = value ?? "(none)";
};

set("cwd", params.get("cwd"));
set("session", params.get("sessionId"));
set("theme", params.get("theme"));

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object" || data.type !== "pi-web:context") return;
  contextMessages += 1;
  set("cwd", data.cwd);
  set("session", data.sessionId);
  set("theme", data.theme);
  set("seen", String(contextMessages));
});

// Ask the host for the current context (useful if this script loads late).
window.parent.postMessage({ type: "pi-web:ready" }, "*");

// Ask pi-web to open a workspace-relative path in the right panel. Relative
// paths are resolved against the active workspace; absolute paths pass through.
document.getElementById("open-file").addEventListener("click", () => {
  window.parent.postMessage({ type: "pi-web:open-file", path: "package.json" }, "*");
  document.getElementById("status").textContent = "sent pi-web:open-file";
});

// Append text to the chat composer.
document.getElementById("insert-prompt").addEventListener("click", () => {
  window.parent.postMessage({ type: "pi-web:insert-prompt", text: "Hello from the example panel" }, "*");
  document.getElementById("status").textContent = "sent pi-web:insert-prompt";
});

// Rename this tab (the manifest title is only the default).
document.getElementById("set-title").addEventListener("click", () => {
  window.parent.postMessage({ type: "pi-web:set-title", title: "Renamed Panel" }, "*");
  document.getElementById("status").textContent = "sent pi-web:set-title";
});
