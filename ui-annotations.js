'use strict';
// ui-annotations.js — Right-click annotation canvas (arrows, circles) and
// multi-PV engine arrow rendering. Extracted from ui.js.
// Loaded as a classic <script> before ui.js. Shares global scope.
// Depends on: boardFlipped, getBoardRenderOrder (from engine.js),
//             engineMultiPvLines (declared here, referenced by ui.js updateEvalUI).

const ANNOTATION_COLORS = {
  green: { stroke: 'rgba(34, 197, 94, 0.85)', fill: 'rgba(34, 197, 94, 0.85)' },
  red: { stroke: 'rgba(239, 68, 68, 0.85)', fill: 'rgba(239, 68, 68, 0.85)' },
  blue: { stroke: 'rgba(14, 165, 233, 0.85)', fill: 'rgba(14, 165, 233, 0.85)' },
  yellow: { stroke: 'rgba(234, 179, 8, 0.85)', fill: 'rgba(234, 179, 8, 0.85)' },
  engine: { stroke: 'rgba(37, 99, 235, 0.85)', fill: 'rgba(37, 99, 235, 0.85)' },
  engine2: { stroke: 'rgba(16, 185, 129, 0.75)', fill: 'rgba(16, 185, 129, 0.75)' },
  engine3: { stroke: 'rgba(245, 158, 11, 0.70)', fill: 'rgba(245, 158, 11, 0.70)' }
};

let userAnnotations = {
  arrows: [],
  circles: []
};
let engineAnalysisArrow = null;
let rightClickStartSquare = null;
let engineMultiPvLines = [];

function getAnnotationColorFromEvent(event) {
  if (!event) return 'green';
  if (event.shiftKey && (event.altKey || event.ctrlKey || event.metaKey)) return 'yellow';
  if (event.altKey || event.ctrlKey || event.metaKey) return 'red';
  if (event.shiftKey) return 'blue';
  return 'green';
}

function getSquareCenterCoordinates(squareId) {
  if (!squareId || typeof getBoardRenderOrder !== 'function') return null;
  const renderOrder = getBoardRenderOrder(boardFlipped);
  const idx = renderOrder.indexOf(squareId);
  if (idx < 0) return null;
  const col = idx % 8;
  const row = Math.floor(idx / 8);
  return {
    x: (col + 0.5) * 12.5,
    y: (row + 0.5) * 12.5
  };
}

function renderAnnotations(targetSvg) {
  const svg = targetSvg || (typeof document !== 'undefined' ? document.getElementById('analysis-arrows') : null);
  if (!svg) return;

  const markerDefs = `
    <defs>
      <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
        <polygon points="0 0, 6 3, 0 6" fill="${ANNOTATION_COLORS.engine.fill}" />
      </marker>
      ${Object.entries(ANNOTATION_COLORS).map(([name, c]) => `
        <marker id="arrowhead-${name}" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
          <polygon points="0 0, 6 3, 0 6" fill="${c.fill}" />
        </marker>
      `).join('')}
    </defs>
  `;

  let elementsHtml = '';

  if (userAnnotations && userAnnotations.circles) {
    userAnnotations.circles.forEach(c => {
      const coords = getSquareCenterCoordinates(c.square);
      if (!coords) return;
      const colorObj = ANNOTATION_COLORS[c.color] || ANNOTATION_COLORS.green;
      elementsHtml += `<circle class="annotation-circle" data-square="${c.square}" cx="${coords.x}%" cy="${coords.y}%" r="5.2%" stroke="${colorObj.stroke}" stroke-width="3.5" fill="none" opacity="0.85" />`;
    });
  }

  if (userAnnotations && userAnnotations.arrows) {
    userAnnotations.arrows.forEach(a => {
      const p1 = getSquareCenterCoordinates(a.from);
      const p2 = getSquareCenterCoordinates(a.to);
      if (!p1 || !p2) return;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const endMargin = dist > 0 ? Math.min(2.5, dist * 0.2) : 0;
      const x2 = p2.x - (dist > 0 ? (dx / dist) * endMargin : 0);
      const y2 = p2.y - (dist > 0 ? (dy / dist) * endMargin : 0);
      const colorKey = a.color && ANNOTATION_COLORS[a.color] ? a.color : 'green';
      const colorObj = ANNOTATION_COLORS[colorKey];
      elementsHtml += `<line class="annotation-arrow" data-from="${a.from}" data-to="${a.to}" x1="${p1.x}%" y1="${p1.y}%" x2="${x2}%" y2="${y2}%" stroke="${colorObj.stroke}" stroke-width="4" stroke-linecap="round" marker-end="url(#arrowhead-${colorKey})" opacity="0.85" />`;
    });
  }

  if (engineMultiPvLines && engineMultiPvLines.length > 0) {
    engineMultiPvLines.forEach((line) => {
      const p1 = getSquareCenterCoordinates(line.from);
      const p2 = getSquareCenterCoordinates(line.to);
      if (!p1 || !p2) return;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const endMargin = dist > 0 ? Math.min(2.5, dist * 0.2) : 0;
      const x2 = p2.x - (dist > 0 ? (dx / dist) * endMargin : 0);
      const y2 = p2.y - (dist > 0 ? (dy / dist) * endMargin : 0);
      const colorKey = line.pvIndex === 1 ? 'engine' : line.pvIndex === 2 ? 'engine2' : 'engine3';
      const colorObj = ANNOTATION_COLORS[colorKey] || ANNOTATION_COLORS.engine;
      const strokeW = line.pvIndex === 1 ? '4.5' : line.pvIndex === 2 ? '3.5' : '3';
      elementsHtml += `<line class="engine-multipv-arrow engine-pv-${line.pvIndex}" data-pv="${line.pvIndex}" x1="${p1.x}%" y1="${p1.y}%" x2="${x2}%" y2="${y2}%" stroke="${colorObj.stroke}" stroke-width="${strokeW}" stroke-linecap="round" marker-end="url(#arrowhead-${colorKey})" opacity="0.85" />`;
    });
  } else if (engineAnalysisArrow) {
    const p1 = getSquareCenterCoordinates(engineAnalysisArrow.from);
    const p2 = getSquareCenterCoordinates(engineAnalysisArrow.to);
    if (p1 && p2) {
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const endMargin = dist > 0 ? Math.min(2.5, dist * 0.2) : 0;
      const x2 = p2.x - (dist > 0 ? (dx / dist) * endMargin : 0);
      const y2 = p2.y - (dist > 0 ? (dy / dist) * endMargin : 0);
      elementsHtml += `<line class="engine-arrow" x1="${p1.x}%" y1="${p1.y}%" x2="${x2}%" y2="${y2}%" stroke="${ANNOTATION_COLORS.engine.stroke}" stroke-width="4" stroke-linecap="round" marker-end="url(#arrowhead)" />`;
    }
  }

  svg.innerHTML = markerDefs + elementsHtml;
}

function drawAnalysisArrow(svg, fromSq, toSq) {
  if (!svg || !fromSq || !toSq) return;
  engineAnalysisArrow = { from: fromSq, to: toSq };
  renderAnnotations(svg);
}

function clearAnalysisArrow() {
  engineAnalysisArrow = null;
  engineMultiPvLines = [];
  renderAnnotations();
  renderMultiPvBreakdown();
}

function toggleUserCircle(square, color) {
  if (color === undefined) color = 'green';
  if (!userAnnotations || !userAnnotations.circles) return;
  const idx = userAnnotations.circles.findIndex(c => c.square === square);
  if (idx >= 0) {
    if (userAnnotations.circles[idx].color === color) {
      userAnnotations.circles.splice(idx, 1);
    } else {
      userAnnotations.circles[idx].color = color;
    }
  } else {
    userAnnotations.circles.push({ square, color });
  }
  renderAnnotations();
}

function addUserArrow(from, to, color) {
  if (color === undefined) color = 'green';
  if (!from || !to || from === to) return;
  if (!userAnnotations || !userAnnotations.arrows) return;
  const idx = userAnnotations.arrows.findIndex(a => a.from === from && a.to === to);
  if (idx >= 0) {
    if (userAnnotations.arrows[idx].color === color) {
      userAnnotations.arrows.splice(idx, 1);
    } else {
      userAnnotations.arrows[idx].color = color;
    }
  } else {
    userAnnotations.arrows.push({ from, to, color });
  }
  renderAnnotations();
}

function clearUserAnnotations() {
  if (userAnnotations) {
    userAnnotations.arrows = [];
    userAnnotations.circles = [];
  }
  renderAnnotations();
}

function getUserAnnotations() {
  return {
    arrows: userAnnotations && userAnnotations.arrows ? [...userAnnotations.arrows] : [],
    circles: userAnnotations && userAnnotations.circles ? [...userAnnotations.circles] : []
  };
}

function handleSquareMouseDown(event, squareId) {
  if (!event) return;
  if (event.button === 0) {
    if (userAnnotations && (userAnnotations.arrows.length > 0 || userAnnotations.circles.length > 0)) {
      clearUserAnnotations();
    }
  } else if (event.button === 2) {
    if (event.preventDefault) event.preventDefault();
    rightClickStartSquare = squareId;
  }
}

function handleSquareMouseUp(event, squareId) {
  if (!event) return;
  if (event.button === 2 && rightClickStartSquare) {
    if (event.preventDefault) event.preventDefault();
    const color = getAnnotationColorFromEvent(event);
    if (rightClickStartSquare === squareId) {
      toggleUserCircle(squareId, color);
    } else {
      addUserArrow(rightClickStartSquare, squareId, color);
    }
    rightClickStartSquare = null;
  }
}

function renderMultiPvBreakdown() {
  const container = document.getElementById('multipv-lines');
  if (!container) return;
  container.innerHTML = '';
  engineMultiPvLines.forEach(line => {
    const row = document.createElement('div');
    row.className = `multipv-row multipv-rank-${line.pvIndex}`;
    const colorBadge = line.pvIndex === 1 ? '#2563eb' : line.pvIndex === 2 ? '#10b981' : '#f59e0b';
    const scoreFormatted = line.scoreCp >= 0 ? `+${line.scoreCp.toFixed(1)}` : line.scoreCp.toFixed(1);
    row.innerHTML = `
      <span style="color: ${colorBadge}; font-weight: bold;">#${line.pvIndex} ${line.from}${line.to}</span>
      <span style="font-family: monospace;">${scoreFormatted} (d=${line.depth})</span>
    `;
    container.appendChild(row);
  });
}

function getEngineMultiPvLines() {
  return [...engineMultiPvLines];
}

function clearEngineMultiPvLines() {
  engineMultiPvLines = [];
  engineAnalysisArrow = null;
  renderAnnotations();
  renderMultiPvBreakdown();
}