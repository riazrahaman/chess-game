'use strict';
// sw-register.js — service-worker registration (Wave 3, roadmap D4 / kanban
// w3-csp-inline-hash). This used to be the only inline <script> in index.html;
// externalising it lets server.js drop 'unsafe-inline' from CSP script-src.
// Loaded last by index.html as a plain <script src>; nothing else depends on it.
window.addEventListener('load', function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/service-worker.js').catch(function () { /* offline shell is optional */ });
});
