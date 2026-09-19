'use strict';
// ui-settings.js — Settings view (Wave 2, roadmap R1: "Profile / Settings absorbs
// the header toggles"). Loaded as a classic <script> after shell.js and before
// ui.js. Pure display layer: it never reads or writes game state (Gate 4).
//
// The board-theme select, dark-mode, sound, voice and blind-mode toggles keep
// their ids and their handlers (ui-theme.js / ui-sound.js / ui.js look them up
// by id at load and bind onclick/onchange). Moving a DOM node keeps its
// listeners, so this module only *relocates* the existing nodes: while the
// Settings view is showing they sit in labelled rows here; when the user
// navigates away they return to #theme-bar in the Play view's "Accessibility &
// display" card. No control is ever duplicated, so every id stays unique.

const SETTINGS_VIEW_ID = 'settings';

const SETTINGS_GROUPS = [
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'How the board and the interface look on this device.',
    rows: [
      {
        id: 'theme-board-select',
        title: 'Board theme',
        description: 'Classic, Slate, Walnut or a colour-blind-safe palette. Saved in this browser.'
      },
      {
        id: 'theme-mode-toggle',
        title: 'Colour mode',
        description: 'Switch the whole interface between light and dark.'
      }
    ]
  },
  {
    id: 'sound',
    title: 'Sound & haptics',
    description: 'Move, capture, check and game-end cues.',
    rows: [
      {
        id: 'sound-toggle',
        title: 'Sound effects',
        description: 'Short synthesised cues; vibration on supported phones.'
      }
    ]
  },
  {
    id: 'accessibility',
    title: 'Accessibility',
    description: 'Spoken announcements and non-visual board navigation. Moves can also be typed or spoken from the Play view.',
    rows: [
      {
        id: 'voice-toggle',
        title: 'Voice announcements',
        description: 'Read each move, check and result aloud. Shortcut: V.'
      },
      {
        id: 'blind-mode-toggle',
        title: 'Blind mode',
        description: 'Arrow keys (or swipes on touch screens) walk the board and every square is described. Shortcut: B.'
      }
    ],
    shortcuts: [
      ['V', 'Voice announcements'],
      ['B', 'Blind mode'],
      ['M', 'Microphone: speak a move'],
      ['F', 'Flip board'],
      ['Z', 'Toggle Zen mode (distraction-free)'],
      ['Esc', 'Cancel selection / premove']
    ]
  }
];

function settingsControlIds() {
  const ids = [];
  for (const group of SETTINGS_GROUPS) for (const row of group.rows) ids.push(row.id);
  return ids;
}

function settingsHomeBar() {
  return typeof document !== 'undefined' ? document.getElementById('theme-bar') : null;
}

function buildSettingsView(el) {
  el.innerHTML = '';
  el.classList.add('settings-view');
  const h2 = document.createElement('h2');
  h2.id = 'settings-title';
  h2.textContent = 'Settings';
  el.setAttribute('aria-labelledby', 'settings-title');
  el.removeAttribute('aria-label');
  el.appendChild(h2);
  const intro = document.createElement('p');
  intro.className = 'supporting-copy';
  intro.textContent = 'Preferences are stored in this browser only. Game state always lives with the referee.';
  el.appendChild(intro);

  for (const group of SETTINGS_GROUPS) {
    const section = document.createElement('section');
    section.className = 'settings-group';
    section.setAttribute('data-settings-group', group.id);
    const h3 = document.createElement('h3');
    h3.textContent = group.title;
    section.appendChild(h3);
    const desc = document.createElement('p');
    desc.className = 'supporting-copy';
    desc.textContent = group.description;
    section.appendChild(desc);
    for (const row of group.rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'settings-row';
      const text = document.createElement('div');
      text.className = 'settings-row-text';
      const strong = document.createElement('strong');
      strong.textContent = row.title;
      strong.id = 'settings-label-' + row.id;
      const span = document.createElement('span');
      span.textContent = row.description;
      text.appendChild(strong);
      text.appendChild(span);
      const control = document.createElement('div');
      control.className = 'settings-row-control';
      control.setAttribute('data-settings-slot', row.id);
      rowEl.appendChild(text);
      rowEl.appendChild(control);
      section.appendChild(rowEl);
    }
    if (group.shortcuts) {
      const list = document.createElement('ul');
      list.className = 'settings-shortcuts';
      list.setAttribute('aria-label', 'Keyboard shortcuts');
      for (const [key, label] of group.shortcuts) {
        const li = document.createElement('li');
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        li.appendChild(kbd);
        li.appendChild(document.createTextNode(' ' + label));
        list.appendChild(li);
      }
      section.appendChild(list);
    }
    el.appendChild(section);
  }
}

// Move the live controls into their Settings rows (listeners travel with them).
function adoptSettingsControls(el) {
  for (const id of settingsControlIds()) {
    const node = document.getElementById(id);
    const slot = el.querySelector('[data-settings-slot="' + id + '"]');
    if (!node || !slot || node.parentNode === slot) continue;
    slot.appendChild(node);
    node.setAttribute('aria-labelledby', 'settings-label-' + id);
  }
}

// Return the controls to #theme-bar in the Play view, in their original order.
function releaseSettingsControls() {
  const bar = settingsHomeBar();
  if (!bar) return;
  for (const id of settingsControlIds()) {
    const node = document.getElementById(id);
    if (!node || node.parentNode === bar) continue;
    bar.appendChild(node);
    node.removeAttribute('aria-labelledby');
  }
}

function initSettingsView() {
  if (typeof window === 'undefined' || !window.Shell || typeof window.Shell.registerView !== 'function') return null;
  return window.Shell.registerView({
    id: SETTINGS_VIEW_ID,
    title: 'Settings',
    order: 70,
    nav: true,
    mount(el) {
      buildSettingsView(el);
      adoptSettingsControls(el);
    },
    show(el) {
      adoptSettingsControls(el);
    },
    hide() {
      releaseSettingsControls();
    }
  });
}

initSettingsView();

if (typeof window !== 'undefined') {
  window.UiSettings = { SETTINGS_GROUPS, settingsControlIds, initSettingsView, adoptSettingsControls, releaseSettingsControls };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SETTINGS_VIEW_ID, SETTINGS_GROUPS, settingsControlIds, buildSettingsView, adoptSettingsControls, releaseSettingsControls, initSettingsView };
}
