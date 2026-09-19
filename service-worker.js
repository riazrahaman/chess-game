'use strict';

const CACHE_NAME = 'chess-ui-v1';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/src/engine.js',
  '/src/pieces.js',
  '/src/stockfish-worker.js',
  '/vendor/stockfish/stockfish-19-lite-single.js',
  '/vendor/stockfish/stockfish-19-lite-single.wasm',
  '/src/move-review.js',
  '/src/ai-coach.js',
  '/src/game-report.js',
  '/src/accessibility-voice.js',
  '/src/openings-db.js',
  '/src/game-archive.js',
  '/src/ui-sound.js',
  '/src/ui-theme.js',
  '/src/ui-annotations.js',
  '/src/ui-archive.js',
  '/src/eval-graph.js',
  '/src/masters-db.js',
  '/src/acpl.js',
  '/src/puzzle-racer.js',
  '/src/a11y-text-entry.js',
  '/src/a11y-gestures.js',
  '/src/voice-intents.js',
  '/src/chess960.js',
  '/src/time-control.js',
  '/src/tablebase.js',
  '/src/arena.js',
  '/src/social-graph.js',
  '/src/chat-upgrades.js',
  '/src/correspondence.js',
  '/src/personality-bots.js',
  '/src/pov-export.js',
  '/src/embed-viewer.js',
  '/src/variants.js',
  '/src/i18n.js',
  '/src/ui-auth.js',
  '/src/shell.js',
  '/src/ui-puzzles.js',
  '/src/ui-settings.js',
  '/src/ui-compete.js',
  '/src/ui-profile.js',
  '/src/ui-analysis.js',
  '/src/ui-insights.js',
  '/src/ui.js',
  '/manifest.webmanifest',
  '/assets/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Live data (referee state, SSE, auth, puzzles, lobby) must never be served
  // from cache: it is referee-authoritative and changes every move. Only the
  // static shell is cache-first.
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/api/')) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('', { status: 503, statusText: 'offline' });
      });
    })
  );
});
