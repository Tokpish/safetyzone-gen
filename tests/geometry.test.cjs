const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

function loadApp() {
  const elements = new Map();
  const drawing = new Proxy({}, { get: (target, key) => target[key] || (() => {}) });
  const defaults = { radius: '120', rounding: '100', opacity: '100', lineWidth: '2', sensitivity: '120' };
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        value: defaults[id] || '0', style: {}, events: {},
        addEventListener(event, handler) { this.events[event] = handler; },
        getContext: () => drawing,
        getBoundingClientRect: () => ({ width: 1200, height: 1000, left: 0, top: 0 }),
        setPointerCapture() {}, scrollTo() {},
      });
      return elements.get(id);
    },
    addEventListener() {},
  };
  const context = vm.createContext({ document, window: { addEventListener() {} }, crypto: { randomUUID } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8') + `
    globalThis.app = { state, controls, transform1d, distanceTransform, marchingSquares, signedArea,
      smoothClosedPolyline, addHorizontalMeasure, addVerticalMeasure, linearDimensionLine,
      hitMeasure, syncBoundMeasures, dragMeasure, render, buildZone, applyZoneOffsets };
  `, context);
  return { ...context.app, elements, document };
}

test('1D transform agrees with exhaustive distances, including a later finite cost', () => {
  const app = loadApp();
  let seed = 812;
  for (let run = 0; run < 100; run++) {
    const costs = Array.from({ length: 40 }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % 4 ? 1e12 : seed % 37;
    });
    costs[25] = 3;
    const actual = Float64Array.from(costs);
    app.transform1d(actual, actual.length);
    actual.forEach((value, x) => {
      assert.equal(value, Math.min(...costs.map((cost, i) => cost + (x - i) ** 2)));
    });
  }
});

function fixture() {
  const w = 241, h = 281;
  const source = new Uint8Array(w * h);
  const pixels = [];
  for (let y = 60; y <= 220; y++) {
    for (let x = 70; x <= 170; x++) {
      if ((y === 60 || y === 100) && (x <= 105 || x >= 135) ||
          y >= 100 && (x === 105 || x === 135)) {
        source[y * w + x] = 1;
        pixels.push({ x, y });
      }
    }
  }
  return { w, h, source, pixels };
}

test('2D transform matches nearest source pixels and preserves both reflections', () => {
  const app = loadApp();
  const { w, h, source, pixels } = fixture();
  const distances = app.distanceTransform(source, w, h);
  for (let y = 0; y < h; y += 7) for (let x = 0; x < w; x += 3) {
    assert.equal(distances[y * w + x], Math.min(...pixels.map(p => (x - p.x) ** 2 + (y - p.y) ** 2)));
    assert.equal(distances[y * w + x], distances[y * w + w - 1 - x]);
  }
  const flipped = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) flipped.set(source.subarray(y * w, (y + 1) * w), (h - 1 - y) * w);
  const flippedDistances = app.distanceTransform(flipped, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    assert.equal(distances[y * w + x], flippedDistances[(h - 1 - y) * w + x]);
  }
});

test('smooth outlines are mirrored and remain within one pixel of the requested radius', () => {
  const app = loadApp();
  const { w, h, source, pixels } = fixture();
  const distances = app.distanceTransform(source, w, h);
  for (const radius of [10, 23.5, 47]) {
    const field = Float64Array.from(distances, d => Math.sqrt(d) - radius);
    const contours = app.marchingSquares(field, w, h).filter(c => app.signedArea(c) > 0);
    assert.ok(contours.length);
    for (const passes of [0, 1, 2]) {
      const points = contours.flatMap(c => app.smoothClosedPolyline(c, passes));
      const pointSet = new Set(points.map(p => `${p.x.toFixed(4)},${p.y.toFixed(4)}`));
      for (const p of points) {
        assert.ok(pointSet.has(`${(w - 1 - p.x).toFixed(4)},${p.y.toFixed(4)}`), `unmatched reflected point ${JSON.stringify(p)}`);
        const actualRadius = Math.min(...pixels.map(pixel => Math.hypot(p.x - pixel.x, p.y - pixel.y)));
        assert.ok(Math.abs(actualRadius - radius) < 1, `distance ${actualRadius}, radius ${radius}`);
      }
    }
  }
});

test('contour traversal closes disconnected outlines and identifies internal holes', () => {
  const app = loadApp();
  const w = 161, h = 161;
  const source = new Uint8Array(w * h);
  for (let y = 50; y <= 110; y++) for (let x = 50; x <= 110; x++) {
    if (x === 50 || x === 110 || y === 50 || y === 110) source[y * w + x] = 1;
  }
  source[20 * w + 20] = 1;
  const field = Float64Array.from(app.distanceTransform(source, w, h), d => Math.sqrt(d) - 7.5);
  const contours = app.marchingSquares(field, w, h);
  assert.equal(contours.filter(c => app.signedArea(c) > 0).length, 2);
  assert.equal(contours.filter(c => app.signedArea(c) < 0).length, 1);
});

function measureFixture(axis) {
  const app = loadApp();
  app.state.image = {};
  app.state.zonePoints = [{ x: 100, y: 80 }, { x: 700, y: 780 }];
  if (axis === 'horizontal') app.addHorizontalMeasure();
  else app.addVerticalMeasure();
  return { app, measure: app.state.measures[0] };
}

for (const axis of ['horizontal', 'vertical']) {
  for (const part of ['a', 'b']) test(`${axis} ${part} arrow resizes along its axis and survives redraw`, () => {
    const { app, measure } = measureFixture(axis);
    const line = app.linearDimensionLine(measure);
    const start = part === 'a' ? line.p1 : line.p2;
    const hit = app.hitMeasure(start);
    assert.equal(hit.part, part);
    assert.equal(hit.measure, measure);
    const drag = { measure, part, start, a: { ...measure.a }, b: { ...measure.b } };
    app.dragMeasure(drag, { x: start.x + 65, y: start.y + 93 });
    app.render();
    app.syncBoundMeasures();
    const coordinate = axis === 'horizontal' ? 'x' : 'y';
    const fixed = axis === 'horizontal' ? 'y' : 'x';
    assert.equal(measure[part][coordinate], drag[part][coordinate] + (coordinate === 'x' ? 65 : 93));
    assert.equal(measure.a[fixed], measure.b[fixed]);
    assert.equal(measure[part][fixed], drag[part][fixed]);
    assert.equal(measure.boundAxis, undefined);
    assert.equal(measure.label, axis === 'horizontal' ? '5,00' : '2,53');
    app.state.zonePoints = [{ x: 20, y: 30 }, { x: 900, y: 1000 }];
    app.syncBoundMeasures();
    assert.equal(measure[part][coordinate], drag[part][coordinate] + (coordinate === 'x' ? 65 : 93));
    app.controls.measureBinding.checked = true;
    app.controls.measureBinding.events.change();
    assert.equal(measure.a[coordinate], coordinate === 'x' ? 20 : 30);
    assert.equal(measure.b[coordinate], coordinate === 'x' ? 900 : 1000);
  });

  test(`${axis} dimension moves as a whole and endpoints do not flip`, () => {
    const { app, measure } = measureFixture(axis);
    const drag = { measure, part: 'line', start: { x: 0, y: 0 }, a: { ...measure.a }, b: { ...measure.b } };
    app.dragMeasure(drag, { x: 29, y: -46 });
    app.syncBoundMeasures();
    assert.equal(measure.a.x, drag.a.x + 29);
    assert.equal(measure.b.y, drag.b.y - 46);
    const coordinate = axis === 'horizontal' ? 'x' : 'y';
    const endpoint = { measure, part: 'a', start: { ...measure.a }, a: { ...measure.a }, b: { ...measure.b } };
    app.dragMeasure(endpoint, { x: 9000, y: 9000 });
    assert.equal(measure.b[coordinate] - measure.a[coordinate], 1);
  });
}

test('radius endpoints remain freely draggable in both directions', () => {
  const app = loadApp();
  const measure = { type: 'radius', a: { x: 100, y: 100 }, b: { x: 200, y: 200 } };
  app.dragMeasure({ measure, part: 'b', start: { ...measure.b }, a: { ...measure.a }, b: { ...measure.b } }, { x: 330, y: 175 });
  assert.equal(measure.b.x, 330);
  assert.equal(measure.b.y, 175);
});

test('a click or perpendicular endpoint motion keeps binding; returning to drag start restores position', () => {
  const { app, measure } = measureFixture('horizontal');
  const drag = { measure, part: 'b', start: { ...measure.b }, a: { ...measure.a }, b: { ...measure.b } };
  app.dragMeasure(drag, drag.start);
  app.dragMeasure(drag, { x: drag.start.x, y: drag.start.y + 100 });
  assert.equal(measure.boundAxis, 'horizontal');
  app.dragMeasure(drag, { x: drag.start.x - 100, y: drag.start.y });
  app.dragMeasure(drag, drag.start);
  assert.equal(measure.b.x, drag.b.x);
});

test('complete build maps symmetric input back to the displayed image center and clears empty output', () => {
  const app = loadApp();
  app.state.image = {};
  let blank = false;
  app.document.createElement = () => {
    const off = {};
    let rect;
    off.getContext = () => ({
      fillRect() {},
      drawImage(image, x, y, w, h) { rect = { x, y, w, h }; },
      getImageData() {
        const data = new Uint8ClampedArray(off.width * off.height * 4).fill(255);
        if (!blank) for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
          const nx = Math.abs(x - (rect.w - 1) / 2) / rect.w;
          const ny = y / rect.h;
          if (nx < 0.3 && ny > 0.1 && ny < 0.2 || nx < 0.08 && ny > 0.2 && ny < 0.9) {
            const index = ((y + rect.y) * off.width + x + rect.x) * 4;
            data[index] = data[index + 1] = data[index + 2] = 0;
          }
        }
        return { data };
      },
    });
    return off;
  };
  for (const width of [240, 347.25, 491]) {
    app.state.imageRect = { x: 281.25, y: 153.75, w: width, h: 513.75 };
    app.controls.radius.value = '187';
    app.buildZone();
    assert.ok(app.state.zoneContours.length);
    const center = app.state.imageRect.x + width / 2;
    const points = app.state.zonePoints;
    const pointSet = new Set(points.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
    for (const p of points) assert.ok(pointSet.has(`${(2 * center - p.x).toFixed(3)},${p.y.toFixed(3)}`));
    const bounds = ps => ({
      left: Math.min(...ps.map(p => p.x)), right: Math.max(...ps.map(p => p.x)),
      top: Math.min(...ps.map(p => p.y)), bottom: Math.max(...ps.map(p => p.y)),
    });
    const original = bounds(points);
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const control = app.controls['offset' + side[0].toUpperCase() + side.slice(1)];
      for (const amount of [60, -25, 1000]) {
        control.value = String(amount);
        app.buildZone();
        const changed = bounds(app.state.zonePoints);
        for (const edge of ['left', 'right', 'top', 'bottom']) {
          const expected = original[edge] + (edge === side ? amount * (side === 'left' || side === 'top' ? -1 : 1) : 0);
          assert.ok(Math.abs(changed[edge] - expected) < 1e-8, `${side} ${amount} changed ${edge} incorrectly`);
        }
        const fixed = side === 'left' || side === 'right' ? 'y' : 'x';
        assert.equal(app.state.zonePoints.length, points.length);
        app.state.zonePoints.forEach((p, i) => assert.equal(p[fixed], points[i][fixed]));
      }
      control.value = '0';
    }
    app.buildZone();
    assert.deepEqual(app.state.zonePoints, points);
  }
  blank = true;
  app.buildZone();
  assert.equal(app.state.zonePoints.length, 0);
  assert.equal(app.state.zoneContours.length, 0);
});

test('directional offsets preserve smooth tangents, disconnected contours, and combined bounds', () => {
  const app = loadApp();
  const contours = [0, 300].map(cx => Array.from({ length: 360 }, (_, i) => ({
    x: cx + 100 * Math.cos(i * Math.PI / 180), y: 200 + 80 * Math.sin(i * Math.PI / 180),
  })));
  const shifted = app.applyZoneOffsets(contours, { left: 60, right: 20, top: 15, bottom: 30 });
  assert.equal(shifted.length, 2);
  shifted.forEach((contour, j) => contour.forEach((p, i) => {
    const original = contours[j][i];
    assert.ok(Math.abs(p.x - (-160 + (original.x + 100) * 580 / 500)) < 1e-9);
    assert.ok(Math.abs(p.y - (105 + (original.y - 120) * 205 / 160)) < 1e-9);
    const next = contour[(i + 1) % contour.length];
    assert.ok(Math.hypot(next.x - p.x, next.y - p.y) < 3, 'unexpected step in the contour');
  }));
  const compressed = app.applyZoneOffsets(contours, { left: -1000, right: -1000, top: -1000, bottom: -1000 }).flat();
  assert.ok(compressed.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert.ok(Math.abs(Math.max(...compressed.map(p => p.x)) - Math.min(...compressed.map(p => p.x)) - 1) < 1e-8);
  assert.deepEqual(app.applyZoneOffsets([], { left: 60, right: 0, top: 0, bottom: 0 }), []);
});
