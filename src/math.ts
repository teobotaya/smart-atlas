export type Vec = ArrayLike<number>;

export const rng = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export function dot(a: Vec, b: Vec): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export const magnitude = (a: Vec): number => Math.sqrt(dot(a, a)) || 1e-9;

export const cosine = (a: Vec, b: Vec): number => dot(a, b) / (magnitude(a) * magnitude(b));

export function unit(a: Vec): Float32Array {
  const m = magnitude(a), o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] / m;
  return o;
}

function center(rows: Float32Array[]): Float32Array[] {
  const d = rows[0].length, mean = new Float32Array(d);
  for (const r of rows) for (let i = 0; i < d; i++) mean[i] += r[i];
  for (let i = 0; i < d; i++) mean[i] /= rows.length;
  return rows.map((r) => {
    const o = new Float32Array(d);
    for (let i = 0; i < d; i++) o[i] = r[i] - mean[i];
    return o;
  });
}

function principal(rows: Float32Array[], iters: number, rand: () => number): Float32Array {
  const d = rows[0].length;
  let v = new Float32Array(d);
  for (let i = 0; i < d; i++) v[i] = rand() - 0.5;
  v = unit(v);
  for (let it = 0; it < iters; it++) {
    const next = new Float32Array(d);
    for (const r of rows) {
      const p = dot(r, v);
      for (let i = 0; i < d; i++) next[i] += p * r[i];
    }
    v = unit(next);
  }
  return v;
}

/**
 * Johnson–Lindenstrauss projection. Keeps pairwise cosine distances while making
 * clustering and neighbour search tractable on sparse TF-IDF vectors.
 */
export function randomProject(vectors: Float32Array[], dim = 64, seed = 23): Float32Array[] {
  const src = vectors[0]?.length ?? 0;
  if (!src || src <= dim) return vectors;
  const rand = rng(seed);
  const basis: Float32Array[] = [];
  for (let j = 0; j < dim; j++) {
    const r = new Float32Array(src);
    for (let i = 0; i < src; i++) r[i] = rand() * 2 - 1;
    basis.push(unit(r));
  }
  return vectors.map((v) => {
    const o = new Float32Array(dim);
    for (let j = 0; j < dim; j++) o[j] = dot(v, basis[j]);
    return unit(o);
  });
}

/** Projects high-dimensional embeddings onto their two principal components. */
export function pca2(vectors: Float32Array[], seed = 7): [number, number][] {
  if (vectors.length < 2) return vectors.map(() => [0, 0] as [number, number]);
  const rand = rng(seed);
  const rows = center(vectors);
  const c1 = principal(rows, 24, rand);
  const deflated = rows.map((r) => {
    const p = dot(r, c1), o = new Float32Array(r.length);
    for (let i = 0; i < r.length; i++) o[i] = r[i] - p * c1[i];
    return o;
  });
  const c2 = principal(deflated, 24, rand);
  return rows.map((r) => [dot(r, c1), dot(r, c2)] as [number, number]);
}

/** k-means++ over unit vectors; returns a cluster index per input. */
export function kmeans(vectors: Float32Array[], k: number, iters = 24, seed = 11): number[] {
  const n = vectors.length;
  if (n === 0) return [];
  k = Math.max(1, Math.min(k, n));
  const rand = rng(seed), d = vectors[0].length;
  const centers: Float32Array[] = [vectors[Math.floor(rand() * n)]];
  while (centers.length < k) {
    const dist = vectors.map((v) => Math.min(...centers.map((c) => 1 - cosine(v, c))));
    const total = dist.reduce((a, b) => a + b, 0) || 1;
    let acc = rand() * total, pick = 0;
    for (let i = 0; i < n; i++) { acc -= dist[i]; if (acc <= 0) { pick = i; break; } }
    centers.push(vectors[pick]);
  }
  const assign = new Array<number>(n).fill(0);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bestScore = -Infinity;
      for (let c = 0; c < centers.length; c++) {
        const s = cosine(vectors[i], centers[c]);
        if (s > bestScore) { bestScore = s; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    for (let c = 0; c < centers.length; c++) {
      const acc = new Float32Array(d);
      let count = 0;
      for (let i = 0; i < n; i++) if (assign[i] === c) { count++; for (let j = 0; j < d; j++) acc[j] += vectors[i][j]; }
      if (count) centers[c] = unit(acc);
    }
    if (!moved) break;
  }
  return assign;
}

/** Repels overlapping points while keeping the PCA structure. */
export function relax(points: [number, number][], iterations = 60, minDist = 26): [number, number][] {
  const p = points.map(([x, y]) => [x, y] as [number, number]);
  const n = p.length;
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = p[j][0] - p[i][0], dy = p[j][1] - p[i][1];
        let dist = Math.hypot(dx, dy);
        if (dist > minDist) continue;
        if (dist < 1e-6) { dx = (i - j) * 0.01 + 0.01; dy = 0.01; dist = Math.hypot(dx, dy); }
        const push = ((minDist - dist) / dist) * 0.5;
        p[i][0] -= dx * push; p[i][1] -= dy * push;
        p[j][0] += dx * push; p[j][1] += dy * push;
      }
    }
  }
  return p;
}

export function fitToBox(points: [number, number][], w: number, h: number, pad = 48): [number, number][] {
  if (!points.length) return points;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const sx = (w - pad * 2) / (maxX - minX || 1);
  const sy = (h - pad * 2) / (maxY - minY || 1);
  const s = Math.min(sx, sy);
  const ox = (w - (maxX - minX) * s) / 2, oy = (h - (maxY - minY) * s) / 2;
  return points.map(([x, y]) => [(x - minX) * s + ox, (y - minY) * s + oy] as [number, number]);
}
