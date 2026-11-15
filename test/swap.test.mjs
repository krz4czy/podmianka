import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import * as ort from "onnxruntime-node";
import { estimateSimilarity, extractEmap, swapLargest } from "../pipeline.js";

function decode(path) {
  const decoded = jpeg.decode(readFileSync(path), { useTArray: true, formatAsRGBA: true });
  return { width: decoded.width, height: decoded.height, data: decoded.data };
}

function mae(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / ((n / 4) * 3);
}

const affine = estimateSimilarity(
  [
    [100, 120],
    [180, 118],
    [140, 160],
    [120, 190],
    [165, 188],
  ],
  [
    [40, 50],
    [90, 48],
    [65, 80],
    [50, 100],
    [85, 98],
  ],
);
const expected = [0.69135128, 0.009833056, -33.00662, -0.009833056, 0.69135128, -30.71126];
for (let i = 0; i < expected.length; i++) {
  assert.ok(Math.abs(affine[i] - expected[i]) < 1e-4, "affine " + i + " " + affine[i]);
}

const inswapper = readFileSync("/tmp/ff/inswapper_128_fp16.onnx");
const emap = extractEmap(inswapper);
assert.equal(emap.length, 512 * 512);
assert.ok(Math.abs(emap[0] - 0.12484695) < 1e-5);

const source = decode(new URL("./fixtures/source.jpg", import.meta.url));
const target = decode(new URL("./fixtures/target.jpg", import.meta.url));
const sessions = {
  scrfd: await ort.InferenceSession.create("/tmp/models/scrfd_2.5g.onnx", { graphOptimizationLevel: "basic" }),
  arc: await ort.InferenceSession.create("/tmp/ff/arcface_w600k_r50.onnx", { graphOptimizationLevel: "basic" }),
  swap: await ort.InferenceSession.create(inswapper, { graphOptimizationLevel: "basic" }),
};

const result = await swapLargest(ort, sessions, emap, source, target);
const sourceLm = [
  [260.53, 323.09],
  [416.52, 316.46],
  [327.71, 407.69],
  [288.5, 487.08],
  [401.92, 481.89],
];
for (let i = 0; i < 5; i++) {
  const dx = Math.abs(result.sourceLandmark[i][0] - sourceLm[i][0]);
  const dy = Math.abs(result.sourceLandmark[i][1] - sourceLm[i][1]);
  assert.ok(dx < 6 && dy < 6, "landmark " + i + " " + dx + " " + dy + " got " + result.sourceLandmark[i]);
}

const whole = mae(result.image.data, target.data);
assert.ok(whole > 1, "result should change the photo, mae " + whole);
assert.ok(whole < 25, "background should stay, mae " + whole);

const png = new PNG({ width: result.image.width, height: result.image.height });
png.data = Buffer.from(result.image.data);
writeFileSync("/tmp/faces/js-result.png", PNG.sync.write(png));
console.log("swap ok", { faces: result.sourceFaces, mae: whole.toFixed(2) });

await sessions.scrfd.release();
await sessions.arc.release();
await sessions.swap.release();
