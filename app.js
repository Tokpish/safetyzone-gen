const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const shell = document.getElementById('canvasShell');
const emptyState = document.getElementById('emptyState');

const state = {
  image: null,
  imageName: 'safety-zone.png',
  imageRect: { x: 240, y: 150, w: 680, h: 520 },
  zonePoints: [],
  color: '#ff4545',
  showOriginal: true,
  dashed: false,
  dots: false,
  grid: false,
  zoom: 1,
  measures: [],
  selectedMeasure: null,
  drag: null,
};

const controls = {
  fileInput: document.getElementById('fileInput'),
  dropzone: document.getElementById('dropzone'),
  radius: document.getElementById('radius'),
  lineWidth: document.getElementById('lineWidth'),
  rounding: document.getElementById('rounding'),
  sensitivity: document.getElementById('sensitivity'),
  opacity: document.getElementById('opacity'),
  showOriginal: document.getElementById('showOriginal'),
  radiusOut: document.getElementById('radiusOut'),
  lineWidthOut: document.getElementById('lineWidthOut'),
  roundingOut: document.getElementById('roundingOut'),
  sensitivityOut: document.getElementById('sensitivityOut'),
  opacityOut: document.getElementById('opacityOut'),
  offsetTop: document.getElementById('offsetTop'),
  offsetBottom: document.getElementById('offsetBottom'),
  offsetLeft: document.getElementById('offsetLeft'),
  offsetRight: document.getElementById('offsetRight'),
  measureText: document.getElementById('measureText'),
  measureType: document.getElementById('measureType'),
  measureUnit: document.getElementById('measureUnit'),
  measureColor: document.getElementById('measureColor'),
};

function fitCanvas() {
  const rect = shell.getBoundingClientRect();
  canvas.width = Math.max(1050, Math.floor(rect.width));
  canvas.height = Math.max(760, Math.floor(rect.height));
  if (state.image) {
    fitImage();
    buildZone();
  }
  render();
}

function fitImage() {
  const radius = Number(controls.radius.value) || 0;
  const pad = Math.min(Math.max(radius + 140, 240), Math.min(canvas.width, canvas.height) * 0.38);
  const maxW = Math.max(240, canvas.width - pad * 2);
  const maxH = Math.max(240, canvas.height - pad * 2);
  const ratio = Math.min(maxW / state.image.width, maxH / state.image.height, 1.2);
  const w = state.image.width * ratio;
  const h = state.image.height * ratio;
  state.imageRect = {
    x: (canvas.width - w) / 2,
    y: (canvas.height - h) / 2,
    w,
    h,
  };
}

function loadImageFile(file) {
  if (!file || !/^image\/(png|jpeg)$/.test(file.type)) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    state.image = img;
    state.imageName = file.name.replace(/\.[^.]+$/, '') + '-safety-zone.png';
    fitImage();
    buildZone();
    seedMeasures();
    emptyState.hidden = true;
    render();
    centerView(false);
  };
  img.src = url;
}

function seedMeasures() {
  const r = state.imageRect;
  state.measures = [
    {
      id: crypto.randomUUID(),
      type: 'radius',
      a: { x: r.x + r.w * 0.88, y: r.y + r.h * 0.5 },
      b: { x: r.x + r.w + Number(controls.radius.value), y: r.y + r.h * 0.5 },
      label: 'R 150',
      unit: 'см',
      color: '#000000',
    },
  ];
  state.selectedMeasure = state.measures[0].id;
  syncMeasurePanel();
}

function buildZone() {
  if (!state.image) return;
  const radius = Number(controls.radius.value);
  const padding = radius + 36 + Math.max(
    Number(controls.offsetTop.value) || 0,
    Number(controls.offsetBottom.value) || 0,
    Number(controls.offsetLeft.value) || 0,
    Number(controls.offsetRight.value) || 0
  );
  const maxSide = Math.max(state.imageRect.w + padding * 2, state.imageRect.h + padding * 2);
  const scale = Math.min(1, 680 / maxSide);
  const w = Math.ceil((state.imageRect.w + padding * 2) * scale);
  const h = Math.ceil((state.imageRect.h + padding * 2) * scale);
  const imageX = Math.round(padding * scale);
  const imageY = Math.round(padding * scale);
  const imageW = Math.max(1, Math.round(state.imageRect.w * scale));
  const imageH = Math.max(1, Math.round(state.imageRect.h * scale));

  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const offCtx = off.getContext('2d');
  offCtx.fillStyle = '#fff';
  offCtx.fillRect(0, 0, w, h);
  offCtx.drawImage(state.image, imageX, imageY, imageW, imageH);

  const imageData = offCtx.getImageData(0, 0, w, h).data;
  const threshold = Number(controls.sensitivity.value);
  const source = new Uint8Array(w * h);
  let sourceCount = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const gray = imageData[i] * 0.299 + imageData[i + 1] * 0.587 + imageData[i + 2] * 0.114;
      const insideImage = x >= imageX && x < imageX + imageW && y >= imageY && y < imageY + imageH;
      if (insideImage && imageData[i + 3] > 20 && gray < threshold) {
        source[y * w + x] = 1;
        sourceCount++;
      }
    }
  }

  if (sourceCount < 8) {
    state.zonePoints = [];
    return;
  }

  const distance = distanceTransform(source, w, h);
  const radiusGrid = Math.max(2, radius * scale);
  const radiusSq = radiusGrid * radiusGrid;
  const zoneMask = new Uint8Array(w * h);
  const smoothLevel = Number(controls.rounding.value);

  const offsets = {
    top: Number(controls.offsetTop.value) || 0,
    bottom: Number(controls.offsetBottom.value) || 0,
    left: Number(controls.offsetLeft.value) || 0,
    right: Number(controls.offsetRight.value) || 0,
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - (imageX + imageW / 2);
      const dy = y - (imageY + imageH / 2);
      const sideOffset = ((dx < 0 ? offsets.left : offsets.right) + (dy < 0 ? offsets.top : offsets.bottom)) * scale;
      const localRadius = radiusGrid + sideOffset;
      zoneMask[y * w + x] = distance[y * w + x] <= localRadius * localRadius ? 1 : 0;
    }
  }

  const closedMask = closeMask(zoneMask, w, h, Math.max(3, Math.round(radiusGrid * 0.24 + smoothLevel * 0.12)));
  const contour = outerEnvelopeFromMask(closedMask, w, h, smoothLevel);
  const smoothContour = smoothClosedPolyline(contour, Math.max(4, Math.round(smoothLevel / 16)));
  state.zonePoints = smoothContour.map((p) => ({
    x: state.imageRect.x - padding + p.x / scale,
    y: state.imageRect.y - padding + p.y / scale,
  }));
  syncBoundMeasures();
}

function outerEnvelopeFromMask(mask, w, h, smoothLevel) {
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  const boundary = [];

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!mask[y * w + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (
        !mask[y * w + x - 1] ||
        !mask[y * w + x + 1] ||
        !mask[(y - 1) * w + x] ||
        !mask[(y + 1) * w + x]
      ) {
        boundary.push({ x, y });
      }
    }
  }

  if (boundary.length < 8) return [];

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const bucketCount = 360;
  const radii = Array.from({ length: bucketCount }, () => 0);

  boundary.forEach((p) => {
    const angle = Math.atan2(p.y - cy, p.x - cx);
    const index = Math.round(((angle + Math.PI) / (Math.PI * 2)) * (bucketCount - 1));
    const distance = Math.hypot(p.x - cx, p.y - cy);
    radii[index] = Math.max(radii[index], distance);
  });

  for (let i = 0; i < radii.length; i++) {
    if (radii[i]) continue;
    for (let step = 1; step < radii.length; step++) {
      const left = radii[(i - step + radii.length) % radii.length];
      const right = radii[(i + step) % radii.length];
      if (left && right) {
        radii[i] = (left + right) / 2;
        break;
      }
      if (left || right) {
        radii[i] = left || right;
        break;
      }
    }
  }

  const passes = Math.max(10, Math.round(12 + smoothLevel / 4));
  for (let pass = 0; pass < passes; pass++) {
    const copy = radii.slice();
    for (let i = 0; i < radii.length; i++) {
      const a = copy[(i - 2 + radii.length) % radii.length];
      const b = copy[(i - 1 + radii.length) % radii.length];
      const c = copy[i];
      const d = copy[(i + 1) % radii.length];
      const e = copy[(i + 2) % radii.length];
      radii[i] = (a + b * 2 + c * 4 + d * 2 + e) / 10;
    }
  }

  return radii.map((distance, i) => {
    const angle = -Math.PI + (i / radii.length) * Math.PI * 2;
    return {
      x: cx + Math.cos(angle) * distance,
      y: cy + Math.sin(angle) * distance,
    };
  });
}

function closeMask(mask, w, h, radius) {
  const dilated = binaryFilter(binaryFilter(mask, w, h, radius, 'max', 'x'), w, h, radius, 'max', 'y');
  return binaryFilter(binaryFilter(dilated, w, h, radius, 'min', 'x'), w, h, radius, 'min', 'y');
}

function binaryFilter(mask, w, h, radius, mode, axis) {
  const out = new Uint8Array(w * h);
  const wantMax = mode === 'max';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let value = wantMax ? 0 : 1;
      for (let step = -radius; step <= radius; step++) {
        const xx = axis === 'x' ? x + step : x;
        const yy = axis === 'y' ? y + step : y;
        const sample = xx < 0 || xx >= w || yy < 0 || yy >= h ? 0 : mask[yy * w + xx];
        if (wantMax && sample) {
          value = 1;
          break;
        }
        if (!wantMax && !sample) {
          value = 0;
          break;
        }
      }
      out[y * w + x] = value;
    }
  }
  return out;
}

function distanceTransform(source, w, h) {
  const inf = 1e12;
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = source[i] ? 0 : inf;

  const column = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) column[y] = grid[y * w + x];
    transform1d(column, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = column[y];
  }

  const row = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = grid[y * w + x];
    transform1d(row, w);
    for (let x = 0; x < w; x++) grid[y * w + x] = row[x];
  }
  return grid;
}

function transform1d(values, n) {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;

  for (let q = 1; q < n; q++) {
    let s = ((values[q] + q * q) - (values[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((values[q] + q * q) - (values[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    values[q] = d * d + values[v[k]];
  }
}

function marchingSquares(mask, w, h) {
  const segments = [];
  const pt = (x, y) => ({ x, y });
  const add = (a, b) => segments.push([a, b]);

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = mask[y * w + x] ? 8 : 0;
      const tr = mask[y * w + x + 1] ? 4 : 0;
      const br = mask[(y + 1) * w + x + 1] ? 2 : 0;
      const bl = mask[(y + 1) * w + x] ? 1 : 0;
      const code = tl | tr | br | bl;
      if (code === 0 || code === 15) continue;

      const top = pt(x + 0.5, y);
      const right = pt(x + 1, y + 0.5);
      const bottom = pt(x + 0.5, y + 1);
      const left = pt(x, y + 0.5);

      if (code === 1) add(left, bottom);
      else if (code === 2) add(bottom, right);
      else if (code === 3) add(left, right);
      else if (code === 4) add(top, right);
      else if (code === 5) { add(top, left); add(bottom, right); }
      else if (code === 6) add(top, bottom);
      else if (code === 7) add(top, left);
      else if (code === 8) add(top, left);
      else if (code === 9) add(top, bottom);
      else if (code === 10) { add(top, right); add(left, bottom); }
      else if (code === 11) add(top, right);
      else if (code === 12) add(left, right);
      else if (code === 13) add(bottom, right);
      else if (code === 14) add(left, bottom);
    }
  }
  return joinSegments(segments);
}

function joinSegments(segments) {
  const key = (p) => `${p.x},${p.y}`;
  const links = new Map();
  segments.forEach(([a, b], index) => {
    for (const p of [a, b]) {
      const k = key(p);
      if (!links.has(k)) links.set(k, []);
      links.get(k).push(index);
    }
  });

  const used = new Uint8Array(segments.length);
  const contours = [];

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const contour = [segments[i][0], segments[i][1]];
    let current = segments[i][1];

    for (let guard = 0; guard < segments.length; guard++) {
      const nextIndex = (links.get(key(current)) || []).find((index) => !used[index]);
      if (nextIndex === undefined) break;
      used[nextIndex] = 1;
      const [a, b] = segments[nextIndex];
      current = key(a) === key(current) ? b : a;
      contour.push(current);
      if (key(current) === key(contour[0])) break;
    }
    if (contour.length > 8) contours.push(contour);
  }
  return contours;
}

function longestContour(contours) {
  return contours.reduce((best, contour) => (contour.length > best.length ? contour : best), []);
}

function smoothClosedPolyline(points, passes) {
  if (points.length < 3) return points;
  let result = points.slice();
  for (let pass = 0; pass < passes; pass++) {
    const next = [];
    for (let i = 0; i < result.length; i++) {
      const a = result[i];
      const b = result[(i + 1) % result.length];
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    result = next;
  }
  return result;
}

function simplifyClosedPolyline(points, tolerance) {
  if (points.length < 8) return points;
  const open = points.slice(0, -1);
  const simplified = rdp(open, tolerance);
  return simplified.length >= 3 ? simplified : points;
}

function rdp(points, tolerance) {
  if (points.length <= 3) return points;
  let maxDistance = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const distance = distanceToSegment(points[i], first, last);
    if (distance > maxDistance) {
      index = i;
      maxDistance = distance;
    }
  }

  if (maxDistance > tolerance) {
    const left = rdp(points.slice(0, index + 1), tolerance);
    const right = rdp(points.slice(index), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (state.grid) drawGrid();
  if (!state.image) return;
  syncBoundMeasures();

  if (state.showOriginal) {
    ctx.globalAlpha = 1;
    ctx.drawImage(state.image, state.imageRect.x, state.imageRect.y, state.imageRect.w, state.imageRect.h);
  }
  drawZone();
  state.measures.forEach(drawMeasure);
}

function drawGrid() {
  ctx.save();
  ctx.strokeStyle = '#edf2f7';
  ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawZone() {
  if (state.zonePoints.length < 3) return;
  ctx.save();
  ctx.globalAlpha = Number(controls.opacity.value) / 100;
  ctx.strokeStyle = state.color;
  ctx.lineWidth = Number(controls.lineWidth.value);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash(state.dashed ? [10, 8] : []);
  drawClosedCurve(state.zonePoints);
  ctx.stroke();
  if (state.dots) {
    ctx.fillStyle = state.color;
    state.zonePoints.forEach((p, i) => {
      if (i % 8 !== 0) return;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  ctx.restore();
}

function drawClosedCurve(points) {
  if (points.length < 3) return;
  ctx.beginPath();
  const first = points[0];
  ctx.moveTo(first.x, first.y);
  for (let i = 0; i < points.length; i++) {
    const p0 = points[(i - 1 + points.length) % points.length];
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const p3 = points[(i + 2) % points.length];
    const cp1 = {
      x: p1.x + (p2.x - p0.x) / 6,
      y: p1.y + (p2.y - p0.y) / 6,
    };
    const cp2 = {
      x: p2.x - (p3.x - p1.x) / 6,
      y: p2.y - (p3.y - p1.y) / 6,
    };
    ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p2.x, p2.y);
  }
  ctx.closePath();
}

function drawMeasure(measure) {
  const selected = measure.id === state.selectedMeasure;
  const label = `${measure.label} ${measure.unit}`;
  ctx.save();
  ctx.strokeStyle = measure.color;
  ctx.fillStyle = measure.color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  if (measure.type === 'linear') drawLinearDimension(measure, label);
  else drawRadiusDimension(measure, label);
  ctx.restore();
}

function drawLinearDimension(measure, label) {
  const a = measure.a;
  const b = measure.b;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const nx = -uy;
  const ny = ux;
  const extension = 34;
  const overrun = 10;
  const textOffset = -16;
  const p1 = { x: a.x + nx * extension, y: a.y + ny * extension };
  const p2 = { x: b.x + nx * extension, y: b.y + ny * extension };
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(a.x + nx * (extension + overrun), a.y + ny * (extension + overrun));
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x + nx * (extension + overrun), b.y + ny * (extension + overrun));
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();

  drawArrowHead(p1, Math.atan2(p2.y - p1.y, p2.x - p1.x), false);
  drawArrowHead(p2, Math.atan2(p2.y - p1.y, p2.x - p1.x), true);
  drawDimensionText(label, mid.x + nx * textOffset, mid.y + ny * textOffset, Math.atan2(dy, dx));
}

function drawRadiusDimension(measure, label) {
  const a = measure.a;
  const b = measure.b;
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  drawArrowHead(b, angle, true);
  drawDimensionText(label, mid.x, mid.y - 18, angle);
}

function drawArrowHead(point, angle, forward) {
  const size = 14;
  const dir = forward ? angle : angle + Math.PI;
  ctx.beginPath();
  ctx.moveTo(point.x, point.y);
  ctx.lineTo(point.x - Math.cos(dir - 0.45) * size, point.y - Math.sin(dir - 0.45) * size);
  ctx.moveTo(point.x, point.y);
  ctx.lineTo(point.x - Math.cos(dir + 0.45) * size, point.y - Math.sin(dir + 0.45) * size);
  ctx.stroke();
}

function drawDimensionText(label, x, y, angle) {
  let textAngle = angle;
  if (textAngle > Math.PI / 2 || textAngle < -Math.PI / 2) textAngle += Math.PI;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(textAngle);
  ctx.fillStyle = '#000';
  ctx.font = 'italic 24px Segoe UI, Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

function drawMeasureHandles(measure, selected) {
  [measure.a, measure.b].forEach((p) => {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = measure.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
}

function zoneBounds() {
  const points = state.zonePoints.length ? state.zonePoints : [
    { x: state.imageRect.x, y: state.imageRect.y },
    { x: state.imageRect.x + state.imageRect.w, y: state.imageRect.y + state.imageRect.h },
  ];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function syncBoundMeasures() {
  if (!state.zonePoints.length) return;
  const bounds = zoneBounds();
  state.measures.forEach((measure) => {
    if (measure.boundAxis === 'horizontal') {
      measure.a = { x: bounds.minX, y: bounds.maxY };
      measure.b = { x: bounds.maxX, y: bounds.maxY };
    }
    if (measure.boundAxis === 'vertical') {
      measure.a = { x: bounds.minX, y: bounds.minY };
      measure.b = { x: bounds.minX, y: bounds.maxY };
    }
  });
}

function pointerPos(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / state.zoom,
    y: (event.clientY - rect.top) / state.zoom,
  };
}

function hitMeasure(point) {
  for (const measure of state.measures) {
    for (const key of ['a', 'b']) {
      if (Math.hypot(point.x - measure[key].x, point.y - measure[key].y) < 14) {
        return { measure, part: key };
      }
    }
    const d = distanceToMeasure(point, measure);
    if (d < 10) return { measure, part: 'line' };
  }
  return null;
}

function distanceToMeasure(point, measure) {
  if (measure.type !== 'linear') return distanceToSegment(point, measure.a, measure.b);
  const line = linearDimensionLine(measure);
  return Math.min(
    distanceToSegment(point, measure.a, measure.b),
    distanceToSegment(point, line.p1, line.p2)
  );
}

function linearDimensionLine(measure) {
  const a = measure.a;
  const b = measure.b;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -(dy / length);
  const ny = dx / length;
  const extension = 34;
  return {
    p1: { x: a.x + nx * extension, y: a.y + ny * extension },
    p2: { x: b.x + nx * extension, y: b.y + ny * extension },
  };
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function selectedMeasure() {
  return state.measures.find((m) => m.id === state.selectedMeasure);
}

function syncMeasurePanel() {
  const measure = selectedMeasure();
  if (!measure) return;
  controls.measureType.value = measure.type || 'radius';
  controls.measureText.value = measure.label;
  controls.measureUnit.value = measure.unit;
  controls.measureColor.value = measure.color;
}

function updateOutputs() {
  controls.radiusOut.value = `${controls.radius.value}px`;
  controls.lineWidthOut.value = `${controls.lineWidth.value}px`;
  controls.roundingOut.value = `${controls.rounding.value}%`;
  controls.sensitivityOut.value = controls.sensitivity.value;
  controls.opacityOut.value = `${controls.opacity.value}%`;
}

function addHorizontalMeasure() {
  const bounds = zoneBounds();
  const measure = {
    id: crypto.randomUUID(),
    type: 'linear',
    boundAxis: 'horizontal',
    a: { x: bounds.minX, y: bounds.maxY },
    b: { x: bounds.maxX, y: bounds.maxY },
    label: '5,00',
    unit: 'м',
    color: '#000000',
  };
  state.measures.push(measure);
  state.selectedMeasure = measure.id;
  syncMeasurePanel();
  render();
}

function addVerticalMeasure() {
  const bounds = zoneBounds();
  const measure = {
    id: crypto.randomUUID(),
    type: 'linear',
    boundAxis: 'vertical',
    a: { x: bounds.minX, y: bounds.minY },
    b: { x: bounds.minX, y: bounds.maxY },
    label: '2,53',
    unit: 'м',
    color: '#000000',
  };
  state.measures.push(measure);
  state.selectedMeasure = measure.id;
  syncMeasurePanel();
  render();
}

function addRadiusMeasure() {
  const r = state.imageRect;
  const measure = {
    id: crypto.randomUUID(),
    type: 'radius',
    a: { x: r.x + r.w * 0.78, y: r.y + r.h * 0.35 },
    b: { x: r.x + r.w + 120, y: r.y + 60 },
    label: 'R1,50',
    unit: 'м',
    color: '#000000',
  };
  state.measures.push(measure);
  state.selectedMeasure = measure.id;
  syncMeasurePanel();
  render();
}

function exportPng() {
  const link = document.createElement('a');
  link.download = state.imageName;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

controls.fileInput.addEventListener('change', (event) => loadImageFile(event.target.files[0]));

['dragenter', 'dragover'].forEach((type) => {
  controls.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    controls.dropzone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach((type) => {
  controls.dropzone.addEventListener(type, () => controls.dropzone.classList.remove('dragover'));
});

controls.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  loadImageFile(event.dataTransfer.files[0]);
});

document.addEventListener('paste', (event) => {
  const item = [...event.clipboardData.items].find((entry) => entry.type.startsWith('image/'));
  if (item) loadImageFile(item.getAsFile());
});

[
  controls.radius,
  controls.lineWidth,
  controls.rounding,
  controls.sensitivity,
  controls.opacity,
  controls.offsetTop,
  controls.offsetBottom,
  controls.offsetLeft,
  controls.offsetRight,
].forEach((control) => {
  control.addEventListener('input', () => {
    updateOutputs();
    if (control === controls.radius && state.image) fitImage();
    buildZone();
    render();
  });
});

controls.showOriginal.addEventListener('change', () => {
  state.showOriginal = controls.showOriginal.checked;
  render();
});

document.getElementById('swatches').addEventListener('click', (event) => {
  const button = event.target.closest('.swatch');
  if (!button) return;
  document.querySelectorAll('.swatch').forEach((node) => node.classList.remove('active'));
  button.classList.add('active');
  state.color = button.dataset.color;
  render();
});

document.getElementById('addHorizontalMeasure').addEventListener('click', addHorizontalMeasure);
document.getElementById('addVerticalMeasure').addEventListener('click', addVerticalMeasure);
document.getElementById('addRadiusMeasure').addEventListener('click', addRadiusMeasure);
document.getElementById('deleteMeasure').addEventListener('click', () => {
  state.measures = state.measures.filter((measure) => measure.id !== state.selectedMeasure);
  state.selectedMeasure = state.measures[0]?.id ?? null;
  syncMeasurePanel();
  render();
});

controls.measureText.addEventListener('input', () => {
  const measure = selectedMeasure();
  if (measure) measure.label = controls.measureText.value;
  render();
});

controls.measureType.addEventListener('change', () => {
  const measure = selectedMeasure();
  if (measure) measure.type = controls.measureType.value;
  render();
});

controls.measureUnit.addEventListener('change', () => {
  const measure = selectedMeasure();
  if (measure) measure.unit = controls.measureUnit.value;
  render();
});

controls.measureColor.addEventListener('input', () => {
  const measure = selectedMeasure();
  if (measure) measure.color = controls.measureColor.value;
  render();
});

canvas.addEventListener('pointerdown', (event) => {
  const point = pointerPos(event);
  const hit = hitMeasure(point);
  if (!hit) return;
  state.selectedMeasure = hit.measure.id;
  syncMeasurePanel();
  state.drag = { part: hit.part, start: point, measure: hit.measure, a: { ...hit.measure.a }, b: { ...hit.measure.b } };
  canvas.setPointerCapture(event.pointerId);
  render();
});

canvas.addEventListener('pointermove', (event) => {
  if (!state.drag) return;
  const point = pointerPos(event);
  const dx = point.x - state.drag.start.x;
  const dy = point.y - state.drag.start.y;
  if (state.drag.part === 'line') {
    state.drag.measure.a = { x: state.drag.a.x + dx, y: state.drag.a.y + dy };
    state.drag.measure.b = { x: state.drag.b.x + dx, y: state.drag.b.y + dy };
  } else {
    state.drag.measure[state.drag.part] = { x: state.drag[state.drag.part].x + dx, y: state.drag[state.drag.part].y + dy };
  }
  render();
});

canvas.addEventListener('pointerup', () => {
  state.drag = null;
});

document.getElementById('toggleGrid').addEventListener('click', () => {
  state.grid = !state.grid;
  render();
});

document.getElementById('toggleDashes').addEventListener('click', () => {
  state.dashed = !state.dashed;
  render();
});

document.getElementById('toggleDots').addEventListener('click', () => {
  state.dots = !state.dots;
  render();
});

document.getElementById('zoomIn').addEventListener('click', () => setZoom(state.zoom + 0.1));
document.getElementById('zoomOut').addEventListener('click', () => setZoom(state.zoom - 0.1));
document.getElementById('centerView').addEventListener('click', () => {
  centerView();
});
document.getElementById('exportBtn').addEventListener('click', exportPng);

function setZoom(value) {
  state.zoom = Math.max(0.35, Math.min(2.5, value));
  canvas.style.transform = `scale(${state.zoom})`;
  document.getElementById('zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
  centerView(false);
}

function centerView(smooth = true) {
  const bounds = contentBounds();
  const viewW = shell.clientWidth;
  const viewH = shell.clientHeight;
  const targetLeft = Math.max(0, (bounds.x + bounds.w / 2) * state.zoom - viewW / 2);
  const targetTop = Math.max(0, (bounds.y + bounds.h / 2) * state.zoom - viewH / 2);
  shell.scrollTo({ left: targetLeft, top: targetTop, behavior: smooth ? 'smooth' : 'auto' });
}

function contentBounds() {
  if (!state.image) return { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const points = state.zonePoints.length ? state.zonePoints : [
    { x: state.imageRect.x, y: state.imageRect.y },
    { x: state.imageRect.x + state.imageRect.w, y: state.imageRect.y + state.imageRect.h },
  ];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.max(0, Math.min(...xs) - 80);
  const minY = Math.max(0, Math.min(...ys) - 80);
  const maxX = Math.min(canvas.width, Math.max(...xs) + 80);
  const maxY = Math.min(canvas.height, Math.max(...ys) + 80);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

window.addEventListener('resize', fitCanvas);
updateOutputs();
fitCanvas();
