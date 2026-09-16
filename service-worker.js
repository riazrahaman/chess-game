'use strict';

const CACHE_NAME = 'chess-ui-v1';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/engine.js',
  '/pieces.js',
  '/move-review.js',
  '/ai-coach.js',
  '/game-report.js',
  '/accessibility-voice.js',
  '/openings-db.js',
  '/game-archive.js',
  '/ui-sound.js',
  '/ui-theme.js',
  '/ui-annotations.js',
  '/ui-archive.js',
  '/eval-graph.js',
  '/masters-db.js',
  '/acpl.js',
  '/puzzle-racer.js',
  '/a11y-text-entry.js',
  '/a11y-gestures.js',
  '/voice-intents.js',
  '/chess960.js',
  '/ui.js',
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
