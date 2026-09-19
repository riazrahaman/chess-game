// Shell — hash-routed site shell (Wave 2, roadmap R1).
//
// Pure display/navigation layer: it shows and hides `[data-view]` sections,
// renders the nav, and lets feature modules register a view. It never touches
// game state (Gate 4) — every view still reads referee/analysis output and
// mutates only through /api/*.
//
// View contract (used by ui-puzzles.js, ui-compete.js, ui-analysis.js, …):
//
//   Shell.registerView({
//     id: 'puzzles',            // route is #/puzzles; section is [data-view="puzzles"]
//     title: 'Puzzles',         // nav label
//     order: 30,                // nav ordering (lower = further left)
//     nav: true,                // false = reachable by route only
//     mount(el, params) {},     // called on first navigation; el is the section
//     show(el, params) {},      // optional: every navigation after mount
//     hide(el) {}               // optional: when navigating away
//   });
//
// Routes: `#/` (home), `#/<id>`, `#/<id>?key=value`. Non-route hashes such as
// the skip-link's `#workspace` are ignored so in-page anchors keep working.
(function () {
  'use strict';

  const KNOWN_VIEWS = [
    { id: 'home', title: 'Home', order: 0 },
    { id: 'play', title: 'Play', order: 10 },
    { id: 'analysis', title: 'Analysis', order: 20 },
    { id: 'puzzles', title: 'Puzzles', order: 30 },
    { id: 'coordinates', title: 'Coordinates', order: 35 },
    { id: 'library', title: 'Library', order: 40 },
    { id: 'compete', title: 'Compete', order: 50 },
    { id: 'me', title: 'Profile', order: 60 }
  ];

  // Captured before ui.js rewrites "/" to "/game/<room>" via replaceState, so a
  // plain visit lands on Home while shared room links land on the board.
  const initialPath = (typeof window !== 'undefined' && window.location) ? window.location.pathname : '/';
  const views = new Map();
  const mounted = new Set();
  let currentId = null;
  const listeners = new Set();

  function parseHash(hash) {
    const h = typeof hash === 'string' ? hash : '';
    if (!h.startsWith('#/')) return null;
    const [pathPart, query] = h.slice(2).split('?');
    const id = pathPart.replace(/\/+$/, '') || 'home';
    const params = {};
    if (query) {
      for (const pair of query.split('&')) {
        if (!pair) continue;
        const [k, v] = pair.split('=');
        params[decodeURIComponent(k)] = v === undefined ? true : decodeURIComponent(v);
      }
    }
    return { id, params };
  }

  function sectionFor(id) {
    if (typeof document === 'undefined') return null;
    return document.querySelector(`[data-view="${id}"]`);
  }

  function ensureSection(id) {
    let el = sectionFor(id);
    if (el || typeof document === 'undefined') return el;
    const host = document.getElementById('views') || document.body;
    el = document.createElement('section');
    el.className = 'shell-view';
    el.setAttribute('data-view', id);
    el.hidden = true;
    host.appendChild(el);
    return el;
  }

  function renderNav() {
    if (typeof document === 'undefined') return;
    const nav = document.getElementById('shell-nav');
    if (!nav) return;
    const entries = [...views.values()].filter(v => v.nav !== false).sort((a, b) => a.order - b.order);
    nav.innerHTML = '';
    for (const v of entries) {
      const a = document.createElement('a');
      a.href = '#/' + (v.id === 'home' ? '' : v.id);
      a.textContent = v.title;
      a.setAttribute('data-nav', v.id);
      if (v.id === currentId) a.setAttribute('aria-current', 'page');
      nav.appendChild(a);
    }
  }

  function placeholder(el, view) {
    if (!el || el.childElementCount > 0) return;
    const p = document.createElement('p');
    p.className = 'shell-placeholder supporting-copy';
    p.textContent = `${view.title} is not available yet.`;
    el.appendChild(p);
  }

  function show(id, params) {
    const view = views.get(id) || views.get('home');
    if (!view) return;
    const nextId = view.id;
    if (currentId && currentId !== nextId) {
      const prev = views.get(currentId);
      const prevEl = sectionFor(currentId);
      if (prev && typeof prev.hide === 'function') {
        try { prev.hide(prevEl); } catch (e) { console.error('shell: hide failed', e); }
      }
      if (prevEl) prevEl.hidden = true;
    }
    // Hide every other view (the play <main> is visible in static markup).
    document.querySelectorAll('[data-view]').forEach(sec => {
      if (sec.getAttribute('data-view') !== nextId) sec.hidden = true;
    });
    const el = ensureSection(nextId);
    if (el) el.hidden = false;
    if (!mounted.has(nextId)) {
      mounted.add(nextId);
      if (typeof view.mount === 'function') {
        try { view.mount(el, params || {}); } catch (e) { console.error('shell: mount failed for ' + nextId, e); }
      } else {
        placeholder(el, view);
      }
    }
    if (typeof view.show === 'function') {
      try { view.show(el, params || {}); } catch (e) { console.error('shell: show failed for ' + nextId, e); }
    }
    currentId = nextId;
    if (typeof document !== 'undefined') {
      document.body.setAttribute('data-shell-view', nextId);
      document.title = (nextId === 'home' ? 'Chess' : view.title + ' · Chess');
    }
    renderNav();
    for (const fn of listeners) {
      try { fn({ id: nextId, params: params || {} }); } catch (_) {}
    }
  }

  function route() {
    if (typeof window === 'undefined') return;
    const parsed = parseHash(window.location.hash);
    if (!parsed) {
      // No route yet: pages can pick their landing view (ui.js sets 'play' for
      // /game/<room> URLs so shared links open on the board).
      if (!currentId) show(initialPath.startsWith('/game/') ? 'play' : 'home', {});
      return; // in-page anchor (#workspace etc.): leave the current view alone
    }
    show(parsed.id, parsed.params);
  }

  const Shell = {
    KNOWN_VIEWS,
    parseHash,
    registerView(def) {
      if (!def || typeof def.id !== 'string' || !def.id) throw new Error('registerView: id required');
      const known = KNOWN_VIEWS.find(k => k.id === def.id);
      const view = Object.assign({ title: def.id, order: 100, nav: true }, known || {}, def);
      const previous = views.get(view.id);
      views.set(view.id, view);
      // A feature module registering a real mount() over a placeholder (or
      // registering after first paint) must take over the section now.
      const upgrading = mounted.has(view.id) && typeof def.mount === 'function' && !(previous && typeof previous.mount === 'function');
      if (upgrading) {
        const el = sectionFor(view.id);
        if (el) el.querySelectorAll('.shell-placeholder').forEach(n => n.remove());
        mounted.delete(view.id);
      }
      if (currentId === view.id && !mounted.has(view.id)) {
        currentId = null;
        show(view.id, parseHash(window.location.hash)?.params || {});
      } else {
        renderNav();
      }
      return view;
    },
    navigate(id, params) {
      if (typeof window === 'undefined') return;
      let hash = '#/' + (id === 'home' ? '' : id);
      if (params && Object.keys(params).length) {
        hash += '?' + Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
      }
      if (window.location.hash === hash) route(); else window.location.hash = hash;
    },
    current() { return currentId; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    views() { return [...views.values()]; },
    isMounted(id) { return mounted.has(id); }
  };

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    // Register the built-in views that already have markup: play (the existing
    // board page) and home. Feature modules register the rest.
    Shell.registerView({ id: 'play' });
    Shell.registerView({
      id: 'home',
      mount(el) {
        const cards = el.querySelectorAll('[data-home-action]');
        cards.forEach(card => {
          card.addEventListener('click', ev => {
            ev.preventDefault();
            const action = card.getAttribute('data-home-action');
            if (action === 'bot') {
              Shell.navigate('play', { bot: 1 });
            } else if (action === 'friend') {
              Shell.navigate('play', { invite: 1 });
            } else if (action === 'puzzles') {
              Shell.navigate('puzzles');
            } else if (action === 'analysis') {
              Shell.navigate('analysis');
            }
          });
        });
      }
    });
    for (const k of KNOWN_VIEWS) {
      if (!views.has(k.id)) Shell.registerView({ id: k.id });
    }
    // index.html carries <base href="/"> (so assets resolve under /game/<room>),
    // which turns every href="#/x" into a full navigation to "/#/x". Intercept
    // in-document hash links and set location.hash directly instead.
    document.addEventListener('click', ev => {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const a = ev.target && ev.target.closest ? ev.target.closest('a[href^="#"]') : null;
      if (!a) return;
      ev.preventDefault();
      const href = a.getAttribute('href');
      if (window.location.hash === href) route(); else window.location.hash = href;
    });
    window.addEventListener('hashchange', route);
    const boot = () => route();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
    window.Shell = Shell;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Shell;
})();
