// ════════════════════════════════════════════════════════════════════
//  damping-tool.js  –  Generator Oscillation Damping Tool  v2.0
//  Backend logic: signal processing, Prony, FFT/PSD, peak envelope.
//  No DOM access. All engineering calculations preserved exactly.
//  Improvements: diagnostics, validation, signal stats, event detection,
//  comparison data, enhanced export metadata.
// ════════════════════════════════════════════════════════════════════

const TOOL_VERSION               = '2.0.0';
const STEADY_STATE_TAIL          = 50;
const SG_POLY_ORDER              = 2;
const MIN_PEAKS                  = 1;
const MAX_PEAKS                  = 16;
const COMPLIANCE_MIN_DAMPING     = 0.10;
const COMPLIANCE_MAX_HALVING_T   = 5.00;

// ── Oscillation classification bands ─────────────────────────────────
const OSC_BANDS = [
  { label: 'Inter-Area',    fMin: 0.1,  fMax: 0.8 },
  { label: 'Local Plant',   fMin: 0.8,  fMax: 2.0 },
  { label: 'Control/PSS',   fMin: 2.0,  fMax: 5.0 },
];

function classifyOscillation(freqHz) {
  for (const b of OSC_BANDS) {
    if (freqHz >= b.fMin && freqHz < b.fMax) return b.label;
  }
  if (freqHz < 0.1)  return 'Sub-Synchronous (<0.1 Hz)';
  if (freqHz >= 5.0) return 'High-Frequency (≥5 Hz)';
  return 'Unknown';
}

// ════════════════════════════════════════════════════════════════════
//  INPUT VALIDATION HELPERS
// ════════════════════════════════════════════════════════════════════
function validatePronyParams(numModes, windowLength, freqMin, freqMax) {
  const errs = [];
  if (!Number.isInteger(numModes) || numModes < 1 || numModes > 40)
    errs.push(`Modes must be an integer between 1 and 40 (got: ${numModes}).`);
  if (!Number.isFinite(windowLength) || windowLength < numModes + 2)
    errs.push(`Window length must be > Modes+1. Need at least ${numModes + 2} samples (got: ${windowLength}).`);
  if (!Number.isFinite(freqMin) || freqMin < 0)
    errs.push(`Freq Min must be ≥ 0 Hz (got: ${freqMin}).`);
  if (!Number.isFinite(freqMax) || freqMax <= freqMin)
    errs.push(`Freq Max must be > Freq Min. Got Min=${freqMin} Max=${freqMax}.`);
  if (freqMax > 500)
    errs.push(`Freq Max (${freqMax} Hz) is unreasonably large. Check units.`);
  return errs;
}

function validatePeakParams(numPeaks, prominence) {
  const errs = [];
  if (!Number.isInteger(numPeaks) || numPeaks < 1 || numPeaks > MAX_PEAKS)
    errs.push(`Peak count must be between 1 and ${MAX_PEAKS} (got: ${numPeaks}).`);
  if (!Number.isFinite(prominence) || prominence < 0)
    errs.push(`Prominence must be ≥ 0 (got: ${prominence}).`);
  return errs;
}

function validateSignalLength(n, minRequired, context) {
  if (n < minRequired)
    throw new Error(`Signal too short for ${context}: ${n} samples (need ≥ ${minRequired}).`);
}

// ════════════════════════════════════════════════════════════════════
//  1. DATA PARSING
// ════════════════════════════════════════════════════════════════════
function parseAllColumns(text) {
  const lines = text.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  let headers = null;
  const rows = [];

  for (const line of lines) {
    const tokens = line.trim().split(/[\s,\t]+/).filter(Boolean);
    if (tokens.length < 2) continue;
    const nums = tokens.map(Number);
    if (nums.some(isNaN)) {
      if (!headers) headers = tokens;
      continue;
    }
    rows.push(nums);
  }

  if (!rows.length) throw new Error('No numeric data found. Check that the data has at least 2 columns (Time, Signal).');

  const validRows = rows.filter(r => r.length >= 2);
  if (!validRows.length) throw new Error('No rows with ≥ 2 numeric columns found.');

  const nCols = validRows[0].length;
  const columns = Array.from({ length: nCols }, (_, ci) =>
    new Float64Array(validRows.map(r => r[ci] ?? NaN))
  );

  if (!headers) headers = Array.from({ length: nCols }, (_, i) => `Col${i + 1}`);

  console.debug(`[DT] parseAllColumns: ${validRows.length} rows × ${nCols} cols`);
  return { headers, columns, nRows: validRows.length };
}

// ════════════════════════════════════════════════════════════════════
//  2. SAMPLING QUALITY CHECK  (enhanced with jitter stats)
// ════════════════════════════════════════════════════════════════════
function checkUniformSampling(time) {
  if (time.length < 3) return {
    uniform: true, dt: time.length > 1 ? time[1] - time[0] : 0,
    dtMin: 0, dtMax: 0, jitterPct: 0, irregularCount: 0,
    fs: time.length > 1 ? 1 / (time[1] - time[0]) : 0,
  };

  const dts = [];
  for (let i = 1; i < time.length; i++) dts.push(time[i] - time[i - 1]);

  const dtMean = dts.reduce((a, b) => a + b, 0) / dts.length;
  const dtMin  = Math.min(...dts);
  const dtMax  = Math.max(...dts);
  const jitterPct = dtMean > 0 ? ((dtMax - dtMin) / dtMean) * 100 : 0;
  const tol    = dtMean * 0.01;
  const irregularCount = dts.filter(d => Math.abs(d - dtMean) > tol).length;
  const uniform = jitterPct < 1.0;

  if (!uniform) {
    console.warn(`[DT] Non-uniform sampling detected: jitter=${jitterPct.toFixed(2)}%, ${irregularCount} irregular intervals`);
  }

  return { uniform, dt: dtMean, dtMin, dtMax, jitterPct, irregularCount, fs: dtMean > 0 ? 1 / dtMean : 0 };
}

// ════════════════════════════════════════════════════════════════════
//  3. SIGNAL STATISTICS  (new — for diagnostics panel)
// ════════════════════════════════════════════════════════════════════
function computeSignalStats(values) {
  if (!values || !values.length) return null;
  let sum = 0, min = Infinity, max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / values.length;
  let variance = 0;
  for (const v of values) variance += (v - mean) ** 2;
  const stdDev = Math.sqrt(variance / values.length);
  return { mean, stdDev, min, max, peakToPeak: max - min, n: values.length };
}

// ════════════════════════════════════════════════════════════════════
//  4. EVENT / DISTURBANCE DETECTION  (new — analysis window suggestions)
//  Finds the region of largest gradient (disturbance onset) and the
//  subsequent oscillatory window. Returns suggestions only — never
//  automatically modifies user selections.
// ════════════════════════════════════════════════════════════════════
function suggestAnalysisWindows(time, signal) {
  if (time.length < 20) return null;

  const n   = signal.length;
  const dt  = n > 1 ? time[1] - time[0] : 1;

  // Gradient magnitude (central differences)
  const grad = new Float64Array(n);
  for (let i = 1; i < n - 1; i++)
    grad[i] = Math.abs((signal[i + 1] - signal[i - 1]) / (2 * dt));
  grad[0]     = grad[1];
  grad[n - 1] = grad[n - 2];

  // Smooth gradient to find coherent disturbance region
  const wSmooth = Math.max(5, Math.min(21, Math.floor(n * 0.02) | 1));
  const smoothGrad = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, cnt = 0;
    for (let k = -Math.floor(wSmooth / 2); k <= Math.floor(wSmooth / 2); k++) {
      const idx = Math.max(0, Math.min(n - 1, i + k));
      s += grad[idx]; cnt++;
    }
    smoothGrad[i] = s / cnt;
  }

  // Peak gradient index (disturbance onset)
  let peakGradIdx = 0;
  for (let i = 1; i < n; i++) if (smoothGrad[i] > smoothGrad[peakGradIdx]) peakGradIdx = i;

  // Suggest window starting shortly after onset, covering ~5 oscillation periods
  // Use a heuristic: window = min(signal_length - onset, 20% of total)
  const suggestStart = Math.min(peakGradIdx, Math.floor(n * 0.9));
  const suggestEnd   = Math.min(n - 1, suggestStart + Math.max(50, Math.floor(n * 0.4)));

  // Find second-largest gradient region for multi-disturbance signals
  const maskedGrad = Float64Array.from(smoothGrad);
  const maskRadius  = Math.floor(n * 0.1);
  for (let i = Math.max(0, peakGradIdx - maskRadius); i <= Math.min(n - 1, peakGradIdx + maskRadius); i++)
    maskedGrad[i] = 0;

  let peak2Idx = 0;
  for (let i = 1; i < n; i++) if (maskedGrad[i] > maskedGrad[peak2Idx]) peak2Idx = i;

  const suggestions = [
    {
      label:       'Largest Disturbance',
      description: `Disturbance onset at t=${time[peakGradIdx].toFixed(3)}s (max gradient). Suggested analysis window follows onset.`,
      tStart:      time[suggestStart],
      tEnd:        time[suggestEnd],
      iStart:      suggestStart,
      iEnd:        suggestEnd,
      gradMag:     smoothGrad[peakGradIdx],
    },
  ];

  if (maskedGrad[peak2Idx] > smoothGrad[peakGradIdx] * 0.3) {
    const s2Start = Math.min(peak2Idx, Math.floor(n * 0.9));
    const s2End   = Math.min(n - 1, s2Start + Math.max(50, Math.floor(n * 0.4)));
    suggestions.push({
      label:       'Second Disturbance',
      description: `Second event at t=${time[peak2Idx].toFixed(3)}s (gradient ${(maskedGrad[peak2Idx] / smoothGrad[peakGradIdx] * 100).toFixed(0)}% of primary).`,
      tStart:      time[s2Start],
      tEnd:        time[s2End],
      iStart:      s2Start,
      iEnd:        s2End,
      gradMag:     maskedGrad[peak2Idx],
    });
  }

  console.debug(`[DT] suggestAnalysisWindows: onset idx=${peakGradIdx} t=${time[peakGradIdx].toFixed(3)}s`);
  return suggestions;
}

// ════════════════════════════════════════════════════════════════════
//  5. SAVITZKY-GOLAY SMOOTHING FILTER  (unchanged)
// ════════════════════════════════════════════════════════════════════
function savgolFilter(y, w) {
  const n  = y.length;
  const hw = (w - 1) / 2;
  const out = new Float64Array(n);

  const weights = [];
  for (let i = -hw; i <= hw; i++) {
    const m   = hw;
    const num = 3 * m * m + 3 * m - 1 - 5 * i * i;
    const den = (2 * m - 1) * (2 * m + 1) * (2 * m + 3) / 3.0;
    weights.push(num / den);
  }

  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let k = 0; k < w; k++) {
      let idx = j - hw + k;
      if (idx < 0)  idx = -idx;
      if (idx >= n) idx = 2 * (n - 1) - idx;
      idx = Math.max(0, Math.min(n - 1, idx));
      s += weights[k] * y[idx];
    }
    out[j] = s;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════
//  6. SIGNAL PREPROCESSING  (unchanged calculation, adds stats return)
// ════════════════════════════════════════════════════════════════════
function preprocess(time, values, removeOffset, smoothWin) {
  validateSignalLength(values.length, SG_POLY_ORDER + 2, 'preprocessing');

  let offset = 0;
  if (removeOffset) {
    const tail = Math.min(STEADY_STATE_TAIL, values.length);
    let sum = 0;
    for (let i = values.length - tail; i < values.length; i++) sum += values[i];
    offset = sum / tail;
  }

  const detrended = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) detrended[i] = values[i] - offset;

  let w = Math.max(smoothWin, SG_POLY_ORDER + 1);
  if (w % 2 === 0) w++;
  const maxW = values.length % 2 !== 0 ? values.length : values.length - 1;
  w = Math.min(w, maxW);
  const smoothed = savgolFilter(detrended, w);

  // Compute signal stats on raw values (for diagnostics)
  const rawStats = computeSignalStats(values);

  return { time, raw: values, detrended, smoothed, steadyStateOffset: offset, rawStats };
}

// ════════════════════════════════════════════════════════════════════
//  7. PEAK DETECTION  (unchanged algorithm, enhanced feedback)
// ════════════════════════════════════════════════════════════════════
function findPeaks(arr, prominence) {
  const allCandidates = [];
  for (let i = 1; i < arr.length - 1; i++)
    if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1]) allCandidates.push(i);

  if (prominence <= 0) return { accepted: allCandidates, rejected: [], allCandidates };

  const accepted = [], rejected = [];
  for (const p of allCandidates) {
    let lMin = arr[p], rMin = arr[p];
    for (let i = p - 1; i >= 0;         i--) { if (arr[i] < lMin) lMin = arr[i]; if (arr[i] > arr[p]) break; }
    for (let i = p + 1; i < arr.length; i++) { if (arr[i] < rMin) rMin = arr[i]; if (arr[i] > arr[p]) break; }
    if ((arr[p] - Math.max(lMin, rMin)) >= prominence) accepted.push(p);
    else rejected.push(p);
  }
  return { accepted, rejected, allCandidates };
}

// ════════════════════════════════════════════════════════════════════
//  8. EXPONENTIAL ENVELOPE FIT  (unchanged)
// ════════════════════════════════════════════════════════════════════
function fitExponentialEnvelope(peakTimes, peakValues) {
  const pts = peakTimes.map((t, i) => ({ t, v: peakValues[i] })).filter(p => p.v > 0);
  if (pts.length < 2) return null;

  const lny  = pts.map(p => Math.log(p.v));
  const t    = pts.map(p => p.t);
  const n    = pts.length;
  const sumT = t.reduce((a, b) => a + b, 0);
  const sumY = lny.reduce((a, b) => a + b, 0);
  const sumTY = t.reduce((a, v, i) => a + v * lny[i], 0);
  const sumT2 = t.reduce((a, v) => a + v * v, 0);

  const slope     = (n * sumTY - sumT * sumY) / (n * sumT2 - sumT * sumT);
  const intercept = (sumY - slope * sumT) / n;

  return { A: Math.exp(intercept), sigma: -slope };
}

// ════════════════════════════════════════════════════════════════════
//  9. PEAK-ENVELOPE DAMPING METHOD  (unchanged calculation)
//     Enhanced: returns peak feedback counts and classification
// ════════════════════════════════════════════════════════════════════
function runPeakEnvelope(signalData, numPeaks, prominence) {
  // Validate inputs
  const valErrs = validatePeakParams(numPeaks, prominence);
  if (valErrs.length) throw new Error('Input validation: ' + valErrs.join(' | '));

  const { smoothed, time, steadyStateOffset } = signalData;
  const methodLabel = steadyStateOffset !== 0
    ? 'OFFSET METHOD (Steady-State Removed)'
    : 'DIRECT METHOD (No Offset Removal)';

  const peakResult = findPeaks(smoothed, prominence);
  let peakIdx = peakResult.accepted;

  if (!peakIdx.length) throw new Error('No peaks detected. Try reducing the Prominence threshold, or increase the Smooth Window to clarify oscillations.');

  const allDetected  = peakIdx.length;
  const negFiltered  = peakIdx.filter(i => smoothed[i] <= 0).length;
  peakIdx = peakIdx.filter(i => smoothed[i] > 0);

  if (peakIdx.length < 2) throw new Error(`Only ${peakIdx.length} positive peak(s) remain after filtering; need ≥ 2 for damping calculation. Check offset removal setting.`);

  const n = Math.max(MIN_PEAKS, Math.min(MAX_PEAKS, numPeaks));
  const truncated = peakIdx.length > n;
  peakIdx = peakIdx.slice(0, n);

  const peakTimes  = peakIdx.map(i => time[i]);
  const peakValues = peakIdx.map(i => smoothed[i]);
  const envelope   = fitExponentialEnvelope(peakTimes, peakValues);

  const pairs = [], zetaList = [], sigmaList = [], halfList = [], freqList = [];

  for (let i = 0; i < peakValues.length - 1; i++) {
    const y1 = peakValues[i], y2 = peakValues[i + 1];
    const t1 = peakTimes[i],  t2 = peakTimes[i + 1];
    if (y1 <= 0 || y2 <= 0) continue;

    const delta  = Math.log(y1 / y2);
    const dt     = t2 - t1;
    const sigma  = delta / dt;
    const zeta   = delta / Math.sqrt(4 * Math.PI ** 2 + delta ** 2);
    const halfT  = sigma > 0 ? Math.LN2 / sigma : Infinity;
    const freqHz = 1.0 / dt;

    pairs.push({ pairIndex: i + 1, time1: t1, peak1: y1, time2: t2, peak2: y2,
                 logDecrement: delta, sigma, dampingRatio: zeta, frequencyHz: freqHz, halvingTime: halfT });
    zetaList.push(zeta); sigmaList.push(sigma); halfList.push(halfT); freqList.push(freqHz);
  }
  if (!pairs.length) throw new Error('All pairs skipped (non-positive values). Verify offset removal is appropriate for this signal.');

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = arr => { const m = avg(arr); return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length); };

  const avgFreq = avg(freqList);
  const classification = classifyOscillation(avgFreq);

  console.debug(`[DT] Peak Envelope: detected=${allDetected} rejected_neg=${negFiltered} used=${peakIdx.length} pairs=${pairs.length} ζ_avg=${avg(zetaList).toFixed(4)} class=${classification}`);

  return {
    methodLabel, pairs, peakTimes, peakValues, envelope,
    avgDampingRatio: avg(zetaList),
    stdDampingRatio: std(zetaList),
    avgSigma:        avg(sigmaList),
    avgHalvingTime:  avg(halfList),
    avgFrequency:    avgFreq,
    stdFrequency:    std(freqList),
    classification,
    // Peak feedback
    peakFeedback: {
      allCandidates:     peakResult.allCandidates.length,
      rejectedProminence: peakResult.rejected.length,
      acceptedAfterProminence: allDetected,
      rejectedNegative:  negFiltered,
      usedForAnalysis:   peakIdx.length,
      truncated,
      pairsUsed:         pairs.length,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
//  10. FFT  (unchanged)
// ════════════════════════════════════════════════════════════════════
function fft(re, im) {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k]           = uRe + vRe; im[i + k]           = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe; curRe = newRe;
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════
//  11. POWER SPECTRAL DENSITY  (unchanged)
// ════════════════════════════════════════════════════════════════════
function computePSD(signal, dt) {
  let N = 1;
  while (N < signal.length && N < 16384) N <<= 1;

  const re = new Float64Array(N), im = new Float64Array(N);
  let wSum = 0;
  for (let i = 0; i < Math.min(signal.length, N); i++) {
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
    re[i] = signal[i] * w;
    wSum += w * w;
  }

  fft(re, im);

  const fs = 1 / dt, psd = [], freqs = [];
  const nHalf = Math.floor(N / 2) + 1;
  for (let k = 0; k < nHalf; k++) {
    let mag2 = re[k] * re[k] + im[k] * im[k];
    if (k > 0 && k < nHalf - 1) mag2 *= 2;
    psd.push(mag2 / (fs * N * wSum));
    freqs.push(k * fs / N);
  }

  return { freqs, psd, fs, N };
}

function estimateSNR(psdArr, domIdx) {
  const peakPow   = psdArr[domIdx];
  const noise     = psdArr.filter((_, i) => Math.abs(i - domIdx) > 3);
  if (!noise.length) return null;
  const noiseMean = noise.reduce((a, b) => a + b, 0) / noise.length;
  return 10 * Math.log10(peakPow / (noiseMean || 1e-30));
}

// ════════════════════════════════════════════════════════════════════
//  12. COMPLEX NUMBER HELPERS  (unchanged)
// ════════════════════════════════════════════════════════════════════
const C = {
  add:   (a, b) => ({ re: a.re + b.re, im: a.im + b.im }),
  sub:   (a, b) => ({ re: a.re - b.re, im: a.im - b.im }),
  mul:   (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }),
  div:   (a, b) => { const d = b.re ** 2 + b.im ** 2; return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }; },
  exp:   (a)    => { const e = Math.exp(a.re); return { re: e * Math.cos(a.im), im: e * Math.sin(a.im) }; },
  log:   (a)    => { const r = Math.sqrt(a.re ** 2 + a.im ** 2); return { re: r > 1e-300 ? Math.log(r) : -690, im: Math.atan2(a.im, a.re) }; },
  abs:   (a)    => Math.sqrt(a.re ** 2 + a.im ** 2),
  scale: (a, s) => ({ re: a.re * s, im: a.im * s }),
};

// ════════════════════════════════════════════════════════════════════
//  13. LINEAR ALGEBRA  (unchanged)
// ════════════════════════════════════════════════════════════════════
function leastSquaresReal(A, b) {
  const m = A[0].length, n = A.length;
  const AtA = Array.from({ length: m }, () => new Float64Array(m));
  const Atb = new Float64Array(m);
  for (let i = 0; i < m; i++)
    for (let j = 0; j < m; j++)
      for (let k = 0; k < n; k++) AtA[i][j] += A[k][i] * A[k][j];
  for (let i = 0; i < m; i++)
    for (let k = 0; k < n; k++) Atb[i] += A[k][i] * b[k];

  const aug = AtA.map((row, i) => [...row, Atb[i]]);
  for (let col = 0; col < m; col++) {
    let maxR = col;
    for (let r = col + 1; r < m; r++)
      if (Math.abs(aug[r][col]) > Math.abs(aug[maxR][col])) maxR = r;
    [aug[col], aug[maxR]] = [aug[maxR], aug[col]];
    const piv = aug[col][col];
    if (Math.abs(piv) < 1e-14) continue;
    for (let r = col + 1; r < m; r++) {
      const f = aug[r][col] / piv;
      for (let c = col; c <= m; c++) aug[r][c] -= f * aug[col][c];
    }
  }
  const x = new Float64Array(m);
  for (let i = m - 1; i >= 0; i--) {
    x[i] = aug[i][m];
    for (let j = i + 1; j < m; j++) x[i] -= aug[i][j] * x[j];
    x[i] /= aug[i][i] || 1e-15;
  }
  return x;
}

function leastSquaresComplex(vandermonde, signal) {
  const n = signal.length, m = vandermonde[0].length;
  const A = [], b = [];
  for (let i = 0; i < n; i++) {
    A.push([...vandermonde[i].map(v => v.re), ...vandermonde[i].map(v => -v.im)]);
    b.push(signal[i]);
  }
  for (let i = 0; i < n; i++) {
    A.push([...vandermonde[i].map(v => v.im), ...vandermonde[i].map(v => v.re)]);
    b.push(0);
  }
  const x = leastSquaresReal(A, b);
  return Array.from({ length: m }, (_, j) => ({ re: x[j], im: x[j + m] }));
}

function aberthRoots(monic, n) {
  const roots = [];
  for (let k = 0; k < n; k++) {
    const a = 2 * Math.PI * k / n + 0.1;
    roots.push({ re: Math.cos(a) * 0.9, im: Math.sin(a) * 0.9 });
  }

  const evalPoly  = z => { let v = { re: monic[0], im: 0 }; for (let i = 1; i <= n; i++) v = C.add(C.mul(v, z), { re: monic[i] || 0, im: 0 }); return v; };
  const evalDeriv = z => { let v = { re: monic[0] * n, im: 0 }; for (let i = 1; i < n; i++) v = C.add(C.mul(v, z), { re: monic[i] * (n - i), im: 0 }); return v; };

  for (let iter = 0; iter < 80; iter++) {
    for (let k = 0; k < n; k++) {
      const fz = evalPoly(roots[k]), fp = evalDeriv(roots[k]);
      if (C.abs(fz) < 1e-14) continue;
      let sum = { re: 0, im: 0 };
      for (let j = 0; j < n; j++) {
        if (j === k) continue;
        const d = C.sub(roots[k], roots[j]);
        if (C.abs(d) < 1e-15) continue;
        sum = C.add(sum, C.div({ re: 1, im: 0 }, d));
      }
      const denom = C.sub(C.div(fp, fz), sum);
      if (C.abs(denom) < 1e-15) continue;
      roots[k] = C.sub(roots[k], C.div({ re: 1, im: 0 }, denom));
    }
  }
  return roots;
}

// ════════════════════════════════════════════════════════════════════
//  14. PRONY DECOMPOSITION  (unchanged)
// ════════════════════════════════════════════════════════════════════
function pronyDecompose(timeWindow, sigWindow, numModes) {
  const n = sigWindow.length, m = numModes;
  if (n <= m) throw new Error(`Window length (${n} samples) must exceed number of Prony modes (${m}). Increase the window or reduce modes.`);

  const H = [], tgt = [];
  for (let i = 0; i < n - m; i++) {
    const row = [];
    for (let j = 0; j < m; j++) row.push(sigWindow[i + (m - 1 - j)]);
    H.push(row);
    tgt.push(sigWindow[i + m]);
  }
  const d = leastSquaresReal(H, tgt);

  const charPoly = new Float64Array(m + 1);
  charPoly[0] = 1;
  for (let i = 0; i < m; i++) charPoly[i + 1] = -d[i];
  const roots = aberthRoots(Array.from(charPoly), m);

  const dt = timeWindow[1] - timeWindow[0];
  const exponents = roots.map(z => {
    const safeZ = C.abs(z) > 1e-12 ? z : { re: 1e-12, im: 0 };
    return C.scale(C.log(safeZ), 1 / dt);
  });

  const V = [];
  for (let i = 0; i < n; i++) {
    V.push(roots.map(r => {
      const safeR = C.abs(r) > 1e-12 ? r : { re: 1e-12, im: 0 };
      let val = { re: 1, im: 0 };
      for (let k = 0; k < i; k++) val = C.mul(val, safeR);
      return val;
    }));
  }
  const amplitudes = leastSquaresComplex(V, Array.from(sigWindow));
  return { amplitudes, exponents };
}

function findActiveStart(signal, energyFraction) {
  let peak = 0;
  for (const v of signal) if (Math.abs(v) > peak) peak = Math.abs(v);
  if (peak === 0) return 0;
  const thresh = energyFraction * peak;
  for (let i = 0; i < signal.length; i++) if (Math.abs(signal[i]) >= thresh) return i;
  return 0;
}

function timeToSampleIndex(time, t) {
  let lo = 0, hi = time.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (time[mid] < t) lo = mid + 1; else hi = mid; }
  return Math.max(0, Math.min(time.length - 1, lo));
}

// ════════════════════════════════════════════════════════════════════
//  15. PRONY RUNNER  (unchanged calculation, enhanced validation + classification)
// ════════════════════════════════════════════════════════════════════
function runProny(signalData, numModes, windowLength, energyFraction,
                  freqMin, freqMax, pronySmooth, pronySmoothWin,
                  manualWindowT0, manualWindowT1) {

  // Validate parameters
  const valErrs = validatePronyParams(numModes, windowLength, freqMin, freqMax);
  if (valErrs.length) throw new Error('Prony parameter validation: ' + valErrs.join(' | '));

  const { time, detrended } = signalData;

  let workingSignal = detrended;
  if (pronySmooth) {
    let sw = Math.max(pronySmoothWin, SG_POLY_ORDER + 1);
    if (sw % 2 === 0) sw++;
    const maxW = workingSignal.length % 2 !== 0 ? workingSignal.length : workingSignal.length - 1;
    sw = Math.min(sw, maxW);
    workingSignal = savgolFilter(detrended, sw);
  }

  let iStart, iEnd;
  if (manualWindowT0 !== null && manualWindowT1 !== null) {
    iStart = timeToSampleIndex(time, manualWindowT0);
    iEnd   = timeToSampleIndex(time, manualWindowT1);
    if (iEnd <= iStart) iEnd = Math.min(iStart + numModes + 2, time.length);
  } else {
    iStart = findActiveStart(workingSignal, energyFraction);
    iEnd   = Math.min(iStart + windowLength, time.length);
    if ((iEnd - iStart) <= numModes) iEnd = Math.min(iStart + numModes + 2, time.length);
  }

  const actualWindowLen = iEnd - iStart;
  if (actualWindowLen <= numModes) {
    throw new Error(`Effective window (${actualWindowLen} samples) is too small for ${numModes} modes. Reduce modes or extend the analysis window.`);
  }

  const timeWin = time.slice(iStart, iEnd);
  const sigWin  = workingSignal.slice(iStart, iEnd);

  const { amplitudes, exponents } = pronyDecompose(Array.from(timeWin), Array.from(sigWin), numModes);

  const t0 = timeWin[0];
  const fittedWin = new Float64Array(timeWin.length);
  for (let i = 0; i < timeWin.length; i++) {
    const tRel = timeWin[i] - t0;
    let sum = 0;
    for (let k = 0; k < amplitudes.length; k++) {
      const b  = exponents[k];
      const ex = C.exp({ re: b.re * tRel, im: b.im * tRel });
      sum += amplitudes[k].re * ex.re - amplitudes[k].im * ex.im;
    }
    fittedWin[i] = sum;
  }

  const fittedFull = new Float64Array(time.length);
  for (let i = 0; i < timeWin.length; i++) fittedFull[iStart + i] = fittedWin[i];

  const allModes = [];
  for (let k = 0; k < amplitudes.length; k++) {
    const amp       = amplitudes[k];
    const exp       = exponents[k];
    const dampRate  = -exp.re;
    const angFreq   = exp.im;
    if (angFreq < 0) continue;

    const freqHz  = Math.abs(angFreq) / (2 * Math.PI);
    const physAmp = 2 * C.abs(amp);
    const denom   = Math.sqrt(dampRate ** 2 + angFreq ** 2);
    const zeta    = denom > 0 ? dampRate / denom : 0;
    const period  = freqHz > 0 ? 1 / freqHz : Infinity;
    const classification = classifyOscillation(freqHz);

    allModes.push({
      index: k + 1,
      amplitude:    physAmp,
      frequencyHz:  freqHz,
      period,
      dampingRate:  dampRate,
      dampingRatio: zeta,
      unstable:     zeta > 1.0,
      inBand:       freqHz >= freqMin && freqHz <= freqMax,
      isDamped:     dampRate > 0,
      classification,
    });
  }
  allModes.sort((a, b) => b.amplitude - a.amplitude);

  const modes = allModes.filter(m => m.inBand && m.isDamped);

  let sigMean = 0;
  for (const v of sigWin) sigMean += v;
  sigMean /= sigWin.length;

  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < sigWin.length; i++) {
    ssRes += (sigWin[i] - fittedWin[i]) ** 2;
    ssTot += (sigWin[i] - sigMean) ** 2;
  }
  const r2   = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const rmse = Math.sqrt(ssRes / sigWin.length);

  // Dominant mode for classification
  const domMode = modes.length > 0 ? modes[0] : (allModes.length > 0 ? allModes[0] : null);
  const classification = domMode ? classifyOscillation(domMode.frequencyHz) : 'Unknown';

  console.debug(`[DT] Prony: window=[${iStart}-${iEnd}] (${actualWindowLen}s) modes=${allModes.length} dominant=${modes.length} R²=${r2.toFixed(4)} class=${classification}`);

  return { modes, allModes, fittedSignal: fittedFull, rSquared: r2, rmse,
           activeStart: iStart, activeEnd: iEnd, freqMin, freqMax, classification };
}

// ════════════════════════════════════════════════════════════════════
//  16. COMPARISON DATA BUILDER  (new — Peak vs Prony summary)
// ════════════════════════════════════════════════════════════════════
function buildComparisonData(peakRes, pronyRes) {
  if (!peakRes || !pronyRes || !pronyRes.modes.length) return null;
  const dom = pronyRes.modes[0];
  return {
    frequency: {
      peak:   peakRes.avgFrequency,
      prony:  dom.frequencyHz,
      diff:   Math.abs(peakRes.avgFrequency - dom.frequencyHz),
      diffPct: peakRes.avgFrequency > 0 ? Math.abs(peakRes.avgFrequency - dom.frequencyHz) / peakRes.avgFrequency * 100 : null,
    },
    dampingRatio: {
      peak:   peakRes.avgDampingRatio,
      prony:  dom.dampingRatio,
      diff:   Math.abs(peakRes.avgDampingRatio - dom.dampingRatio),
      diffPct: peakRes.avgDampingRatio > 0 ? Math.abs(peakRes.avgDampingRatio - dom.dampingRatio) / peakRes.avgDampingRatio * 100 : null,
    },
    sigma: {
      peak:   peakRes.avgSigma,
      prony:  dom.dampingRate,
      diff:   Math.abs(peakRes.avgSigma - dom.dampingRate),
      diffPct: peakRes.avgSigma > 0 ? Math.abs(peakRes.avgSigma - dom.dampingRate) / peakRes.avgSigma * 100 : null,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
//  17. EXPORT METADATA BUILDER  (new)
// ════════════════════════════════════════════════════════════════════
function buildExportMetadata(signalData, sampInfo, method, settings) {
  return {
    exportDate:   new Date().toISOString(),
    toolVersion:  TOOL_VERSION,
    method,
    sampleCount:  signalData.time.length,
    duration_s:   signalData.time.length > 1 ? signalData.time[signalData.time.length - 1] - signalData.time[0] : 0,
    fs_Hz:        sampInfo.fs,
    dt_mean_s:    sampInfo.dt,
    dt_min_s:     sampInfo.dtMin,
    dt_max_s:     sampInfo.dtMax,
    jitter_pct:   sampInfo.jitterPct,
    uniform:      sampInfo.uniform,
    settings,
  };
}

// ════════════════════════════════════════════════════════════════════
//  18. RESULT FORMATTERS  (enhanced with new sections, calculations unchanged)
// ════════════════════════════════════════════════════════════════════
function pad(str, w) { return String(str).padStart(w); }

function fmtPeakResult(result) {
  const cols   = ['Pair','Time1(s)','Peak1','Time2(s)','Peak2','LogDec','Sigma','DampRatio','Freq(Hz)','HalfT(s)'];
  const widths = [5,9,10,9,10,10,10,10,9,10];
  const header = cols.map((c, i) => pad(c, widths[i])).join(' ');
  const sep    = '-'.repeat(header.length);

  const rows = result.pairs.map(p => [
    pad(p.pairIndex,  widths[0]),
    pad(p.time1.toFixed(4),         widths[1]),
    pad(p.peak1.toFixed(4),         widths[2]),
    pad(p.time2.toFixed(4),         widths[3]),
    pad(p.peak2.toFixed(4),         widths[4]),
    pad(p.logDecrement.toFixed(6),  widths[5]),
    pad(p.sigma.toFixed(6),         widths[6]),
    pad(p.dampingRatio.toFixed(6),  widths[7]),
    pad(p.frequencyHz.toFixed(4),   widths[8]),
    pad(p.halvingTime === Infinity ? 'Inf' : p.halvingTime.toFixed(4), widths[9]),
  ].join(' ')).join('\n');

  const zetaPass = result.avgDampingRatio >= COMPLIANCE_MIN_DAMPING;
  const halfPass = result.avgHalvingTime  <= COMPLIANCE_MAX_HALVING_T;
  const envLine  = result.envelope
    ? `Envelope fit:      A = ${result.envelope.A.toFixed(4)} MW,  σ_env = ${result.envelope.sigma.toFixed(4)} Np/s\n`
    : '';

  const fb = result.peakFeedback;
  const feedbackLines = fb ? [
    '',
    `===== PEAK DETECTION FEEDBACK =====`,
    `Candidates found:    ${fb.allCandidates}`,
    `Rejected (prominence): ${fb.rejectedProminence}`,
    `Accepted (prominence): ${fb.acceptedAfterProminence}`,
    `Rejected (negative):   ${fb.rejectedNegative}`,
    `Used for analysis:     ${fb.usedForAnalysis}${fb.truncated ? ' (truncated to ' + fb.usedForAnalysis + ')' : ''}`,
    `Peak pairs used:       ${fb.pairsUsed}`,
  ] : [];

  return [
    `===== ${result.methodLabel} =====\n`,
    header, sep, rows, '',
    `Average Damping Ratio  = ${result.avgDampingRatio.toFixed(4)}  ±${result.stdDampingRatio.toFixed(4)} (std)`,
    `Average Sigma          = ${result.avgSigma.toFixed(4)} Np/s`,
    `Average Halving Time   = ${result.avgHalvingTime.toFixed(4)} s`,
    `Average Frequency      = ${result.avgFrequency.toFixed(4)} Hz  ±${result.stdFrequency.toFixed(4)}`,
    `Oscillation Class      = ${result.classification}`,
    envLine,
    '===== COMPLIANCE CHECK =====',
    `${zetaPass ? 'PASS ✓' : 'FAIL ✗'}  Damping Ratio (${zetaPass ? '≥' : '<'} ${COMPLIANCE_MIN_DAMPING})`,
    `${halfPass ? 'PASS ✓' : 'FAIL ✗'}  Halving Time  (${halfPass ? '≤' : '>'} ${COMPLIANCE_MAX_HALVING_T} s)`,
    ...feedbackLines,
  ].join('\n');
}

function fmtPronyResult(result, numModes, windowLen, signalData, showAll) {
  const t = signalData.time;
  const t0 = t[result.activeStart];
  const t1 = t[Math.min(result.activeEnd, t.length - 1)];
  const activeSamples = result.activeEnd - result.activeStart;
  const displayModes = showAll ? result.allModes : result.modes;

  const lines = [
    `Prony Analysis  |  Modes=${numModes}  Window=${windowLen} samples`,
    `Freq range: [${result.freqMin.toFixed(2)}, ${result.freqMax.toFixed(2)}] Hz`,
    '='.repeat(64),
    `Active window: [${result.activeStart}–${result.activeEnd}]  (${t0.toFixed(3)}s–${t1.toFixed(3)}s,  ${activeSamples} samples)`,
    `R² = ${result.rSquared.toFixed(6)}   RMSE = ${result.rmse.toFixed(4)} MW`,
    `Oscillation Class: ${result.classification}`,
    '',
  ];

  if (!displayModes.length) {
    lines.push(`⚠  No modes found in [${result.freqMin}, ${result.freqMax}] Hz with σ>0.`);
    lines.push('Try: increase Modes or Window, lower Energy Threshold, or widen freq range.');
  } else {
    const hdr = `${'Mode'.padStart(5)} ${'Amp'.padStart(10)} ${'Freq(Hz)'.padStart(9)} ${'Period(s)'.padStart(10)} ${'σ(Np/s)'.padStart(9)} ${'ζ'.padStart(8)} ${'Class'.padStart(14)} ${'Flag'.padStart(10)}`;
    lines.push(showAll
      ? '--- ALL MODES (including out-of-band) ---'
      : `--- DOMINANT MODES in [${result.freqMin.toFixed(2)}–${result.freqMax.toFixed(2)}] Hz ---`
    );
    lines.push(hdr, '-'.repeat(hdr.length));

    for (const m of displayModes) {
      let flag;
      if (!m.inBand)                  flag = 'OUT-BAND';
      else if (!m.isDamped)           flag = '⚠ NEGDAMP';
      else if (m.dampingRatio < 0.10) flag = '⚠ LOW';
      else if (m.unstable)            flag = '⚠ OVR';
      else                            flag = 'OK';
      lines.push(
        `${String(m.index).padStart(5)} ${m.amplitude.toFixed(5).padStart(10)} ${m.frequencyHz.toFixed(4).padStart(9)} ${m.period.toFixed(4).padStart(10)} ${m.dampingRate.toFixed(4).padStart(9)} ${m.dampingRatio.toFixed(4).padStart(8)} ${m.classification.padStart(14)} ${flag.padStart(10)}`
      );
    }
    if (!showAll && result.allModes.length > result.modes.length) {
      lines.push('');
      lines.push(`(${result.allModes.length - result.modes.length} mode(s) outside freq range or negatively damped — enable "Show All Modes" to view)`);
    }
  }
  return lines.join('\n');
}
