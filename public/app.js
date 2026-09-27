const canvas = document.querySelector('#waterCanvas');
const frame = document.querySelector('#canvasFrame');
const ctx = canvas.getContext('2d', { alpha: false });
const simCanvas = document.createElement('canvas');
const simCtx = simCanvas.getContext('2d', { alpha: false });
const ui = {
  waveSize: document.querySelector('#waveSize'),
  waveSizeValue: document.querySelector('#waveSizeValue'),
  xReadout: document.querySelector('#xReadout'),
  yReadout: document.querySelector('#yReadout'),
  amplitudeReadout: document.querySelector('#amplitudeReadout'),
  tapHint: document.querySelector('#tapHint'),
  boundaryDescription: document.querySelector('#boundaryDescription'),
  statusText: document.querySelector('#statusText'),
  pauseButton: document.querySelector('#pauseButton'),
  clearButton: document.querySelector('#clearButton'),
};

// The grid is square: the visible water plus a hidden absorber on every side.
const viewSize = 180;
const absorberWidth = 48;
const gridSize = viewSize + absorberWidth * 2;
const viewStart = absorberWidth;
const viewEnd = viewStart + viewSize - 1;

// Simulation parameters.
const waveCoefficient = .22; // (c*dt/dx)^2, kept well inside the 2D stability limit of 0.5
const courant = Math.sqrt(waveCoefficient);
const radiationCoefficient = (courant - 1) / (courant + 1);
const wallLoss = .0015;
const spongeStrength = .42;
const maxHeight = 20; // Cells beyond this are treated as numerical blow-up and reset.
const initialVelocityFactor = .18;
const sourceSizeBase = 600; // Preset sizes are in 1/600ths of the view width.
const stepMs = 1000 / 120;

// Display and input parameters.
const amplitudeScale = 500;
const dragSpacing = 12; // CSS px between sources while dragging.
const shiftRepeatInterval = 180;
const wavePresets = [
  { strength: 20, size: 4 },
  { strength: 30, size: 6 },
  { strength: 40, size: 8 },
  { strength: 50, size: 10 },
  { strength: 60, size: 12 },
  { strength: 70, size: 14 },
  { strength: 80, size: 16 },
];

let current = new Float32Array(gridSize * gridSize);
let previous = new Float32Array(gridSize * gridSize);
let next = new Float32Array(gridSize * gridSize);
const image = simCtx.createImageData(viewSize, viewSize);
let boundary = 'open';
let paused = false;
let interacted = false;
let needsRender = true;
const pointers = new Map();

function isVisible(x, y) {
  return x >= viewStart && x <= viewEnd && y >= viewStart && y <= viewEnd;
}

// The sponge damping depends only on position, so compute it once.
// The absorber lies completely outside the visible water surface.
// A cubic ramp avoids an impedance jump where the sponge begins.
const spongeDamping = new Float64Array(gridSize * gridSize);
for (let y = 0; y < gridSize; y++) {
  for (let x = 0; x < gridSize; x++) {
    const outside = Math.max(viewStart - x, x - viewEnd, viewStart - y, y - viewEnd, 0);
    const depth = outside / absorberWidth;
    spongeDamping[y * gridSize + x] = spongeStrength * depth * depth * depth;
  }
}

function conserveVisibleVolume(field) {
  let sum = 0;
  const count = viewSize * viewSize;
  for (let y = viewStart; y <= viewEnd; y++) {
    for (let x = viewStart; x <= viewEnd; x++) sum += field[y * gridSize + x];
  }
  const mean = sum / count;
  if (Math.abs(mean) < 1e-12) return;
  for (let y = viewStart; y <= viewEnd; y++) {
    for (let x = viewStart; x <= viewEnd; x++) field[y * gridSize + x] -= mean;
  }
}

// Do not let waves retained in the hidden absorber return after toggling.
function clearAbsorber() {
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      if (isVisible(x, y)) continue;
      const i = y * gridSize + x;
      current[i] = 0; previous[i] = 0; next[i] = 0;
    }
  }
}

function resize() {
  const rect = frame.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  // Resizing clears the canvas bitmap.
  needsRender = true;
}

function disturb(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const normalizedX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const normalizedY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  // Pixel centres are at n + 0.5. Keeping the source position fractional
  // avoids round() consistently selecting the lower-right of the four cells.
  const localX = normalizedX * viewSize - .5;
  const localY = normalizedY * viewSize - .5;
  const x = localX + viewStart;
  const y = localY + viewStart;
  const preset = wavePresets[Number(ui.waveSize.value)];
  const radius = preset.size * viewSize / sourceSizeBase;
  const strength = preset.strength / 100;
  // At 4 sigma the Ricker tail is ~0.2% of the peak, so the cutoff leaves no
  // visible step. The cutoff is circular; a square one printed a square halo.
  const reach = radius * 4;
  const reach2 = reach * reach;
  const minX = Math.max(viewStart + 1, Math.floor(x - reach));
  const maxX = Math.min(viewEnd - 1, Math.ceil(x + reach));
  const minY = Math.max(viewStart + 1, Math.floor(y - reach));
  const maxY = Math.min(viewEnd - 1, Math.ceil(y + reach));
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const dx = px - x;
      const dy = py - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > reach2) continue;
      // A Ricker-like source has nearly zero net displacement. A positive-only
      // Gaussian would keep raising the mean water level in a closed basin.
      const normalized = d2 / (2 * radius * radius);
      const impulse = (1 - normalized) * Math.exp(-normalized) * strength;
      current[py * gridSize + px] += impulse;
      previous[py * gridSize + px] -= impulse * initialVelocityFactor;
    }
  }
  // Enforce the discrete volume invariant exactly. Truncating the source near
  // an edge otherwise leaves a small DC component after every interaction.
  // OPEN has no volume invariant; shifting only the visible area there would
  // leave a step at the sponge boundary that radiates spurious waves.
  if (boundary === 'reflect') {
    conserveVisibleVolume(current);
    conserveVisibleVolume(previous);
  }
  needsRender = true;
  ui.xReadout.textContent = normalizedX.toFixed(3);
  ui.yReadout.textContent = normalizedY.toFixed(3);
  if (!interacted) {
    interacted = true;
    ui.tapHint.style.opacity = '0';
  }
}

function sanitize(value) {
  return Number.isFinite(value) && Math.abs(value) < maxHeight ? value : 0;
}

// Returns the summed absolute height of the visible water.
function stepReflect() {
  // Zero normal flux at the wall. A missing neighbour equals the boundary
  // cell itself, keeping the discrete Laplacian symmetric and non-amplifying.
  let amplitude = 0;
  for (let y = viewStart; y <= viewEnd; y++) {
    for (let x = viewStart; x <= viewEnd; x++) {
      const i = y * gridSize + x;
      const left = x === viewStart ? i : i - 1;
      const right = x === viewEnd ? i : i + 1;
      const up = y === viewStart ? i : i - gridSize;
      const down = y === viewEnd ? i : i + gridSize;
      const laplacian = current[left] + current[right] + current[up] + current[down] - 4 * current[i];
      next[i] = sanitize((2 * current[i] - (1 - wallLoss) * previous[i] + waveCoefficient * laplacian) / (1 + wallLoss));
      amplitude += Math.abs(next[i]);
    }
  }
  // Remove floating-point drift in the zero-frequency mode on every step.
  // This guarantees sum(height) stays constant through any number of bounces.
  conserveVisibleVolume(next);
  return amplitude;
}

// Returns the summed absolute height of the visible water.
function stepOpen() {
  let amplitude = 0;
  for (let y = 1; y < gridSize - 1; y++) {
    for (let x = 1; x < gridSize - 1; x++) {
      const i = y * gridSize + x;
      const laplacian = current[i - 1] + current[i + 1] + current[i - gridSize] + current[i + gridSize] - 4 * current[i];
      const sigma = spongeDamping[i];
      // Discretisation of u_tt + 2*sigma*u_t = c^2*Laplacian(u).
      // Damping velocity rather than displacement reduces sponge reflections.
      next[i] = sanitize((2 * current[i] - (1 - sigma) * previous[i] + waveCoefficient * laplacian) / (1 + sigma));
      if (isVisible(x, y)) amplitude += Math.abs(next[i]);
    }
  }
  applyRadiationBoundary();
  return amplitude;
}

// Sommerfeld radiation condition in its first-order discrete (Mur) form.
// The remaining outer-edge error has already crossed the 48-cell sponge.
function applyRadiationBoundary() {
  for (let x = 1; x < gridSize - 1; x++) {
    next[x] = current[gridSize + x] + radiationCoefficient * (next[gridSize + x] - current[x]);
    const bottom = (gridSize - 1) * gridSize + x;
    next[bottom] = current[bottom - gridSize] + radiationCoefficient * (next[bottom - gridSize] - current[bottom]);
  }
  for (let y = 1; y < gridSize - 1; y++) {
    const left = y * gridSize;
    const right = left + gridSize - 1;
    next[left] = current[left + 1] + radiationCoefficient * (next[left + 1] - current[left]);
    next[right] = current[right - 1] + radiationCoefficient * (next[right - 1] - current[right]);
  }
  next[0] = (next[1] + next[gridSize]) * .5;
  next[gridSize - 1] = (next[gridSize - 2] + next[2 * gridSize - 1]) * .5;
  const bottomLeft = (gridSize - 1) * gridSize;
  const bottomRight = gridSize * gridSize - 1;
  next[bottomLeft] = (next[bottomLeft + 1] + next[bottomLeft - gridSize]) * .5;
  next[bottomRight] = (next[bottomRight - 1] + next[bottomRight - gridSize]) * .5;
}

function step() {
  const amplitude = boundary === 'reflect' ? stepReflect() : stepOpen();
  [previous, current, next] = [current, next, previous];
  return amplitude;
}

function render() {
  const data = image.data;
  // In REFLECT the cells outside the wall stay zero. Match step()'s zero-flux
  // wall by treating a missing neighbour as the boundary cell itself, or the
  // edge pixels would be shaded against zero and draw a bright/dark rim.
  const reflect = boundary === 'reflect';
  const last = viewSize - 1;
  for (let localY = 0; localY < viewSize; localY++) {
    const up = reflect && localY === 0 ? 0 : -gridSize;
    const down = reflect && localY === last ? 0 : gridSize;
    for (let localX = 0; localX < viewSize; localX++) {
      const left = reflect && localX === 0 ? 0 : -1;
      const right = reflect && localX === last ? 0 : 1;
      const x = localX + viewStart;
      const y = localY + viewStart;
      const i = y * gridSize + x;
      const pixel = (localY * viewSize + localX) * 4;
      const h = current[i];
      const dx = current[i + right] - current[i + left];
      const dy = current[i + down] - current[i + up];
      // 9-point isotropic Laplacian. The 5-point cross stencil made small
      // ripples look square because it weights axes and diagonals differently.
      const edges = current[i + left] + current[i + right] + current[i + up] + current[i + down];
      const corners = current[i + up + left] + current[i + up + right] + current[i + down + left] + current[i + down + right];
      const laplacian = (4 * edges + corners - 20 * h) / 6;
      // Isotropic shading keeps a circular wave visually concentric. A fixed
      // directional light made one quadrant brighter and shifted the apparent centre.
      const light = Math.max(-1, Math.min(1, -laplacian * 2.8));
      const slope = Math.hypot(dx, dy);
      const caustic = Math.max(0, Math.abs(h) - .04) * 20 + slope * 7;
      const noise = Math.sin(x * .41 + y * .17) * 1.2;
      data[pixel] = 7 + light * 14 + caustic * 10 + noise;
      data[pixel + 1] = 37 + light * 35 + caustic * 17 + noise;
      data[pixel + 2] = 46 + light * 42 + caustic * 18 + noise;
      data[pixel + 3] = 255;
    }
  }
  simCtx.putImageData(image, 0, 0);
  ctx.drawImage(simCanvas, 0, 0, canvas.width, canvas.height);
}

function showAmplitude(amplitude) {
  ui.amplitudeReadout.textContent = Math.min(9.999, amplitude / amplitudeScale).toFixed(3);
}

// Fixed timestep keeps wave speed independent of the display refresh rate:
// slow frames run more steps, fast frames run fewer.
let lastTime = 0;
let accumulator = 0;
function animate(time) {
  // Cap the frame delta so returning to a background tab does not trigger a
  // burst of catch-up steps.
  const delta = Math.min(time - lastTime, 100);
  // Update even while paused so resuming does not replay the paused interval.
  lastTime = time;
  if (!paused) {
    accumulator += delta;
    let amplitude = -1;
    while (accumulator >= stepMs) {
      amplitude = step();
      accumulator -= stepMs;
    }
    // Update the readout once per frame rather than once per step.
    if (amplitude >= 0) {
      showAmplitude(amplitude);
      needsRender = true;
    }
  }
  // While paused the field only changes on input, so skip redundant redraws.
  if (needsRender) {
    render();
    needsRender = false;
  }
  requestAnimationFrame(animate);
}

frame.addEventListener('pointerdown', (event) => {
  // Primary button only: right/middle clicks should not create sources.
  if (event.button !== 0) return;
  frame.setPointerCapture(event.pointerId);
  const pointer = {
    x: event.clientX,
    y: event.clientY,
    lastDisturbX: event.clientX,
    lastDisturbY: event.clientY,
    repeatTimer: null,
  };
  pointers.set(event.pointerId, pointer);
  disturb(event.clientX, event.clientY);
  if (event.shiftKey) {
    // release() clears this timer, so it never outlives the pointer.
    pointer.repeatTimer = window.setInterval(() => disturb(pointer.x, pointer.y), shiftRepeatInterval);
  }
});
frame.addEventListener('pointermove', (event) => {
  const pointer = pointers.get(event.pointerId);
  if (!pointer) return;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  if (Math.hypot(event.clientX - pointer.lastDisturbX, event.clientY - pointer.lastDisturbY) > dragSpacing) {
    disturb(event.clientX, event.clientY);
    pointer.lastDisturbX = event.clientX;
    pointer.lastDisturbY = event.clientY;
  }
});
function release(event) {
  const pointer = pointers.get(event.pointerId);
  if (pointer && pointer.repeatTimer !== null) window.clearInterval(pointer.repeatTimer);
  pointers.delete(event.pointerId);
}
function stopShiftRepeats() {
  pointers.forEach(pointer => {
    if (pointer.repeatTimer === null) return;
    window.clearInterval(pointer.repeatTimer);
    pointer.repeatTimer = null;
  });
}
frame.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('keydown', (event) => {
  if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  disturb(rect.left + rect.width / 2, rect.top + rect.height / 2);
});
frame.addEventListener('pointerup', release);
frame.addEventListener('pointercancel', release);
frame.addEventListener('lostpointercapture', release);
window.addEventListener('keyup', (event) => {
  if (event.key === 'Shift') stopShiftRepeats();
});
window.addEventListener('blur', stopShiftRepeats);

document.querySelectorAll('input[name="boundary"]').forEach(input => input.addEventListener('change', (event) => {
  boundary = event.target.value;
  clearAbsorber();
  if (boundary === 'reflect') {
    // OPEN may leave a tiny DC offset. Removing it conserves the closed
    // basin's volume and prevents that offset accumulating after the switch.
    conserveVisibleVolume(current);
    conserveVisibleVolume(previous);
    conserveVisibleVolume(next);
  }
  needsRender = true;
  ui.boundaryDescription.textContent = boundary === 'open' ? '波が外側へ抜け、静かに消えていきます。' : '波が壁で跳ね返り、干渉を繰り返します。';
}));

ui.waveSize.addEventListener('input', () => {
  const preset = wavePresets[Number(ui.waveSize.value)];
  ui.waveSizeValue.value = `${preset.strength} / ${preset.size}`;
  ui.waveSize.setAttribute('aria-valuetext', `WaveStrength ${preset.strength}、SourceSize ${preset.size}`);
});

ui.clearButton.addEventListener('click', () => {
  current.fill(0); previous.fill(0); next.fill(0);
  needsRender = true;
  showAmplitude(0);
});
ui.pauseButton.addEventListener('click', () => {
  paused = !paused;
  ui.pauseButton.querySelector('b').textContent = paused ? '再開する' : '一時停止';
  ui.pauseButton.classList.toggle('is-paused', paused);
  ui.statusText.textContent = paused ? 'SIMULATION PAUSED' : 'SIMULATION ACTIVE';
});

simCanvas.width = viewSize;
simCanvas.height = viewSize;
window.addEventListener('resize', resize);
resize();
requestAnimationFrame(animate);
