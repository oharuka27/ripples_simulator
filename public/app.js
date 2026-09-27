const canvas = document.querySelector('#waterCanvas');
const frame = document.querySelector('#canvasFrame');
const ctx = canvas.getContext('2d', { alpha: false });
const simCanvas = document.createElement('canvas');
const simCtx = simCanvas.getContext('2d', { alpha: false });

const viewSize = 180;
const absorberWidth = 48;
const width = viewSize + absorberWidth * 2;
const height = width;
const viewStart = absorberWidth;
const viewEnd = viewStart + viewSize - 1;
let current = new Float32Array(width * height);
let previous = new Float32Array(width * height);
let next = new Float32Array(width * height);
let image = simCtx.createImageData(viewSize, viewSize);
let boundary = 'open';
let paused = false;
let interacted = false;
let needsRender = true;
const pointers = new Map();
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

function conserveVisibleVolume(field) {
  let sum = 0;
  const count = viewSize * viewSize;
  for (let y = viewStart; y <= viewEnd; y++) {
    for (let x = viewStart; x <= viewEnd; x++) sum += field[y * width + x];
  }
  const mean = sum / count;
  if (Math.abs(mean) < 1e-12) return;
  for (let y = viewStart; y <= viewEnd; y++) {
    for (let x = viewStart; x <= viewEnd; x++) field[y * width + x] -= mean;
  }
}

function resize() {
  const rect = frame.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  simCanvas.width = viewSize;
  simCanvas.height = viewSize;
  ctx.imageSmoothingEnabled = true;
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
  const preset = wavePresets[Number(document.querySelector('#waveSize').value)];
  const radius = preset.size * viewSize / 600;
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
      current[py * width + px] += impulse;
      previous[py * width + px] -= impulse * .18;
    }
  }
  // Enforce the discrete volume invariant exactly. Truncating the source near
  // an edge otherwise leaves a small DC component after every interaction.
  conserveVisibleVolume(current);
  conserveVisibleVolume(previous);
  needsRender = true;
  document.querySelector('#xReadout').textContent = normalizedX.toFixed(3);
  document.querySelector('#yReadout').textContent = normalizedY.toFixed(3);
  if (!interacted) {
    interacted = true;
    document.querySelector('#tapHint').style.opacity = '0';
  }
}

function step() {
  const waveCoefficient = .22;
  const courant = Math.sqrt(waveCoefficient);
  const radiationCoefficient = (courant - 1) / (courant + 1);
  let amplitude = 0;

  if (boundary === 'reflect') {
    // Zero normal flux at the wall. A missing neighbour equals the boundary
    // cell itself, keeping the discrete Laplacian symmetric and non-amplifying.
    const wallLoss = .0015;
    for (let y = viewStart; y <= viewEnd; y++) {
      for (let x = viewStart; x <= viewEnd; x++) {
        const i = y * width + x;
        const left = x === viewStart ? i : i - 1;
        const right = x === viewEnd ? i : i + 1;
        const up = y === viewStart ? i : i - width;
        const down = y === viewEnd ? i : i + width;
        const laplacian = current[left] + current[right] + current[up] + current[down] - 4 * current[i];
        const value = (2 * current[i] - (1 - wallLoss) * previous[i] + waveCoefficient * laplacian) / (1 + wallLoss);
        next[i] = Number.isFinite(value) && Math.abs(value) < 20 ? value : 0;
        amplitude += Math.abs(next[i]);
      }
    }
    // Remove floating-point drift in the zero-frequency mode on every step.
    // This guarantees sum(height) stays constant through any number of bounces.
    conserveVisibleVolume(next);
  } else {
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const laplacian = current[i - 1] + current[i + 1] + current[i - width] + current[i + width] - 4 * current[i];
        // The absorber lies completely outside the visible water surface.
        // A cubic ramp avoids an impedance jump where the sponge begins.
        const outside = Math.max(viewStart - x, x - viewEnd, viewStart - y, y - viewEnd, 0);
        const depth = outside / absorberWidth;
        const sigma = .42 * depth * depth * depth;
        // Discretisation of u_tt + 2*sigma*u_t = c^2*Laplacian(u).
        // Damping velocity rather than displacement reduces sponge reflections.
        const value = (2 * current[i] - (1 - sigma) * previous[i] + waveCoefficient * laplacian) / (1 + sigma);
        next[i] = Number.isFinite(value) && Math.abs(value) < 20 ? value : 0;
        if (x >= viewStart && x <= viewEnd && y >= viewStart && y <= viewEnd) amplitude += Math.abs(next[i]);
      }
    }
    // Sommerfeld radiation condition in its first-order discrete (Mur) form.
    // The remaining outer-edge error has already crossed the 48-cell sponge.
    for (let x = 1; x < width - 1; x++) {
      next[x] = current[width + x] + radiationCoefficient * (next[width + x] - current[x]);
      const bottom = (height - 1) * width + x;
      next[bottom] = current[bottom - width] + radiationCoefficient * (next[bottom - width] - current[bottom]);
    }
    for (let y = 1; y < height - 1; y++) {
      const left = y * width;
      const right = left + width - 1;
      next[left] = current[left + 1] + radiationCoefficient * (next[left + 1] - current[left]);
      next[right] = current[right - 1] + radiationCoefficient * (next[right - 1] - current[right]);
    }
    next[0] = (next[1] + next[width]) * .5;
    next[width - 1] = (next[width - 2] + next[2 * width - 1]) * .5;
    const bottomLeft = (height - 1) * width;
    const bottomRight = height * width - 1;
    next[bottomLeft] = (next[bottomLeft + 1] + next[bottomLeft - width]) * .5;
    next[bottomRight] = (next[bottomRight - 1] + next[bottomRight - width]) * .5;
  }
  [previous, current, next] = [current, next, previous];
  document.querySelector('#amplitudeReadout').textContent = Math.min(9.999, amplitude / 500).toFixed(3);
}

function render() {
  const data = image.data;
  for (let localY = 0; localY < viewSize; localY++) {
    for (let localX = 0; localX < viewSize; localX++) {
      const x = localX + viewStart;
      const y = localY + viewStart;
      const i = y * width + x;
      const pixel = (localY * viewSize + localX) * 4;
      const h = current[i];
      const dx = current[i + 1] - current[i - 1];
      const dy = current[i + width] - current[i - width];
      // 9-point isotropic Laplacian. The 5-point cross stencil made small
      // ripples look square because it weights axes and diagonals differently.
      const edges = current[i - 1] + current[i + 1] + current[i - width] + current[i + width];
      const corners = current[i - width - 1] + current[i - width + 1] + current[i + width - 1] + current[i + width + 1];
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

let lastTime = 0;
function animate(time) {
  if (!paused) {
    const iterations = time - lastTime > 24 ? 1 : 2;
    for (let i = 0; i < iterations; i++) step();
    lastTime = time;
    needsRender = true;
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
    pointer.repeatTimer = window.setInterval(() => {
      if (!pointers.has(event.pointerId)) return;
      disturb(pointer.x, pointer.y);
    }, shiftRepeatInterval);
  }
});
frame.addEventListener('pointermove', (event) => {
  if (!pointers.has(event.pointerId)) return;
  const pointer = pointers.get(event.pointerId);
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  if (Math.hypot(event.clientX - pointer.lastDisturbX, event.clientY - pointer.lastDisturbY) > 12) {
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
  // Do not let waves retained in the hidden absorber return after toggling.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= viewStart && x <= viewEnd && y >= viewStart && y <= viewEnd) continue;
      const i = y * width + x;
      current[i] = 0; previous[i] = 0; next[i] = 0;
    }
  }
  if (boundary === 'reflect') {
    // OPEN may leave a tiny DC offset. Removing it conserves the closed
    // basin's volume and prevents that offset accumulating after the switch.
    conserveVisibleVolume(current);
    conserveVisibleVolume(previous);
    conserveVisibleVolume(next);
  }
  needsRender = true;
  document.querySelector('#boundaryDescription').textContent = boundary === 'open' ? '波が外側へ抜け、静かに消えていきます。' : '波が壁で跳ね返り、干渉を繰り返します。';
}));

const waveSizeInput = document.querySelector('#waveSize');
const waveSizeOutput = document.querySelector('#waveSizeValue');
waveSizeInput.addEventListener('input', () => {
  const preset = wavePresets[Number(waveSizeInput.value)];
  waveSizeOutput.value = `${preset.strength} / ${preset.size}`;
  waveSizeInput.setAttribute('aria-valuetext', `WaveStrength ${preset.strength}、SourceSize ${preset.size}`);
});

document.querySelector('#clearButton').addEventListener('click', () => {
  current.fill(0); previous.fill(0); next.fill(0);
  needsRender = true;
  document.querySelector('#amplitudeReadout').textContent = '0.000';
});
document.querySelector('#pauseButton').addEventListener('click', (event) => {
  paused = !paused;
  event.currentTarget.querySelector('b').textContent = paused ? '再開する' : '一時停止';
  event.currentTarget.classList.toggle('is-paused', paused);
  document.querySelector('#statusText').textContent = paused ? 'SIMULATION PAUSED' : 'SIMULATION ACTIVE';
});

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(animate);
