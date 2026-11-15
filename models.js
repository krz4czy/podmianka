export const MODEL_BASE = "https://huggingface.co/facefusion/models-3.0.0/resolve/main/";

export const MODELS = [
  { id: "scrfd", file: "scrfd_2.5g.onnx", bytes: 3295067, label: "detektor twarzy" },
  { id: "arcface", file: "arcface_w600k_r50.onnx", bytes: 174388474, label: "odcisk twarzy" },
  { id: "inswapper", file: "inswapper_128_fp16.onnx", bytes: 277680829, label: "model podmiany" },
];

export const MODEL_BYTES = MODELS.reduce((sum, model) => sum + model.bytes, 0);
const CACHE_NAME = "podmianka-models-v1";
const memory = new Map();

export function resolveModelBase() {
  const query = new URLSearchParams(location.search).get("modelBase");
  if (!query) return MODEL_BASE;
  const url = new URL(query, location.href);
  const href = url.href;
  return href.endsWith("/") ? href : href + "/";
}

export function modelUrl(file, base) {
  return new URL(file, base || MODEL_BASE).href;
}

async function openCache() {
  if (!("caches" in globalThis)) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function fetchBuffer(url, spec, onProgress, signal) {
  const response = await fetch(url, { signal, mode: "cors", credentials: "omit" });
  if (!response.ok) {
    throw new Error("Nie mogę pobrać modelu (" + spec.label + "). Sprawdź sieć i spróbuj jeszcze raz.");
  }
  const total = Number(response.headers.get("content-length")) || spec.bytes;
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onProgress?.({ id: spec.id, label: spec.label, loaded: buffer.byteLength, total, cached: false });
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ id: spec.id, label: spec.label, loaded, total, cached: false });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export async function downloadModels(base, onProgress, signal) {
  const cache = await openCache();
  for (const spec of MODELS) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const url = modelUrl(spec.file, base);
    if (memory.has(url)) {
      onProgress?.({ id: spec.id, label: spec.label, loaded: spec.bytes, total: spec.bytes, cached: true });
      continue;
    }
    if (cache) {
      const hit = await cache.match(url);
      if (hit) {
        onProgress?.({ id: spec.id, label: spec.label, loaded: spec.bytes, total: spec.bytes, cached: true });
        continue;
      }
    }
    const buffer = await fetchBuffer(url, spec, onProgress, signal);
    if (cache) {
      try {
        await cache.put(
          url,
          new Response(buffer.slice(0), {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(buffer.byteLength),
            },
          }),
        );
      } catch {
        memory.set(url, buffer);
      }
    } else {
      memory.set(url, buffer);
    }
  }
}

export async function readModel(id, base) {
  const spec = MODELS.find((model) => model.id === id);
  const url = modelUrl(spec.file, base);
  if (memory.has(url)) return memory.get(url);
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return hit.arrayBuffer();
  }
  return fetchBuffer(url, spec);
}
