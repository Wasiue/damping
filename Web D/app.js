/**
 * Plot Digitizer — app.js
 * Modular vanilla JS implementation.
 * Sections:
 *   1. State
 *   2. Canvas / Viewport
 *   3. Calibration
 *   4. Trace Mode
 *   5. Pick Mode
 *   6. Data Management
 *   7. Export
 *   8. UI Helpers
 *   9. Event Wiring
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 1. STATE
// ═══════════════════════════════════════════════════════════════════════════

const State = {
  // Image
  image: null,           // HTMLImageElement
  imgW: 0,
  imgH: 0,

  // Viewport transform
  zoom: 1,
  panX: 0,
  panY: 0,

  // Mode: null | 'calib-x' | 'calib-y' | 'trace' | 'pick' | 'pan'
  mode: null,
  pendingCalibPoint: null,  // which calibration point is being placed: x1|x2|y1|y2

  // Calibration: each point stores { px, py, val }
  calib: { x1: null, x2: null, y1: null, y2: null },
  xAxisType: 'linear',   // 'linear' | 'log'
  yAxisType: 'linear',

  // Extracted data points [{ x, y, px, py }]  (real-world coords)
  points: [],

  // Tracing
  isTracing: false,
  lastTracePx: null,     // last sampled pixel position
  traceBrushSize: 6,
  traceSamplingStep: 4,
  traceSmooth: true,

  // Pan gesture
  isPanning: false,
  panStartMouse: null,
  panStartOffset: null,

  // Point drag
  draggingPointIdx: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// 2. CANVAS / VIEWPORT
// ═══════════════════════════════════════════════════════════════════════════

const Canvas = (() => {
  const canvas = document.getElementById('main-canvas');
  const ctx = canvas.getContext('2d');

  /** Resize canvas to match container pixel dimensions. */
  function resize() {
    const container = document.getElementById('canvas-container');
    canvas.width  = container.clientWidth;
    canvas.height = container.clientHeight;
    render();
  }

  /** Full render pass: image → calibration markers → data points overlay. */
  function render() {
    const { image, zoom, panX, panY, calib, points, mode, isTracing } = State;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!image) return;

    // ── Draw image ──
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);
    ctx.drawImage(image, 0, 0);
    ctx.restore();

    // ── Draw calibration markers ──
    const calibColors = {
      x1: '#f5a623', x2: '#f5a623',
      y1: '#3dd9c3', y2: '#3dd9c3',
    };
    const calibLabels = { x1: 'X₁', x2: 'X₂', y1: 'Y₁', y2: 'Y₂' };

    Object.entries(calib).forEach(([key, pt]) => {
      if (!pt) return;
      const sx = pt.px * zoom + panX;
      const sy = pt.py * zoom + panY;
      _drawCrossMarker(ctx, sx, sy, calibColors[key], calibLabels[key]);
    });

    // ── Draw data points ──
    if (mode === 'pick' || points.length > 0) {
      points.forEach((pt, i) => {
        const sx = pt.px * zoom + panX;
        const sy = pt.py * zoom + panY;
        _drawDataPoint(ctx, sx, sy, i, i === State.draggingPointIdx);
      });
    }

    // ── Draw trace path ──
    if (mode === 'trace' && points.length > 0) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(61,217,195,0.5)';
      ctx.lineWidth = 1.5;
      let started = false;
      points.forEach(pt => {
        const sx = pt.px * zoom + panX;
        const sy = pt.py * zoom + panY;
        if (!started) { ctx.moveTo(sx, sy); started = true; }
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
    }
  }

  function _drawCrossMarker(ctx, x, y, color, label) {
    const size = 10;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;
    // Cross
    ctx.beginPath();
    ctx.moveTo(x - size, y); ctx.lineTo(x + size, y);
    ctx.moveTo(x, y - size); ctx.lineTo(x, y + size);
    ctx.stroke();
    // Circle
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Label
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    ctx.font = 'bold 11px JetBrains Mono, monospace';
    ctx.fillText(label, x + 10, y - 8);
    ctx.restore();
  }

  function _drawDataPoint(ctx, x, y, idx, isDragging) {
    ctx.save();
    const color = isDragging ? '#fff' : '#f5a623';
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = isDragging ? 8 : 4;
    ctx.beginPath();
    ctx.arc(x, y, isDragging ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Convert screen coordinates to image-pixel coordinates. */
  function screenToImage(sx, sy) {
    return {
      px: (sx - State.panX) / State.zoom,
      py: (sy - State.panY) / State.zoom,
    };
  }

  /** Convert image-pixel coordinates to screen coordinates. */
  function imageToScreen(px, py) {
    return {
      sx: px * State.zoom + State.panX,
      sy: py * State.zoom + State.panY,
    };
  }

  /** Fit image to canvas with padding. */
  function fitToWindow() {
    if (!State.image) return;
    const W = canvas.width, H = canvas.height;
    const iw = State.imgW, ih = State.imgH;
    const padding = 48;
    const scale = Math.min((W - padding * 2) / iw, (H - padding * 2) / ih);
    State.zoom = scale;
    State.panX = (W - iw * scale) / 2;
    State.panY = (H - ih * scale) / 2;
    render();
  }

  /** Zoom around a centre point (screen coords). */
  function zoomAt(sx, sy, factor) {
    const newZoom = Math.max(0.05, Math.min(40, State.zoom * factor));
    const ratio = newZoom / State.zoom;
    State.panX = sx - ratio * (sx - State.panX);
    State.panY = sy - ratio * (sy - State.panY);
    State.zoom = newZoom;
    render();
  }

  return { canvas, ctx, resize, render, screenToImage, imageToScreen, fitToWindow, zoomAt };
})();

// ═══════════════════════════════════════════════════════════════════════════
// 3. CALIBRATION
// ═══════════════════════════════════════════════════════════════════════════

const Calibration = (() => {

  /**
   * Check if all 4 calibration points are set with valid values.
   */
  function isReady() {
    const { x1, x2, y1, y2 } = State.calib;
    return x1 && x2 && y1 && y2 &&
      x1.val != null && x2.val != null &&
      y1.val != null && y2.val != null;
  }

  /**
   * Convert image pixel (px, py) → real-world (x, y).
   * Supports linear and logarithmic axes.
   */
  function pixelToWorld(px, py) {
    if (!isReady()) return null;
    const { x1, x2, y1, y2 } = State.calib;
    const xType = State.xAxisType;
    const yType = State.yAxisType;

    let x, y;

    if (xType === 'log') {
      const logX1 = Math.log10(x1.val);
      const logX2 = Math.log10(x2.val);
      const logX  = logX1 + (px - x1.px) * (logX2 - logX1) / (x2.px - x1.px);
      x = Math.pow(10, logX);
    } else {
      x = x1.val + (px - x1.px) * (x2.val - x1.val) / (x2.px - x1.px);
    }

    if (yType === 'log') {
      const logY1 = Math.log10(y1.val);
      const logY2 = Math.log10(y2.val);
      const logY  = logY1 + (py - y1.py) * (logY2 - logY1) / (y2.py - y1.py);
      y = Math.pow(10, logY);
    } else {
      y = y1.val + (py - y1.py) * (y2.val - y1.val) / (y2.py - y1.py);
    }

    return { x, y };
  }

  /**
   * Set a calibration point (by key: x1|x2|y1|y2) from a canvas click.
   */
  function setPoint(key, px, py, val) {
    State.calib[key] = { px, py, val };
    _updateUI();
    Canvas.render();
  }

  /**
   * Sync all calibration indicator dots, input values, button labels, and status text.
   */
  function _updateUI() {
    const keys = ['x1', 'x2', 'y1', 'y2'];
    keys.forEach(key => {
      const dot = document.getElementById(`calib-${key}-dot`);
      const btn = document.getElementById(`btn-set-${key}`);
      const input = document.getElementById(`calib-${key}-val`);
      const isY = key.startsWith('y');
      const pt = State.calib[key];

      if (pt) {
        dot.classList.add(isY ? 'y-set' : 'set');
        dot.classList.remove(isY ? 'set' : 'y-set');
        // Reflect current value in the input (only if not being actively edited)
        if (document.activeElement !== input) {
          input.value = pt.val;
        }
        // Button shows "Move" for placed points (unless currently waiting/armed)
        if (!btn.classList.contains('waiting')) {
          btn.textContent = 'Move';
          btn.classList.add('placed');
        }
      } else {
        dot.classList.remove('set', 'y-set');
        if (!btn.classList.contains('waiting')) {
          btn.textContent = 'Set';
          btn.classList.remove('placed');
        }
      }
    });

    const ready = isReady();
    const statusEl = document.getElementById('calib-status');
    const statusText = document.getElementById('calib-status-text');
    if (ready) {
      statusEl.classList.add('complete');
      statusEl.querySelector('.calib-status-icon').textContent = '●';
      statusText.textContent = 'Calibration complete ✓';
      UI.setStatus('Calibrated — start digitizing', 'calibrated');
    } else {
      const setCount = Object.values(State.calib).filter(Boolean).length;
      statusEl.classList.remove('complete');
      statusEl.querySelector('.calib-status-icon').textContent = '○';
      statusText.textContent = `${setCount}/4 calibration points set`;
    }
  }

  function getStatus() { return _updateUI; }

  return { isReady, pixelToWorld, setPoint, updateUI: _updateUI };
})();

// ═══════════════════════════════════════════════════════════════════════════
// 4. TRACE MODE
// ═══════════════════════════════════════════════════════════════════════════

const Tracer = (() => {

  function start(px, py) {
    if (!Calibration.isReady()) {
      UI.toast('Complete axis calibration first', 'error'); return;
    }
    State.isTracing = true;
    State.lastTracePx = { px, py };
    _addPoint(px, py);
  }

  function move(px, py) {
    if (!State.isTracing) return;
    const last = State.lastTracePx;
    const step = State.traceSamplingStep;
    const dx = px - last.px, dy = py - last.py;
    if (Math.sqrt(dx * dx + dy * dy) < step) return;
    _addPoint(px, py);
    State.lastTracePx = { px, py };
  }

  function end() {
    State.isTracing = false;
    State.lastTracePx = null;
    if (State.traceSmooth) _smoothPoints();
    Canvas.render();
    DataTable.refresh();
  }

  function _addPoint(px, py) {
    const world = Calibration.pixelToWorld(px, py);
    if (!world) return;
    State.points.push({ px, py, x: world.x, y: world.y });
    Canvas.render();
    DataTable.refresh();
  }

  /** Simple moving-average smoothing on real-world x,y values. */
  function _smoothPoints() {
    if (State.points.length < 5) return;
    const win = 3;
    const pts = State.points;
    for (let i = win; i < pts.length - win; i++) {
      let sx = 0, sy = 0;
      for (let j = i - win; j <= i + win; j++) { sx += pts[j].x; sy += pts[j].y; }
      pts[i].x = sx / (win * 2 + 1);
      pts[i].y = sy / (win * 2 + 1);
    }
  }

  return { start, move, end };
})();

// ═══════════════════════════════════════════════════════════════════════════
// 5. PICK MODE
// ═══════════════════════════════════════════════════════════════════════════

const Picker = (() => {

  function addPoint(px, py) {
    if (!Calibration.isReady()) {
      UI.toast('Complete axis calibration first', 'error'); return;
    }
    const world = Calibration.pixelToWorld(px, py);
    if (!world) return;
    State.points.push({ px, py, x: world.x, y: world.y });
    Canvas.render();
    DataTable.refresh();
    UI.toast(`Point added: (${_fmt(world.x)}, ${_fmt(world.y)})`, 'success');
  }

  /**
   * Check if a screen click hits an existing data point.
   * Returns index or -1.
   */
  function hitTest(sx, sy) {
    const hitRadius = 10;
    for (let i = State.points.length - 1; i >= 0; i--) {
      const pt = State.points[i];
      const scr = Canvas.imageToScreen(pt.px, pt.py);
      const dx = sx - scr.sx, dy = sy - scr.sy;
      if (Math.sqrt(dx * dx + dy * dy) <= hitRadius) return i;
    }
    return -1;
  }

  function startDrag(idx) {
    State.draggingPointIdx = idx;
  }

  function updateDrag(px, py) {
    const idx = State.draggingPointIdx;
    if (idx === null || idx < 0) return;
    const world = Calibration.pixelToWorld(px, py);
    if (!world) return;
    State.points[idx] = { px, py, x: world.x, y: world.y };
    Canvas.render();
    DataTable.refresh();
  }

  function endDrag() {
    State.draggingPointIdx = null;
    Canvas.render();
  }

  function deletePoint(idx) {
    State.points.splice(idx, 1);
    Canvas.render();
    DataTable.refresh();
  }

  function _fmt(v) { return Number(v.toPrecision(5)).toString(); }

  return { addPoint, hitTest, startDrag, updateDrag, endDrag, deletePoint };
})();

// ═══════════════════════════════════════════════════════════════════════════
// 6. DATA TABLE
// ═══════════════════════════════════════════════════════════════════════════

const DataTable = (() => {

  const tbody = document.getElementById('data-tbody');
  const countEl = document.getElementById('point-count');

  function refresh() {
    const pts = State.points;
    countEl.textContent = pts.length;
    tbody.innerHTML = '';

    if (pts.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No data points yet</td></tr>';
      return;
    }

    pts.forEach((pt, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${_fmt(pt.x)}</td>
        <td>${_fmt(pt.y)}</td>
        <td><button class="delete-point-btn" data-idx="${i}" title="Delete point">✕</button></td>
      `;
      tbody.appendChild(tr);
    });

    // Bind delete buttons
    tbody.querySelectorAll('.delete-point-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        Picker.deletePoint(parseInt(btn.dataset.idx));
      });
    });
  }

  function _fmt(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    const s = Number(v.toPrecision(6)).toString();
    return s.length > 12 ? v.toExponential(4) : s;
  }

  return { refresh };
})();

// ═══════════════════════════════════════════════════════════════════════════
// 7. EXPORT
// ═══════════════════════════════════════════════════════════════════════════

const Exporter = (() => {

  function _checkPoints() {
    if (State.points.length === 0) {
      UI.toast('No data points to export', 'error'); return false;
    }
    return true;
  }

  function toCSV() {
    if (!_checkPoints()) return;
    const lines = ['X,Y', ...State.points.map(p => `${p.x},${p.y}`)];
    _download(lines.join('\n'), 'digitized_data.csv', 'text/csv');
    UI.toast('CSV downloaded', 'success');
  }

  function toTXT() {
    if (!_checkPoints()) return;
    const lines = ['X\tY', ...State.points.map(p => `${p.x}\t${p.y}`)];
    _download(lines.join('\n'), 'digitized_data.txt', 'text/plain');
    UI.toast('TXT downloaded', 'success');
  }

  function toJSON() {
    if (!_checkPoints()) return;
    const data = {
      metadata: {
        exportedAt: new Date().toISOString(),
        pointCount: State.points.length,
        xAxisType: State.xAxisType,
        yAxisType: State.yAxisType,
      },
      data: State.points.map((p, i) => ({ index: i + 1, x: p.x, y: p.y })),
    };
    _download(JSON.stringify(data, null, 2), 'digitized_data.json', 'application/json');
    UI.toast('JSON downloaded', 'success');
  }

  async function toClipboard() {
    if (!_checkPoints()) return;
    const lines = ['X\tY', ...State.points.map(p => `${p.x}\t${p.y}`)];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      UI.toast('Copied to clipboard', 'success');
    } catch {
      UI.toast('Clipboard access denied', 'error');
    }
  }

  /** Show a reconstructed scatter/line chart of the extracted points. */
  function preview() {
    if (!_checkPoints()) return;

    const modal = document.getElementById('modal-preview');
    const canvas = document.getElementById('preview-canvas');
    const ctx = canvas.getContext('2d');

    modal.style.display = 'flex';

    // Wait for layout
    requestAnimationFrame(() => {
      const W = canvas.clientWidth || 600;
      const H = canvas.clientHeight || 400;
      canvas.width  = W;
      canvas.height = H;

      const pts = [...State.points].sort((a, b) => a.x - b.x);
      if (pts.length === 0) return;

      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      const xMin = Math.min(...xs), xMax = Math.max(...xs);
      const yMin = Math.min(...ys), yMax = Math.max(...ys);

      const pad = { top: 30, right: 30, bottom: 50, left: 60 };
      const plotW = W - pad.left - pad.right;
      const plotH = H - pad.top - pad.bottom;

      const toSX = x => pad.left + (x - xMin) / (xMax - xMin || 1) * plotW;
      const toSY = y => pad.top  + (1 - (y - yMin) / (yMax - yMin || 1)) * plotH;

      // Background
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);

      // Grid
      ctx.strokeStyle = '#e8ecf5';
      ctx.lineWidth = 1;
      const gridLines = 6;
      for (let i = 0; i <= gridLines; i++) {
        const y = pad.top + i * plotH / gridLines;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
        const x = pad.left + i * plotW / gridLines;
        ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, H - pad.bottom); ctx.stroke();
      }

      // Axes
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, H - pad.bottom);
      ctx.lineTo(W - pad.right, H - pad.bottom);
      ctx.stroke();

      // Axis labels
      ctx.fillStyle = '#555';
      ctx.font = '11px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      const xStep = (xMax - xMin) / gridLines;
      for (let i = 0; i <= gridLines; i++) {
        const val = xMin + i * xStep;
        const sx = toSX(val);
        ctx.fillText(_fmtTick(val), sx, H - pad.bottom + 18);
      }
      ctx.textAlign = 'right';
      const yStep = (yMax - yMin) / gridLines;
      for (let i = 0; i <= gridLines; i++) {
        const val = yMin + i * yStep;
        const sy = toSY(val);
        ctx.fillText(_fmtTick(val), pad.left - 6, sy + 4);
      }

      // Line
      ctx.strokeStyle = '#3dd9c3';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((pt, i) => {
        const sx = toSX(pt.x), sy = toSY(pt.y);
        i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
      });
      ctx.stroke();

      // Dots
      ctx.fillStyle = '#f5a623';
      pts.forEach(pt => {
        ctx.beginPath();
        ctx.arc(toSX(pt.x), toSY(pt.y), 3.5, 0, Math.PI * 2);
        ctx.fill();
      });

      // Title
      ctx.fillStyle = '#333';
      ctx.font = 'bold 13px DM Sans, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`Digitized Curve — ${pts.length} points`, W / 2, 18);
    });
  }

  function _fmtTick(v) {
    if (Math.abs(v) >= 1e4 || (Math.abs(v) < 0.01 && v !== 0)) return v.toExponential(1);
    return parseFloat(v.toPrecision(4)).toString();
  }

  function _download(content, filename, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return { toCSV, toTXT, toJSON, toClipboard, preview };
})();

// ═══════════════════════════════════════════════════════════════════════════
// 8. UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const UI = (() => {

  /** Set global tool mode and update toolbar button states. */
  function setMode(newMode) {
    State.mode = newMode;

    // Update toolbar active states
    document.querySelectorAll('.tool-btn[data-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === newMode);
    });

    // Update canvas cursor class
    const container = document.getElementById('canvas-container');
    container.className = 'canvas-container';
    if (newMode === 'pan') container.classList.add('mode-pan');
  }

  /** Set status badge text and style. */
  function setStatus(text, type = '') {
    const badge = document.getElementById('status-badge');
    const textEl = document.getElementById('status-text');
    textEl.textContent = text;
    badge.className = 'status-badge';
    if (type) badge.classList.add(type);
  }

  /** Show a toast notification. type: 'success'|'error'|'info' */
  function toast(message, type = 'info') {
    const icons = { success: '✓', error: '✗', info: '●' };
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${message}</span>`;
    container.appendChild(el);
    setTimeout(() => {
      el.style.animation = 'toast-out 0.2s ease forwards';
      setTimeout(() => el.remove(), 200);
    }, 2500);
  }

  /** Update coordinate readout in bottom-left. */
  function updateCoordReadout(px, py) {
    const readout = document.getElementById('coord-readout');
    const world = Calibration.isReady() ? Calibration.pixelToWorld(px, py) : null;
    if (world) {
      readout.textContent = `x: ${_fmt(world.x)}  y: ${_fmt(world.y)}`;
    } else {
      readout.textContent = `px: ${Math.round(px)}, py: ${Math.round(py)}`;
    }
  }

  function _fmt(v) {
    if (v === null || isNaN(v)) return '—';
    return parseFloat(v.toPrecision(5)).toString();
  }

  return { setMode, setStatus, toast, updateCoordReadout };
})();

// ═══════════════════════════════════════════════════════════════════════════
// 9. EVENT WIRING
// ═══════════════════════════════════════════════════════════════════════════

(function init() {

  // ── File upload ──
  const fileInput  = document.getElementById('file-input');
  const dropZone   = document.getElementById('drop-zone');
  const btnUpload  = document.getElementById('btn-upload');

  btnUpload.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => loadImageFile(e.target.files[0]));

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) loadImageFile(file);
  });
  dropZone.addEventListener('click', e => {
    if (e.target.tagName !== 'LABEL') fileInput.click();
  });

  function loadImageFile(file) {
    if (!file || !file.type.match(/image\/(png|jpeg)/)) {
      UI.toast('Please upload a PNG or JPG image', 'error'); return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      State.image = img;
      State.imgW  = img.naturalWidth;
      State.imgH  = img.naturalHeight;
      State.calib = { x1: null, x2: null, y1: null, y2: null };
      State.points = [];
      State.pendingCalibPoint = null;

      // Reset calibration inputs and buttons
      ['x1','x2','y1','y2'].forEach(key => {
        document.getElementById(`calib-${key}-val`).value = '';
        const btn = document.getElementById(`btn-set-${key}`);
        btn.textContent = 'Set';
        btn.classList.remove('waiting', 'placed');
        document.getElementById(`calib-${key}-row`).classList.remove('waiting-row');
      });
      _resetInstructionStrip();

      document.getElementById('drop-zone').style.display = 'none';
      const container = document.getElementById('canvas-container');
      container.style.display = 'block';

      Canvas.resize();
      Canvas.fitToWindow();
      DataTable.refresh();
      Calibration.updateUI();

      UI.setStatus(`Image loaded: ${img.naturalWidth}×${img.naturalHeight}px`, 'ready');
      UI.toast(`Loaded: ${file.name}`, 'success');
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  // ── Toolbar buttons ──
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    const c = Canvas.canvas;
    Canvas.zoomAt(c.width / 2, c.height / 2, 1.4);
  });
  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    const c = Canvas.canvas;
    Canvas.zoomAt(c.width / 2, c.height / 2, 1 / 1.4);
  });
  document.getElementById('btn-reset-view').addEventListener('click', () => {
    Canvas.fitToWindow();
  });
  document.getElementById('btn-pan').addEventListener('click', () => {
    UI.setMode(State.mode === 'pan' ? null : 'pan');
  });
  document.getElementById('btn-trace').addEventListener('click', () => {
    if (!State.image) { UI.toast('Load an image first', 'error'); return; }
    UI.setMode(State.mode === 'trace' ? null : 'trace');
    if (State.mode === 'trace') UI.setStatus('Trace mode — draw over the curve', 'active');
  });
  document.getElementById('btn-pick').addEventListener('click', () => {
    if (!State.image) { UI.toast('Load an image first', 'error'); return; }
    UI.setMode(State.mode === 'pick' ? null : 'pick');
    if (State.mode === 'pick') UI.setStatus('Pick mode — click points on the curve', 'active');
  });
  document.getElementById('btn-clear-points').addEventListener('click', () => {
    if (State.points.length === 0) return;
    State.points = [];
    Canvas.render();
    DataTable.refresh();
    UI.toast('All data points cleared', 'info');
  });

  // ── Calibration buttons ──
  // New flow (no modal):
  //   1. User types a value into the input field
  //   2. User clicks "Set" → button goes into "waiting" state, canvas click is armed
  //   3. User clicks on canvas → point placed at that pixel with the input value
  //   4. Button label changes to "Move", value input stays editable
  //   5. Editing the value input on an already-placed point immediately updates calibration

  const calibKeys = ['x1', 'x2', 'y1', 'y2'];

  /** Arm a calibration point for canvas placement. */
  function armCalibPoint(key) {
    if (!State.image) { UI.toast('Load an image first', 'error'); return; }

    const input = document.getElementById(`calib-${key}-val`);
    const val = parseFloat(input.value);
    if (isNaN(val)) {
      UI.toast(`Enter a value for ${key.toUpperCase()} before clicking Set`, 'error');
      input.focus();
      return;
    }

    // Cancel any previously armed point
    if (State.pendingCalibPoint && State.pendingCalibPoint.key !== key) {
      _disarmCalibPoint(State.pendingCalibPoint.key);
    }

    // Store pending (value already known, waiting for canvas click)
    State.pendingCalibPoint = { key, val };
    UI.setMode(key.startsWith('x') ? 'calib-x' : 'calib-y');

    // Visual feedback
    const btn = document.getElementById(`btn-set-${key}`);
    btn.textContent = '↖ Click plot';
    btn.classList.add('waiting');
    btn.classList.remove('placed');
    document.getElementById(`calib-${key}-row`).classList.add('waiting-row');

    // Update instruction strip
    const axisNames = { x1: 'X₁', x2: 'X₂', y1: 'Y₁', y2: 'Y₂' };
    const instrEl = document.getElementById('calib-instructions');
    const instrText = document.getElementById('calib-instr-text');
    instrEl.classList.add('waiting');
    instrEl.querySelector('.calib-instr-icon').textContent = '⊕';
    instrText.innerHTML = `Now click on the <strong>${axisNames[key]}</strong> location on the plot`;

    UI.setStatus(`Click on the ${axisNames[key]} point on the plot`, 'active');
  }

  /** Cancel a pending calibration arm. */
  function _disarmCalibPoint(key) {
    if (!key) return;
    const btn = document.getElementById(`btn-set-${key}`);
    const placed = State.calib[key] !== null;
    btn.textContent = placed ? 'Move' : 'Set';
    btn.classList.remove('waiting');
    if (placed) btn.classList.add('placed');
    document.getElementById(`calib-${key}-row`).classList.remove('waiting-row');
    _resetInstructionStrip();
  }

  function _resetInstructionStrip() {
    const instrEl = document.getElementById('calib-instructions');
    const instrText = document.getElementById('calib-instr-text');
    instrEl.classList.remove('waiting');
    instrEl.querySelector('.calib-instr-icon').textContent = '①';
    instrText.innerHTML = 'Enter a value, click <strong>Set</strong>, then click on the plot';
  }

  /** Called when the canvas is clicked while a calib point is armed. */
  function placeCalibPoint(px, py) {
    const { key, val } = State.pendingCalibPoint;
    Calibration.setPoint(key, px, py, val);
    State.pendingCalibPoint = null;

    // Update button to "Move" (re-arm to reposition)
    const btn = document.getElementById(`btn-set-${key}`);
    btn.textContent = 'Move';
    btn.classList.remove('waiting');
    btn.classList.add('placed');
    document.getElementById(`calib-${key}-row`).classList.remove('waiting-row');
    _resetInstructionStrip();
    UI.setMode(null);

    const axisNames = { x1: 'X₁', x2: 'X₂', y1: 'Y₁', y2: 'Y₂' };
    UI.toast(`${axisNames[key]} placed`, 'success');
    if (Calibration.isReady()) UI.setStatus('Calibrated — start digitizing', 'calibrated');
  }

  // Wire up Set/Move buttons
  calibKeys.forEach(key => {
    document.getElementById(`btn-set-${key}`).addEventListener('click', () => armCalibPoint(key));
  });

  // Wire up value inputs — updating a value on a placed point immediately recalculates
  calibKeys.forEach(key => {
    document.getElementById(`calib-${key}-val`).addEventListener('input', () => {
      const pt = State.calib[key];
      if (!pt) return;                        // not placed yet, nothing to update
      const val = parseFloat(document.getElementById(`calib-${key}-val`).value);
      if (isNaN(val)) return;
      pt.val = val;                           // mutate in place
      Canvas.render();
      Calibration.updateUI();
    });
    // Allow Enter key to arm the point
    document.getElementById(`calib-${key}-val`).addEventListener('keydown', e => {
      if (e.key === 'Enter') armCalibPoint(key);
    });
  });

  // ── Axis type selects ──
  document.getElementById('x-axis-type').addEventListener('change', e => {
    State.xAxisType = e.target.value;
  });
  document.getElementById('y-axis-type').addEventListener('change', e => {
    State.yAxisType = e.target.value;
  });

  // ── Trace options ──
  const brushSlider = document.getElementById('trace-brush');
  const stepSlider  = document.getElementById('trace-step');
  const smoothCheck = document.getElementById('trace-smooth');

  brushSlider.addEventListener('input', () => {
    State.traceBrushSize = parseInt(brushSlider.value);
    document.getElementById('trace-brush-val').textContent = brushSlider.value + 'px';
  });
  stepSlider.addEventListener('input', () => {
    State.traceSamplingStep = parseInt(stepSlider.value);
    document.getElementById('trace-step-val').textContent = stepSlider.value + 'px';
  });
  smoothCheck.addEventListener('change', () => {
    State.traceSmooth = smoothCheck.checked;
  });

  // ── Export buttons ──
  document.getElementById('btn-export-csv').addEventListener('click', () => Exporter.toCSV());
  document.getElementById('btn-export-txt').addEventListener('click', () => Exporter.toTXT());
  document.getElementById('btn-export-json').addEventListener('click', () => Exporter.toJSON());
  document.getElementById('btn-copy-clip').addEventListener('click', () => Exporter.toClipboard());
  document.getElementById('btn-preview-curve').addEventListener('click', () => Exporter.preview());

  document.getElementById('modal-preview-close').addEventListener('click', () => {
    document.getElementById('modal-preview').style.display = 'none';
  });

  // ── Panel collapse ──
  document.querySelectorAll('.panel-collapse-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const target = document.getElementById(btn.dataset.target);
      target.classList.toggle('collapsed');
      btn.classList.toggle('collapsed');
    });
  });
  document.querySelectorAll('.panel-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      hdr.querySelector('.panel-collapse-btn')?.click();
    });
  });

  // ── Canvas mouse events ──
  const container = document.getElementById('canvas-container');
  const canvas    = Canvas.canvas;

  container.addEventListener('mousemove', onMouseMove);
  container.addEventListener('mousedown', onMouseDown);
  container.addEventListener('mouseup',   onMouseUp);
  container.addEventListener('mouseleave',() => {
    if (State.isTracing) Tracer.end();
    if (State.isPanning) State.isPanning = false;
    document.getElementById('crosshair-h').style.opacity = '0';
    document.getElementById('crosshair-v').style.opacity = '0';
  });
  container.addEventListener('wheel', onWheel, { passive: false });

  function getCanvasPos(e) {
    const rect = container.getBoundingClientRect();
    return {
      sx: e.clientX - rect.left,
      sy: e.clientY - rect.top,
    };
  }

  function onMouseMove(e) {
    const { sx, sy } = getCanvasPos(e);
    const { px, py } = Canvas.screenToImage(sx, sy);

    // Crosshairs
    document.getElementById('crosshair-h').style.top  = sy + 'px';
    document.getElementById('crosshair-v').style.left = sx + 'px';

    // Coord readout
    if (State.image) UI.updateCoordReadout(px, py);

    // Panning
    if (State.isPanning && State.panStartMouse) {
      const dx = sx - State.panStartMouse.sx;
      const dy = sy - State.panStartMouse.sy;
      State.panX = State.panStartOffset.x + dx;
      State.panY = State.panStartOffset.y + dy;
      Canvas.render();
      return;
    }

    // Tracing
    if (State.isTracing) {
      Tracer.move(px, py);
    }

    // Dragging a picked point
    if (State.mode === 'pick' && State.draggingPointIdx !== null) {
      Picker.updateDrag(px, py);
    }
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    const { sx, sy } = getCanvasPos(e);
    const { px, py } = Canvas.screenToImage(sx, sy);

    // Pan mode (also triggered by middle mouse or space)
    if (State.mode === 'pan' || e.button === 1) {
      State.isPanning = true;
      State.panStartMouse = { sx, sy };
      State.panStartOffset = { x: State.panX, y: State.panY };
      container.classList.add('panning');
      return;
    }

    // Calibration placement — armed by armCalibPoint()
    if (State.pendingCalibPoint && (State.mode === 'calib-x' || State.mode === 'calib-y')) {
      placeCalibPoint(px, py);
      return;
    }

    // Trace mode
    if (State.mode === 'trace') {
      Tracer.start(px, py);
      return;
    }

    // Pick mode
    if (State.mode === 'pick') {
      // Check if clicking an existing point first
      const hitIdx = Picker.hitTest(sx, sy);
      if (hitIdx >= 0) {
        Picker.startDrag(hitIdx);
      } else {
        Picker.addPoint(px, py);
      }
      return;
    }
  }

  function onMouseUp(e) {
    if (State.isPanning) {
      State.isPanning = false;
      container.classList.remove('panning');
    }
    if (State.isTracing) {
      Tracer.end();
    }
    if (State.mode === 'pick' && State.draggingPointIdx !== null) {
      Picker.endDrag();
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const { sx, sy } = getCanvasPos(e);
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    Canvas.zoomAt(sx, sy, factor);
  }

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key) {
      case 'u': case 'U': fileInput.click(); break;
      case 't': case 'T': document.getElementById('btn-trace').click(); break;
      case 'p': case 'P': document.getElementById('btn-pick').click(); break;
      case 'x': case 'X': document.getElementById('btn-calib-x').click(); break;
      case 'y': case 'Y': document.getElementById('btn-calib-y').click(); break;
      case 'r': case 'R': Canvas.fitToWindow(); break;
      case '+': case '=': document.getElementById('btn-zoom-in').click(); break;
      case '-': case '_': document.getElementById('btn-zoom-out').click(); break;
      case ' ':
        e.preventDefault();
        UI.setMode(State.mode === 'pan' ? null : 'pan');
        break;
      case 'Escape':
        if (State.pendingCalibPoint) {
          _disarmCalibPoint(State.pendingCalibPoint.key);
          State.pendingCalibPoint = null;
        }
        UI.setMode(null);
        break;
      case 'Delete': case 'Backspace':
        if (State.mode === 'pick' && State.points.length > 0) {
          Picker.deletePoint(State.points.length - 1);
        }
        break;
    }
  });

  // ── Window resize ──
  window.addEventListener('resize', () => {
    if (State.image) Canvas.resize();
  });

  // ── Initial state ──
  UI.setStatus('No image loaded');

})();
