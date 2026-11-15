// Browser port of the FaceFusion image face-swap path:
// SCRFD 2.5g -> 5-point landmarks, ArcFace w600k r50 embedding,
// INSwapper 128 (fp16) with the model's emap, then affine paste-back.
// Templates and preprocessing follow FaceFusion (Henry Ruhs, OpenRAIL-AS).
// Image buffers are RGBA. Detector input is BGR; ArcFace and INSwapper are RGB.

export const DETECT_SIZE = 640;
export const SCORE_THRESHOLD = 0.5;
export const NMS_IOU = 0.4;

export const ARCFACE_112 = [
  [0.34191607, 0.46157411],
  [0.65653393, 0.45983393],
  [0.500225, 0.64050536],
  [0.37097589, 0.82469196],
  [0.63151696, 0.82325089],
];

export const ARCFACE_128 = [
  [0.36167656, 0.40387734],
  [0.63696719, 0.40235469],
  [0.50019687, 0.56044219],
  [0.38710391, 0.72160547],
  [0.61507734, 0.72034453],
];

export class SwapError extends Error {
  constructor(message) {
    super(message);
    this.name = "SwapError";
  }
}

export function extractEmap(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const sig = [0x08, 0x80, 0x04, 0x08, 0x80, 0x04, 0x10, 0x01, 0x42, 0x0b];
  const name = "initializer";
  let found = -1;
  for (let i = 0; i <= bytes.length - sig.length - name.length - 8; i++) {
    let match = true;
    for (let j = 0; j < sig.length; j++) {
      if (bytes[i + j] !== sig[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    let nameOk = true;
    for (let j = 0; j < name.length; j++) {
      if (bytes[i + sig.length + j] !== name.charCodeAt(j)) {
        nameOk = false;
        break;
      }
    }
    if (nameOk) {
      found = i;
      break;
    }
  }
  if (found < 0) {
    throw new SwapError("Model podmiany jest uszkodzony (brak emap).");
  }
  let p = found + sig.length + name.length;
  if (bytes[p] !== 0x4a) {
    throw new SwapError("Model podmiany jest uszkodzony (emap).");
  }
  p += 1;
  let len = 0;
  let shift = 0;
  while (p < bytes.length) {
    const v = bytes[p++];
    len |= (v & 0x7f) << shift;
    if ((v & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) break;
  }
  const expected = 512 * 512 * 4;
  if (len !== expected || p + len > bytes.length) {
    throw new SwapError("Model podmiany jest uszkodzony (rozmiar emap).");
  }
  const copy = new Uint8Array(expected);
  copy.set(bytes.subarray(p, p + expected));
  return new Float32Array(copy.buffer);
}

export function estimateSimilarity(src, dst) {
  const ata = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const atb = [0, 0, 0, 0];
  const add = (row, rhs) => {
    for (let i = 0; i < 4; i++) {
      atb[i] += row[i] * rhs;
      for (let j = 0; j < 4; j++) ata[i * 4 + j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < src.length; k++) {
    const x = src[k][0];
    const y = src[k][1];
    add([x, -y, 1, 0], dst[k][0]);
    add([y, x, 0, 1], dst[k][1]);
  }
  const rows = [0, 1, 2, 3].map((r) => {
    const row = new Float64Array(5);
    for (let c = 0; c < 4; c++) row[c] = ata[r * 4 + c];
    row[4] = atb[r];
    return row;
  });
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) {
      if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    }
    if (Math.abs(rows[pivot][col]) < 1e-12) {
      throw new SwapError("Nie udało się wyrównać twarzy.");
    }
    const tmp = rows[col];
    rows[col] = rows[pivot];
    rows[pivot] = tmp;
    const div = rows[col][col];
    for (let c = col; c < 5; c++) rows[col][c] /= div;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = rows[r][col];
      if (f === 0) continue;
      for (let c = col; c < 5; c++) rows[r][c] -= f * rows[col][c];
    }
  }
  const a = rows[0][4];
  const b = rows[1][4];
  const tx = rows[2][4];
  const ty = rows[3][4];
  return [a, -b, tx, b, a, ty];
}

function invertAffine(m) {
  const a = m[0];
  const b = m[1];
  const tx = m[2];
  const c = m[3];
  const d = m[4];
  const ty = m[5];
  const det = a * d - b * c;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, -(ia * tx + ib * ty), ic, id, -(ic * tx + id * ty)];
}

function applyPoint(m, x, y) {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

function sampleBilinear(data, w, h, channels, x, y, replicate) {
  if (!replicate && (x < 0 || y < 0 || x > w - 1 || y > h - 1)) {
    return new Array(channels).fill(0);
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const dx = x - x0;
  const dy = y - y0;
  const at = (xx, yy) => {
    let cx = xx;
    let cy = yy;
    if (replicate) {
      cx = Math.min(w - 1, Math.max(0, xx));
      cy = Math.min(h - 1, Math.max(0, yy));
    } else if (xx < 0 || yy < 0 || xx >= w || yy >= h) {
      return null;
    }
    const i = (cy * w + cx) * channels;
    const px = new Array(channels);
    for (let c = 0; c < channels; c++) px[c] = data[i + c];
    return px;
  };
  const p00 = at(x0, y0);
  const p10 = at(x1, y0);
  const p01 = at(x0, y1);
  const p11 = at(x1, y1);
  const out = new Array(channels).fill(0);
  const corners = [
    [p00, (1 - dx) * (1 - dy)],
    [p10, dx * (1 - dy)],
    [p01, (1 - dx) * dy],
    [p11, dx * dy],
  ];
  for (const [px, wgt] of corners) {
    if (!px || wgt === 0) continue;
    for (let c = 0; c < channels; c++) out[c] += px[c] * wgt;
  }
  return out;
}

function warp(data, sw, sh, channels, matrix, dw, dh, replicate) {
  const inv = invertAffine(matrix);
  const out = channels === 4 ? new Uint8ClampedArray(dw * dh * 4) : new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = inv[0] * x + inv[1] * y + inv[2];
      const sy = inv[3] * x + inv[4] * y + inv[5];
      const px = sampleBilinear(data, sw, sh, channels, sx, sy, replicate);
      if (channels === 4) {
        const o = (y * dw + x) * 4;
        out[o] = px[0];
        out[o + 1] = px[1];
        out[o + 2] = px[2];
        out[o + 3] = 255;
      } else {
        out[y * dw + x] = px[0];
      }
    }
  }
  return out;
}

function warpFace(image, landmark, template, size) {
  const dst = template.map((p) => [p[0] * size, p[1] * size]);
  const matrix = estimateSimilarity(landmark, dst);
  const crop = warp(image.data, image.width, image.height, 4, matrix, size, size, true);
  return { crop, matrix, size };
}

function resizeTo(image, dw, dh) {
  if (dw === image.width && dh === image.height) return image.data;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const scaleX = image.width / dw;
  const scaleY = image.height / dh;
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * scaleY - 0.5;
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * scaleX - 0.5;
      const px = sampleBilinear(image.data, image.width, image.height, 4, sx, sy, true);
      const o = (y * dw + x) * 4;
      out[o] = px[0];
      out[o + 1] = px[1];
      out[o + 2] = px[2];
      out[o + 3] = 255;
    }
  }
  return out;
}

function prepareDetect(image, size) {
  let rw = image.width;
  let rh = image.height;
  if (image.width > size || image.height > size) {
    const scale = Math.min(size / image.width, size / image.height);
    rw = Math.max(1, Math.round(image.width * scale));
    rh = Math.max(1, Math.round(image.height * scale));
  }
  const resized = resizeTo(image, rw, rh);
  const input = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = (y * rw + x) * 4;
      const r = resized[i];
      const g = resized[i + 1];
      const b = resized[i + 2];
      const o = y * size + x;
      input[o] = (b - 127.5) / 128;
      input[plane + o] = (g - 127.5) / 128;
      input[2 * plane + o] = (r - 127.5) / 128;
    }
  }
  return { input, ratioX: image.width / rw, ratioY: image.height / rh };
}

function makeAnchors(stride, anchorTotal, strideHeight, strideWidth) {
  const count = strideWidth * strideHeight * anchorTotal;
  const anchors = new Float32Array(count * 2);
  let p = 0;
  for (let i = 0; i < strideWidth; i++) {
    for (let j = 0; j < strideHeight; j++) {
      const ax = j * stride;
      const ay = i * stride;
      for (let k = 0; k < anchorTotal; k++) {
        anchors[p++] = ax;
        anchors[p++] = ay;
      }
    }
  }
  return anchors;
}

function nms(boxes, scores, iouThreshold) {
  const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
  const keep = [];
  const used = new Uint8Array(boxes.length);
  for (const i of order) {
    if (used[i]) continue;
    keep.push(i);
    const a = boxes[i];
    const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
    for (const j of order) {
      if (used[j] || j === i) continue;
      const b = boxes[j];
      const xx1 = Math.max(a[0], b[0]);
      const yy1 = Math.max(a[1], b[1]);
      const xx2 = Math.min(a[2], b[2]);
      const yy2 = Math.min(a[3], b[3]);
      const inter = Math.max(0, xx2 - xx1) * Math.max(0, yy2 - yy1);
      const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
      const iou = inter / (areaA + areaB - inter + 1e-6);
      if (iou > iouThreshold) used[j] = 1;
    }
  }
  return keep;
}

export async function detectFaces(ort, session, image, size = DETECT_SIZE) {
  const { input, ratioX, ratioY } = prepareDetect(image, size);
  const tensor = new ort.Tensor("float32", input, [1, 3, size, size]);
  const out = await session.run({ input: tensor });
  const boxes = [];
  const scores = [];
  const landmarks = [];
  for (let index = 0; index < 3; index++) {
    const stride = [8, 16, 32][index];
    const scoreT = out[String(index)];
    const boxT = out[String(index + 3)];
    const kpsT = out[String(index + 6)];
    const scoreData = scoreT.data;
    const boxData = boxT.data;
    const kpsData = kpsT.data;
    const n = scoreData.length;
    const strideHeight = (size / stride) | 0;
    const strideWidth = (size / stride) | 0;
    const anchors = makeAnchors(stride, 2, strideHeight, strideWidth);
    if (anchors.length / 2 !== n) {
      throw new SwapError("Detektor zwrócił niespodziewany wynik.");
    }
    for (let i = 0; i < n; i++) {
      const score = scoreData[i];
      if (score < SCORE_THRESHOLD) continue;
      const ax = anchors[i * 2];
      const ay = anchors[i * 2 + 1];
      const l = boxData[i * 4];
      const t = boxData[i * 4 + 1];
      const r = boxData[i * 4 + 2];
      const b = boxData[i * 4 + 3];
      const lm = [];
      for (let k = 0; k < 5; k++) {
        lm.push([
          (ax + kpsData[i * 10 + k * 2] * stride) * ratioX,
          (ay + kpsData[i * 10 + k * 2 + 1] * stride) * ratioY,
        ]);
      }
      boxes.push([
        (ax - l * stride) * ratioX,
        (ay - t * stride) * ratioY,
        (ax + r * stride) * ratioX,
        (ay + b * stride) * ratioY,
      ]);
      scores.push(score);
      landmarks.push(lm);
    }
  }
  const keep = nms(boxes, scores, NMS_IOU);
  const faces = keep.map((i) => ({
    box: boxes[i],
    score: scores[i],
    landmark: landmarks[i],
  }));
  faces.sort((a, b) => {
    const aa = Math.max(0, a.box[2] - a.box[0]) * Math.max(0, a.box[3] - a.box[1]);
    const bb = Math.max(0, b.box[2] - b.box[0]) * Math.max(0, b.box[3] - b.box[1]);
    return bb - aa;
  });
  return faces;
}

function cropToNchw(crop, size, kind) {
  const data = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let i = 0; i < plane; i++) {
    const r = crop[i * 4];
    const g = crop[i * 4 + 1];
    const b = crop[i * 4 + 2];
    if (kind === "arc") {
      data[i] = r / 127.5 - 1;
      data[plane + i] = g / 127.5 - 1;
      data[2 * plane + i] = b / 127.5 - 1;
    } else {
      data[i] = r / 255;
      data[plane + i] = g / 255;
      data[2 * plane + i] = b / 255;
    }
  }
  return data;
}

function nchwToRgba(data, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  const plane = size * size;
  for (let i = 0; i < plane; i++) {
    const r = Math.min(1, Math.max(0, data[i]));
    const g = Math.min(1, Math.max(0, data[plane + i]));
    const b = Math.min(1, Math.max(0, data[2 * plane + i]));
    out[i * 4] = Math.round(r * 255);
    out[i * 4 + 1] = Math.round(g * 255);
    out[i * 4 + 2] = Math.round(b * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function applyEmap(embedding, emap) {
  let norm = 0;
  for (let i = 0; i < 512; i++) norm += embedding[i] * embedding[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(512);
  for (let j = 0; j < 512; j++) {
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += embedding[i] * emap[i * 512 + j];
    out[j] = sum / norm;
  }
  return out;
}

export async function embedFace(ort, session, image, landmark) {
  const { crop, size } = warpFace(image, landmark, ARCFACE_112, 112);
  const data = cropToNchw(crop, size, "arc");
  const tensor = new ort.Tensor("float32", data, [1, 3, 112, 112]);
  const out = await session.run({ input: tensor });
  const emb = out.output.data;
  const flat = new Float32Array(512);
  flat.set(emb.subarray(0, 512));
  return flat;
}

function gaussianBlur(src, w, h, sigma) {
  if (sigma <= 0) return src;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        acc += src[y * w + xx] * kernel[k + radius];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        acc += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

function convexHull(points) {
  const pts = points
    .map((p) => [p[0], p[1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list) => {
    const hull = [];
    for (const p of list) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    return hull;
  };
  const lower = build(pts);
  const upper = build(pts.slice().reverse());
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function fillPoly(w, h, poly) {
  const mask = new Float32Array(w * h);
  const n = poly.length;
  if (n < 3) return mask;
  for (let y = 0; y < h; y++) {
    const ys = y + 0.5;
    const xs = [];
    for (let i = 0; i < n; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % n];
      if ((y1 <= ys && y2 > ys) || (y2 <= ys && y1 > ys)) {
        const t = (ys - y1) / (y2 - y1);
        xs.push(x1 + t * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      let x0 = Math.ceil(xs[i]);
      let x1 = Math.floor(xs[i + 1]);
      if (x0 < 0) x0 = 0;
      if (x1 >= w) x1 = w - 1;
      for (let x = x0; x <= x1; x++) mask[y * w + x] = 1;
    }
  }
  return mask;
}

function buildMask(size, matrix, landmark) {
  const blur = 0.3;
  const blurAmount = (size * 0.5 * blur) | 0;
  const blurArea = Math.max((blurAmount / 2) | 0, 1);
  const box = new Float32Array(size * size);
  box.fill(1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (y < blurArea || y >= size - blurArea || x < blurArea || x >= size - blurArea) {
        box[y * size + x] = 0;
      }
    }
  }
  const softBox = gaussianBlur(box, size, size, blurAmount * 0.25);
  const cropLm = landmark.map(([x, y]) => applyPoint(matrix, x, y));
  let cx = 0;
  let cy = 0;
  for (const p of cropLm) {
    cx += p[0];
    cy += p[1];
  }
  cx /= cropLm.length;
  cy /= cropLm.length;
  const expanded = cropLm.map((p) => [cx + (p[0] - cx) * 1.35, cy + (p[1] - cy) * 1.35]);
  const eye = [(cropLm[0][0] + cropLm[1][0]) / 2, (cropLm[0][1] + cropLm[1][1]) / 2];
  const nose = cropLm[2];
  const mouth = [(cropLm[3][0] + cropLm[4][0]) / 2, (cropLm[3][1] + cropLm[4][1]) / 2];
  const forehead = [eye[0] + (eye[0] - nose[0]) * 0.85, eye[1] + (eye[1] - nose[1]) * 0.85];
  const chin = [mouth[0] + (mouth[0] - nose[0]) * 0.55, mouth[1] + (mouth[1] - nose[1]) * 0.55];
  const hull = convexHull([...expanded, forehead, chin]);
  const oval = gaussianBlur(fillPoly(size, size, hull), size, size, 6);
  const mask = new Float32Array(size * size);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = Math.min(1, Math.max(0, Math.min(softBox[i], oval[i])));
  }
  return mask;
}

function pasteBack(frame, crop, mask, matrix, size) {
  const inv = invertAffine(matrix);
  const corners = [
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ].map(([x, y]) => applyPoint(inv, x, y));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const x1 = Math.min(frame.width, Math.max(0, Math.floor(minX)));
  const y1 = Math.min(frame.height, Math.max(0, Math.floor(minY)));
  const x2 = Math.min(frame.width, Math.max(0, Math.ceil(maxX)));
  const y2 = Math.min(frame.height, Math.max(0, Math.ceil(maxY)));
  const pw = x2 - x1;
  const ph = y2 - y1;
  if (pw < 2 || ph < 2) return frame;
  const paste = inv.slice();
  paste[2] -= x1;
  paste[5] -= y1;
  const warped = warp(crop, size, size, 4, paste, pw, ph, true);
  const warpedMask = warp(mask, size, size, 1, paste, pw, ph, false);
  const outData = new Uint8ClampedArray(frame.data);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const m = Math.min(1, Math.max(0, warpedMask[y * pw + x]));
      const di = ((y + y1) * frame.width + (x + x1)) * 4;
      const si = (y * pw + x) * 4;
      outData[di] = Math.round(outData[di] * (1 - m) + warped[si] * m);
      outData[di + 1] = Math.round(outData[di + 1] * (1 - m) + warped[si + 1] * m);
      outData[di + 2] = Math.round(outData[di + 2] * (1 - m) + warped[si + 2] * m);
      outData[di + 3] = 255;
    }
  }
  return { width: frame.width, height: frame.height, data: outData };
}

export async function swapPrepared(ort, scrfd, swap, emap, sourceEmbedding, target) {
  const targetFaces = await detectFaces(ort, scrfd, target);
  if (!targetFaces.length) {
    throw new SwapError("Nie widzę twarzy na drugim obrazie. Potrzebna jest jedna wyraźna twarz.");
  }
  const targetFace = targetFaces[0];
  const sourceInput = applyEmap(sourceEmbedding, emap);
  const { crop, matrix, size } = warpFace(target, targetFace.landmark, ARCFACE_128, 128);
  const targetInput = cropToNchw(crop, size, "swap");
  const targetTensor = new ort.Tensor("float32", targetInput, [1, 3, 128, 128]);
  const sourceTensor = new ort.Tensor("float32", sourceInput, [1, 512]);
  const swapped = await swap.run({ target: targetTensor, source: sourceTensor });
  const swappedRgba = nchwToRgba(swapped.output.data, 128);
  const mask = buildMask(128, matrix, targetFace.landmark);
  const image = pasteBack(target, swappedRgba, mask, matrix, 128);
  return {
    image,
    targetFaces: targetFaces.length,
    targetLandmark: targetFace.landmark,
  };
}

export async function swapLargest(ort, sessions, emap, source, target) {
  const sourceFaces = await detectFaces(ort, sessions.scrfd, source);
  if (!sourceFaces.length) {
    throw new SwapError("Nie widzę twarzy na Twoim zdjęciu. Ustaw ją przodem, w dobrym świetle.");
  }
  const embedding = await embedFace(ort, sessions.arc, source, sourceFaces[0].landmark);
  const swapped = await swapPrepared(ort, sessions.scrfd, sessions.swap, emap, embedding, target);
  return {
    ...swapped,
    sourceFaces: sourceFaces.length,
    sourceLandmark: sourceFaces[0].landmark,
  };
}

export async function createSessions(ort, models, providers) {
  const opts = { graphOptimizationLevel: "basic" };
  if (providers) opts.executionProviders = providers;
  const scrfd = await ort.InferenceSession.create(models.scrfd, opts);
  const arc = await ort.InferenceSession.create(models.arcface, opts);
  const swap = await ort.InferenceSession.create(models.inswapper, opts);
  return { scrfd, arc, swap };
}

export async function releaseSessions(sessions) {
  if (!sessions) return;
  for (const key of ["arc", "swap", "scrfd"]) {
    if (sessions[key]) {
      await sessions[key].release();
      sessions[key] = null;
    }
  }
}
