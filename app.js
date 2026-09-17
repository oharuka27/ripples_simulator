const canvas = document.querySelector('#waterCanvas');
const frame = document.querySelector('#canvasFrame');
const ctx = canvas.getContext('2d', { alpha: false });
const simCanvas = document.createElement('canvas');
const simCtx = simCanvas.getContext('2d', { alpha: false });

let width = 180;
let height = 180;
let current = new Float32Array(width * height);
let previous = new Float32Array(width * height);
let next = new Float32Array(width * height);
let image = simCtx.createImageData(width, height);
let boundary = 'open';
let paused = false;
let interacted = false;
const pointers = new Map();

function resize() {
  const rect = frame.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  simCanvas.width = width;
  simCanvas.height = height;
  ctx.imageSmoothingEnabled = true;
}

function disturb(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.round((clientX - rect.left) / rect.width * (width - 1));
  const y = Math.round((clientY - rect.top) / rect.height * (height - 1));
  const radius = Number(document.querySelector('#size').value) * width / 600;
  const strength = Number(document.querySelector('#strength').value) / 100;
  const reach = Math.ceil(radius * 2.5);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 1 || px >= width - 1 || py < 1 || py >= height - 1) continue;
      const d2 = dx * dx + dy * dy;
      const impulse = Math.exp(-d2 / (2 * radius * radius)) * strength;
      current[py * width + px] += impulse;
      previous[py * width + px] -= impulse * .18;
    }
  }
  document.querySelector('#xReadout').textContent = (x / width).toFixed(3);
  document.querySelector('#yReadout').textContent = (y / height).toFixed(3);
  if (!interacted) {
    interacted = true;
    document.querySelector('#tapHint').style.opacity = '0';
  }
}

function step() {
  const damping = boundary === 'open' ? 0.994 : 0.998;
  let energy = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const laplacian = current[i - 1] + current[i + 1] + current[i - width] + current[i + width] - 4 * current[i];
      let localDamping = damping;
      if (boundary === 'open') {
        const edge = Math.min(x, y, width - 1 - x, height - 1 - y);
        if (edge < 18) localDamping *= 0.82 + edge * .01;
      }
      next[i] = (2 * current[i] - previous[i] + .22 * laplacian) * localDamping;
      energy += Math.abs(next[i]);
    }
  }
  if (boundary === 'reflect') {
    for (let x = 1; x < width - 1; x++) { next[x] = next[width + x]; next[(height - 1) * width + x] = next[(height - 2) * width + x]; }
    for (let y = 1; y < height - 1; y++) { next[y * width] = next[y * width + 1]; next[y * width + width - 1] = next[y * width + width - 2]; }
  } else {
    for (let x = 0; x < width; x++) { next[x] = 0; next[(height - 1) * width + x] = 0; }
    for (let y = 0; y < height; y++) { next[y * width] = 0; next[y * width + width - 1] = 0; }
  }
  [previous, current, next] = [current, next, previous];
  document.querySelector('#energyReadout').textContent = Math.min(9.999, energy / 500).toFixed(3);
}

function render() {
  const data = image.data;
  for (let i = 0; i < current.length; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    const h = current[i];
    const dx = current[i + (x < width - 1 ? 1 : 0)] - current[i - (x > 0 ? 1 : 0)];
    const dy = current[i + (y < height - 1 ? width : 0)] - current[i - (y > 0 ? width : 0)];
    const light = Math.max(-1, Math.min(1, (-dx * .7 - dy * .5) * 3.2));
    const caustic = Math.max(0, Math.abs(h) - .04) * 25;
    const noise = Math.sin(x * .41 + y * .17) * 1.2;
    data[i * 4] = 7 + light * 14 + caustic * 10 + noise;
    data[i * 4 + 1] = 37 + light * 35 + caustic * 17 + noise;
    data[i * 4 + 2] = 46 + light * 42 + caustic * 18 + noise;
    data[i * 4 + 3] = 255;
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
  }
  render();
  requestAnimationFrame(animate);
}

frame.addEventListener('pointerdown', (event) => {
  frame.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  disturb(event.clientX, event.clientY);
});
frame.addEventListener('pointermove', (event) => {
  if (!pointers.has(event.pointerId)) return;
  const last = pointers.get(event.pointerId);
  if (Math.hypot(event.clientX - last.x, event.clientY - last.y) > 12) {
    disturb(event.clientX, event.clientY);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }
});
function release(event) { pointers.delete(event.pointerId); }
frame.addEventListener('pointerup', release);
frame.addEventListener('pointercancel', release);

document.querySelectorAll('input[name="boundary"]').forEach(input => input.addEventListener('change', (event) => {
  boundary = event.target.value;
  document.querySelector('#boundaryDescription').textContent = boundary === 'open' ? '波が外側へ抜け、静かに消えていきます。' : '波が壁で跳ね返り、干渉を繰り返します。';
}));

for (const id of ['strength', 'size']) {
  const input = document.querySelector(`#${id}`);
  const output = document.querySelector(`#${id}Value`);
  input.addEventListener('input', () => output.value = input.value);
}

document.querySelector('#clearButton').addEventListener('click', () => {
  current.fill(0); previous.fill(0); next.fill(0);
  document.querySelector('#energyReadout').textContent = '0.000';
});
document.querySelector('#pauseButton').addEventListener('click', (event) => {
  paused = !paused;
  event.currentTarget.querySelector('b').textContent = paused ? '再開する' : '一時停止';
  event.currentTarget.querySelector('.pause-icon').style.display = paused ? 'none' : '';
  document.querySelector('#statusText').textContent = paused ? 'SIMULATION PAUSED' : 'SIMULATION ACTIVE';
});

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(animate);
