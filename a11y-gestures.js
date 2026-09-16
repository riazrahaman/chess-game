(function() {
'use strict';

/**
 * a11y-gestures.js — AB2: Touchscreen gestures for blind accessibility mode.
 *
 * Implements swipe-grid navigation with spoken feedback on touch devices so a
 * blind user can move the keyboard cursor by swiping (lichess 2025 NVUI parity).
 * Pure input layer — returns cursor deltas + speaks; never calls makeMove or
 * createInitialBoard, never mutates referee state.
 *
 * Public API:
 *   GestureController
 *   classifySwipe(dx, dy, threshold) — 'left'|'right'|'up'|'down'|'tap'|null
 */

const DEFAULT_THRESHOLD = 40; // px

function classifySwipe(dx, dy, threshold = DEFAULT_THRESHOLD) {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX < threshold && absY < threshold) return 'tap';
  if (absX > absY) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

class GestureController {
  constructor(options = {}) {
    this.threshold = options.threshold || DEFAULT_THRESHOLD;
    this.onSwipe = options.onSwipe || null;      // (direction) => void
    this.onTap = options.onTap || null;          // () => void
    this.enabled = options.enabled !== undefined ? options.enabled : true;
    this._touch = null;
  }

  setEnabled(enabled) {
    this.enabled = enabled !== undefined ? enabled : !this.enabled;
    return this.enabled;
  }

  handleTouchStart(ev) {
    if (!this.enabled) return;
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    this._touch = { x: t.clientX, y: t.clientY, t: Date.now() };
  }

  handleTouchEnd(ev) {
    if (!this.enabled || !this._touch) return null;
    const t = ev.changedTouches && ev.changedTouches[0];
    if (!t) return null;
    const dx = t.clientX - this._touch.x;
    const dy = t.clientY - this._touch.y;
    const dt = Date.now() - this._touch.t;
    this._touch = null;

    const direction = classifySwipe(dx, dy, this.threshold);
    if (direction === 'tap') {
      if (this.onTap) this.onTap();
      return 'tap';
    }
    if (this.onSwipe) this.onSwipe(direction);
    return direction;
  }
}

const A11yGestures = {
  classifySwipe,
  GestureController,
  DEFAULT_THRESHOLD
};

if (typeof window !== 'undefined') {
  window.A11yGestures = A11yGestures;
}
if (typeof module !== 'undefined') {
  module.exports = A11yGestures;
}
})();
