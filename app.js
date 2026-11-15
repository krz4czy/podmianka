import { detectFaces, embedFace, extractEmap, swapPrepared, SwapError } from "./pipeline.js";
import { MODEL_BYTES, downloadModels, readModel, resolveModelBase } from "./models.js";

const PHOTO_MAX = 1280;
const VIDEO_MAX_SIDE = 480;
const VIDEO_MAX_SECONDS = 4;
const VIDEO_FPS = 6;
const PROMPT_SUFFIX = ", single person, clear frontal face, photo, looking at camera";

const els = {
  tabPhoto: document.querySelector("#tab-photo"),
  tabText: document.querySelector("#tab-text"),
  panelPhoto: document.querySelector("#panel-photo"),
  panelText: document.querySelector("#panel-text"),
  pickSource: document.querySelector("#pick-source"),
  pickTarget: document.querySelector("#pick-target"),
  fileSource: document.querySelector("#file-source"),
  fileTarget: document.querySelector("#file-target"),
  previewSource: document.querySelector("#preview-source"),
  previewTarget: document.querySelector("#preview-target"),
  targetName: document.querySelector("#target-name"),
  prompt: document.querySelector("#prompt"),
  btnSwap: document.querySelector("#btn-swap"),
  btnCreate: document.querySelector("#btn-create"),
  btnCancel: document.querySelector("#btn-cancel"),
  btnSave: document.querySelector("#btn-save"),
  statusCard: document.querySelector("#status-card"),
  status: document.querySelector("#status"),
  bar: document.querySelector("#bar"),
  resultCard: document.querySelector("#result-card"),
  resultLabel: document.querySelector("#result-label"),
  resultImage: document.querySelector("#result-image"),
  resultVideo: document.querySelector("#result-video"),
  resultNote: document.querySelector("#result-note"),
  error: document.querySelector("#error"),
};

const state = {
  sourceFile: null,
  sourceImage: null,
  targetFile: null,
  targetImage: null,
  targetKind: null,
  busy: false,
  abort: null,
  resultBlob: null,
  resultName: "podmianka.jpg",
  runtime: null,
};

function mb(bytes) {
  return (bytes / (1024 * 1024)).toLocaleString("pl-PL", { maximumFractionDigits: 1 });
}

function setError(message) {
  if (!message) {
    els.error.hidden = true;
    els.error.textContent = "";
    return;
  }
  els.error.hidden = false;
  els.error.textContent = message;
}

function setBusy(busy) {
  state.busy = busy;
  els.btnSwap.disabled = busy;
  els.btnCreate.disabled = busy;
  els.pickSource.disabled = busy;
  els.pickTarget.disabled = busy;
  els.statusCard.hidden = !busy;
  if (!busy) els.bar.style.width = "0%";
}

function setStatus(text, ratio) {
  els.status.textContent = text;
  if (typeof ratio === "number") els.bar.style.width = Math.max(0, Math.min(1, ratio)) * 100 + "%";
}

function showTab(which) {
  const photo = which === "photo";
  els.tabPhoto.setAttribute("aria-selected", photo ? "true" : "false");
  els.tabText.setAttribute("aria-selected", photo ? "false" : "true");
  els.panelPhoto.hidden = !photo;
  els.panelText.hidden = photo;
}

async function fileToImage(file, maxSide) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new SwapError("Nie umiem odczytać tego zdjęcia. Zapisz je jako JPEG i spróbuj jeszcze raz.");
  }
  return bitmapToImage(bitmap, maxSide);
}

function bitmapToImage(bitmap, maxSide) {
  let width = bitmap.width;
  let height = bitmap.height;
  const longest = Math.max(width, height);
  if (maxSide && longest > maxSide) {
    const scale = maxSide / longest;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  if (bitmap.close) bitmap.close();
  return { width, height, data: new Uint8ClampedArray(image.data) };
}

function imageToCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d").putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new SwapError("Nie udało się zapisać obrazu."));
      else resolve(blob);
    }, type, quality);
  });
}

async function loadRuntime(preferWebgpu) {
  const base = new URL("vendor/ort/", document.baseURI).href;
  const ort = preferWebgpu
    ? await import("./vendor/ort/ort.webgpu.min.mjs")
    : await import("./vendor/ort/ort.wasm.min.mjs");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = base;
  ort.env.logLevel = "error";
  return { ort, providers: preferWebgpu ? ["webgpu", "wasm"] : ["wasm"] };
}

async function runtime() {
  if (state.runtime) return state.runtime;
  const forced = new URLSearchParams(location.search).get("engine");
  const preferWebgpu = forced !== "wasm" && typeof navigator !== "undefined" && !!navigator.gpu;
  try {
    if (preferWebgpu) {
      state.runtime = await loadRuntime(true);
      state.runtime.kind = "webgpu";
      return state.runtime;
    }
  } catch (error) {
    console.warn(error);
  }
  state.runtime = await loadRuntime(false);
  state.runtime.kind = "wasm";
  return state.runtime;
}

async function openSession(ort, buffer, providers) {
  const primary = providers[0] || "wasm";
  const options = { graphOptimizationLevel: "basic" };
  try {
    return await ort.InferenceSession.create(buffer, { ...options, executionProviders: [primary] });
  } catch (error) {
    if (primary !== "wasm") {
      return ort.InferenceSession.create(buffer, { ...options, executionProviders: ["wasm"] });
    }
    throw error;
  }
}

async function withModels(sourceImage, frames, onFrame) {
  const base = resolveModelBase();
  setStatus("Pobieram modele (raz, około " + mb(MODEL_BYTES) + " MB)…", 0.02);
  await downloadModels(base, (progress) => {
    const ratio = progress.total ? progress.loaded / progress.total : 0;
    const prefix = progress.cached ? "Mam już w pamięci" : "Pobieram";
    setStatus(prefix + ": " + progress.label + " · " + mb(progress.loaded) + " / " + mb(progress.total) + " MB", ratio);
  }, state.abort.signal);
  const pack = await runtime();
  const device = pack.kind === "webgpu" ? "WebGPU" : "procesor";
  let scrfd;
  let arc;
  let swap;
  try {
    setStatus("Uruchamiam detektor (" + device + ")…", 0.2);
    let buffer = await readModel("scrfd", base);
    try {
      scrfd = await openSession(pack.ort, buffer, pack.providers);
    } catch (error) {
      if (pack.kind === "wasm") throw error;
      state.runtime = await loadRuntime(false);
      state.runtime.kind = "wasm";
      pack = state.runtime;
      scrfd = await openSession(pack.ort, buffer, ["wasm"]);
    }
    buffer = null;
    const sourceFaces = await detectFaces(pack.ort, scrfd, sourceImage);
    if (!sourceFaces.length) {
      throw new SwapError("Nie widzę twarzy na Twoim zdjęciu. Ustaw ją przodem, w dobrym świetle.");
    }
    setStatus("Liczę odcisk twarzy…", 0.4);
    buffer = await readModel("arcface", base);
    arc = await openSession(pack.ort, buffer, pack.providers);
    buffer = null;
    const embedding = await embedFace(pack.ort, arc, sourceImage, sourceFaces[0].landmark);
    await arc.release();
    arc = null;
    setStatus("Uruchamiam podmianę…", 0.55);
    buffer = await readModel("inswapper", base);
    const emap = extractEmap(buffer);
    swap = await openSession(pack.ort, buffer, pack.providers);
    buffer = null;
    const results = [];
    for (let i = 0; i < frames.length; i++) {
      if (state.abort.signal.aborted) throw new DOMException("aborted", "AbortError");
      onFrame?.(i, frames.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
      results.push(await swapPrepared(pack.ort, scrfd, swap, emap, embedding, frames[i]));
    }
    return results;
  } finally {
    for (const session of [arc, swap, scrfd]) {
      if (session) await session.release().catch(() => {});
    }
  }
}

function showImageResult(image, note) {
  const canvas = imageToCanvas(image);
  const url = canvas.toDataURL("image/jpeg", 0.92);
  els.resultImage.src = url;
  els.resultImage.hidden = false;
  els.resultVideo.hidden = true;
  els.resultVideo.removeAttribute("src");
  els.resultCard.hidden = false;
  els.resultLabel.textContent = "Wynik";
  els.resultNote.textContent = note || "Podmieniam największą twarz. Poza i światło zostają z drugiego zdjęcia.";
  els.resultCard.dataset.state = "done";
  return canvasToBlob(canvas, "image/jpeg", 0.92).then((blob) => {
    state.resultBlob = blob;
    state.resultName = "podmianka.jpg";
  });
}

async function runPhoto() {
  if (!state.sourceImage) throw new SwapError("Najpierw wybierz zdjęcie swojej twarzy.");
  if (!state.targetImage && state.targetKind !== "video") throw new SwapError("Wybierz zdjęcie albo film, na które podmieniamy.");
  if (state.targetKind === "video") return runVideo();
  const [outcome] = await withModels(state.sourceImage, [state.targetImage], () => {
    setStatus("Szukam twarzy i podmieniam…", 0.8);
  });
  await showImageResult(outcome.image);
}

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - time) < 0.04) {
      resolve();
      return;
    }
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new SwapError("Nie mogę przewinąć tego filmu."));
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    try {
      video.currentTime = time;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function drawVideoFrame(video) {
  const longest = Math.max(video.videoWidth, video.videoHeight);
  const scale = longest > VIDEO_MAX_SIDE ? VIDEO_MAX_SIDE / longest : 1;
  const width = Math.max(2, Math.round(video.videoWidth * scale));
  const height = Math.max(2, Math.round(video.videoHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  return { width, height, data: new Uint8ClampedArray(image.data) };
}

async function readVideoFrames(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new SwapError("Nie mogę odtworzyć tego filmu."));
    });
    try {
      await video.play();
    } catch {
      // Headless and iOS can reject play(); seeking still paints a frame.
    }
    video.pause();
    const full = video.duration;
    if (!full || !Number.isFinite(full)) throw new SwapError("Ten film nie ma odczytywalnej długości.");
    const duration = Math.min(full, VIDEO_MAX_SECONDS);
    const count = Math.max(1, Math.round(duration * VIDEO_FPS));
    const frames = [];
    for (let i = 0; i < count; i++) {
      if (state.abort.signal.aborted) throw new DOMException("aborted", "AbortError");
      const time = Math.min(Math.max(0, duration - 0.05), i / VIDEO_FPS);
      await seekVideo(video, time);
      const frame = await new Promise((resolve) => {
        const started = performance.now();
        const tick = () => {
          const painted = video.readyState >= 2 ? drawVideoFrame(video) : null;
          let energy = 0;
          if (painted) {
            for (let p = 0; p < painted.data.length; p += 64 * 4) energy += painted.data[p];
          }
          if (painted && (energy > 8 || performance.now() - started > 700)) resolve(painted);
          else if (performance.now() - started > 700) resolve(drawVideoFrame(video));
          else requestAnimationFrame(tick);
        };
        tick();
      });
      frames.push(frame);
      setStatus("Czytam klatkę " + (i + 1) + " / " + count + "…", (i + 1) / count);
    }
    return { frames, fps: VIDEO_FPS, capped: full > VIDEO_MAX_SECONDS + 0.05 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordFrames(frames, fps) {
  if (typeof MediaRecorder === "undefined") {
    throw new SwapError("Ta przeglądarka nie umie zapisać filmu. Zdjęcia działają.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = frames[0].width;
  canvas.height = frames[0].height;
  const ctx = canvas.getContext("2d");
  const mime = ["video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  if (!mime || typeof canvas.captureStream !== "function") {
    throw new SwapError("Ta przeglądarka nie umie zapisać filmu. Zdjęcia działają.");
  }
  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = () => resolve();
  });
  const scratch = document.createElement("canvas");
  scratch.width = canvas.width;
  scratch.height = canvas.height;
  const scratchCtx = scratch.getContext("2d");
  recorder.start();
  for (const frame of frames) {
    scratchCtx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
    ctx.drawImage(scratch, 0, 0);
    await wait(1000 / fps);
  }
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  const ext = mime.includes("mp4") ? "mp4" : "webm";
  return { blob: new Blob(chunks, { type: mime }), ext };
}

async function runVideo() {
  setStatus("Czytam film…", 0.05);
  const { frames, fps, capped } = await readVideoFrames(state.targetFile);
  const swappedOutcomes = await withModels(state.sourceImage, frames, (index, total) => {
    setStatus("Podmieniam klatkę " + (index + 1) + " / " + total + "…", (index + 1) / total);
  });
  const swapped = swappedOutcomes.map((outcome) => outcome.image);
  setStatus("Składam film…", 1);
  const recorded = await recordFrames(swapped, fps);
  const url = URL.createObjectURL(recorded.blob);
  els.resultVideo.poster = imageToCanvas(swapped[0]).toDataURL("image/jpeg", 0.82);
  els.resultVideo.src = url;
  els.resultVideo.hidden = false;
  els.resultImage.hidden = true;
  els.resultCard.hidden = false;
  els.resultCard.dataset.state = "done";
  els.resultLabel.textContent = "Film";
  els.resultNote.textContent = capped
    ? "Wziąłem tylko pierwsze 4 sekundy. Film jest niemy i w niskiej rozdzielczości."
    : "Film jest niemy i w niskiej rozdzielczości. To wersja próbna.";
  state.resultBlob = recorded.blob;
  state.resultName = "podmianka." + recorded.ext;
}

async function runText() {
  if (!state.sourceImage) throw new SwapError("Najpierw wybierz zdjęcie swojej twarzy.");
  const prompt = els.prompt.value.trim();
  if (prompt.length < 3) throw new SwapError("Napisz krótko, co ma być na obrazie.");
  setStatus("Tworzę obraz z opisu…", 0.2);
  const full = prompt + PROMPT_SUFFIX;
  const url = new URL("https://image.pollinations.ai/prompt/" + encodeURIComponent(full));
  url.searchParams.set("width", "768");
  url.searchParams.set("height", "768");
  url.searchParams.set("nologo", "true");
  url.searchParams.set("safe", "true");
  url.searchParams.set("seed", String(Math.floor(Math.random() * 1e9)));
  let response;
  try {
    response = await fetch(url, { signal: state.abort.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new SwapError("Nie udało się stworzyć obrazu. Spróbuj inny opis albo za chwilę.");
  }
  if (response.status === 402 || response.status === 429) {
    throw new SwapError("Za dużo próśb naraz. Odczekaj chwilę i spróbuj jeszcze raz.");
  }
  const type = response.headers.get("content-type") || "";
  if (!response.ok || !type.includes("image")) {
    throw new SwapError("Nie udało się stworzyć obrazu. Spróbuj inny opis albo za chwilę.");
  }
  const blob = await response.blob();
  const generated = await fileToImage(blob, PHOTO_MAX);
  try {
    const [outcome] = await withModels(state.sourceImage, [generated], () => {
      setStatus("Wstawiam Twoją twarz w wygenerowany obraz…", 0.85);
    });
    await showImageResult(outcome.image, "Obraz z opisu, z Twoją twarzą. Jeśli twarz jest dziwna, dopisz że osoba stoi przodem.");
  } catch (error) {
    if (error instanceof SwapError) {
      await showImageResult(generated, "Nie udało się podmienić twarzy. Zostawiam sam wygenerowany obraz.");
    }
    throw error;
  }
}

async function saveResult() {
  if (!state.resultBlob) return;
  const file = new File([state.resultBlob], state.resultName, { type: state.resultBlob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Podmianka" });
      return;
    } catch (error) {
      if (error && error.name === "AbortError") return;
    }
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(state.resultBlob);
  link.download = state.resultName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

async function start(task) {
  if (state.busy) return;
  setError("");
  els.resultCard.hidden = true;
  els.resultCard.dataset.state = "";
  state.abort = new AbortController();
  setBusy(true);
  try {
    await task();
  } catch (error) {
    if (error?.name === "AbortError") {
      setError("Anulowane.");
    } else if (error instanceof SwapError) {
      setError(error.message);
    } else {
      console.error(error);
      const memory = /memory|allocation|oom|out of/i.test(String(error && error.message));
      setError(
        memory
          ? "Za mało pamięci w tej karcie. Zamknij inne karty Safari i spróbuj jeszcze raz."
          : "Coś poszło nie tak. Spróbuj inne zdjęcie albo odśwież stronę.",
      );
    }
  } finally {
    setBusy(false);
  }
}

els.tabPhoto.addEventListener("click", () => showTab("photo"));
els.tabText.addEventListener("click", () => showTab("text"));
els.pickSource.addEventListener("click", () => els.fileSource.click());
els.pickTarget.addEventListener("click", () => els.fileTarget.click());

els.fileSource.addEventListener("change", async () => {
  const file = els.fileSource.files && els.fileSource.files[0];
  els.fileSource.value = "";
  if (!file) return;
  setError("");
  try {
    state.sourceFile = file;
    state.sourceImage = await fileToImage(file, PHOTO_MAX);
    els.previewSource.src = URL.createObjectURL(file);
    els.previewSource.hidden = false;
    els.pickSource.textContent = "Zmień zdjęcie twarzy";
  } catch (error) {
    setError(error instanceof SwapError ? error.message : "Nie umiem odczytać tego zdjęcia.");
  }
});

els.fileTarget.addEventListener("change", async () => {
  const file = els.fileTarget.files && els.fileTarget.files[0];
  els.fileTarget.value = "";
  if (!file) return;
  setError("");
  state.targetFile = file;
  const video = file.type.startsWith("video");
  state.targetKind = video ? "video" : "image";
  els.targetName.hidden = false;
  els.targetName.textContent = video ? "Film: " + file.name : file.name;
  els.pickTarget.textContent = video ? "Zmień film" : "Zmień zdjęcie";
  if (video) {
    state.targetImage = null;
    els.previewTarget.hidden = true;
    return;
  }
  try {
    state.targetImage = await fileToImage(file, PHOTO_MAX);
    els.previewTarget.src = URL.createObjectURL(file);
    els.previewTarget.hidden = false;
  } catch (error) {
    setError(error instanceof SwapError ? error.message : "Nie umiem odczytać tego zdjęcia.");
  }
});

els.btnSwap.addEventListener("click", () => start(runPhoto));
els.btnCreate.addEventListener("click", () => start(runText));
els.btnCancel.addEventListener("click", () => state.abort && state.abort.abort());
els.btnSave.addEventListener("click", () => saveResult());

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
