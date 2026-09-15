'use strict';
// ui-sound.js — Sound system extracted from ui.js.
// Loaded as a classic <script> before ui.js. Shares global scope.
// Depends on: audioContext (declared here, used by playSound).

let soundEnabled = true;
const SOUND_STORAGE_KEY = 'chess.sound.enabled';
let audioContext = null;

function loadSoundPreference() {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(SOUND_STORAGE_KEY);
      if (stored !== null) soundEnabled = stored === 'true';
    }
  } catch (e) {}
}

function setSoundEnabled(enabled) {
  soundEnabled = !!enabled;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SOUND_STORAGE_KEY, String(soundEnabled));
    }
  } catch (e) {}
  const btn = document.getElementById('sound-toggle');
  if (btn) btn.textContent = soundEnabled ? 'Sound: On' : 'Sound: Off';
}

function playSound(kind) {
  if (!kind || !soundEnabled) return;
  const AudioCtor = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
  if (!AudioCtor) return;
  try {
    if (!audioContext) audioContext = new AudioCtor();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});

    const now = audioContext.currentTime;

    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        if (kind === 'capture') navigator.vibrate([15, 30, 20]);
        else if (kind === 'check') navigator.vibrate([30, 40, 30]);
        else if (kind === 'gameEnd') navigator.vibrate([50, 50, 50]);
        else navigator.vibrate(10);
      } catch (err) {}
    }

    if (kind === 'capture') {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(160, now);
      osc.frequency.exponentialRampToValueAtTime(55, now + 0.12);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(now);
      osc.stop(now + 0.15);
    } else if (kind === 'check') {
      [784, 1046].forEach((freq, i) => {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.03);
        gain.gain.setValueAtTime(0.2, now + i * 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
        osc.connect(gain).connect(audioContext.destination);
        osc.start(now + i * 0.03);
        osc.stop(now + 0.26);
      });
    } else if (kind === 'castle') {
      [now, now + 0.07].forEach(t => {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(300, t);
        osc.frequency.exponentialRampToValueAtTime(150, t + 0.06);
        gain.gain.setValueAtTime(0.22, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
        osc.connect(gain).connect(audioContext.destination);
        osc.start(t);
        osc.stop(t + 0.08);
      });
    } else if (kind === 'gameEnd') {
      [261.63, 329.63, 392.00, 523.25].forEach((freq, i) => {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.05);
        gain.gain.setValueAtTime(0.18, now + i * 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
        osc.connect(gain).connect(audioContext.destination);
        osc.start(now + i * 0.05);
        osc.stop(now + 0.48);
      });
    } else {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(260, now);
      osc.frequency.exponentialRampToValueAtTime(130, now + 0.08);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(now);
      osc.stop(now + 0.1);
    }
  } catch (e) {}
}