const PHOTO_MAX = 1024;
const PHOTO_PROMPT =
  "In <image2>, replace the person with the person from <image1>. " +
  "Match the head angle, crop, background and lighting of <image2>. " +
  "The new person has the face, hair, body and clothes from <image1>. " +
  "Do not keep the original clothes or facial hair.";

const SPACES = [
  {
    name: "zen-image-edit",
    base: "https://aiartlab-zen-image-edit-demo.hf.space",
    api: "generate",
    build(source, target, prompt) {
      return [prompt, source, target, null, "", 24, 1, 896, Math.floor(Math.random() * 1e6)];
    },
    buildText(source, prompt) {
      const text =
        "Show the person from <image1> in this scene: " +
        prompt +
        ". Keep their face, hair, body and clothes. One person, photorealistic.";
      return [text, source, null, null, "", 24, 1, 896, Math.floor(Math.random() * 1e6)];
    },
  },
  {
    name: "Qwen-Image-Edit-2509",
    base: "https://qwen-qwen-image-edit-2509.hf.space",
    api: "infer",
    build(source, target, prompt) {
      const text = prompt.replaceAll("<image1>", "image 1").replaceAll("<image2>", "image 2");
      return [[{ image: source, caption: null }, { image: target, caption: null }], text, 0, true, 4, 8, 256, 256, false];
    },
    buildText(source, prompt) {
      const text =
        "Place the person from image 1 in this scene: " +
        prompt +
        ". Keep their face, hair, body and clothes. One person, photorealistic.";
      return [[{ image: source, caption: null }], text, 0, true, 4, 8, 256, 256, false];
    },
  },
];

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
  prompt: document.querySelector("#prompt"),
  btnSwap: document.querySelector("#btn-swap"),
  btnCreate: document.querySelector("#btn-create"),
  btnCancel: document.querySelector("#btn-cancel"),
  btnSave: document.querySelector("#btn-save"),
  statusCard: document.querySelector("#status-card"),
  status: document.querySelector("#status"),
  bar: document.querySelector("#bar"),
  resultCard: document.querySelector("#result-card"),
  resultImage: document.querySelector("#result-image"),
  resultNote: document.querySelector("#result-note"),
  error: document.querySelector("#error"),
};

const state = {
  sourceBlob: null,
  targetBlob: null,
  busy: false,
  abort: null,
  resultBlob: null,
};

function setError(message) {
  els.error.hidden = !message;
  els.error.textContent = message || "";
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

function friendlyError(error) {
  const raw = String(error && error.message ? error.message : error);
  if (error && error.name === "AbortError") return "Anulowane.";
  if (/[ąćęłńóśźż]/i.test(raw)) return raw;
  if (/quota|rate|429|too many|exceeded|limit/i.test(raw)) {
    return "Skończył się darmowy limit karty graficznej na dziś. Spróbuj jutro albo za kilka godzin.";
  }
  if (/queue is full|kolejka/i.test(raw)) return "Kolejka jest pełna. Spróbuj za minutę.";
  if (/duration .*maximum|illegal duration/i.test(raw)) {
    return "Ten model chce za dużo czasu na darmowej karcie. Spróbuj jeszcze raz za chwilę.";
  }
  if (/failed to fetch|network|load/i.test(raw)) {
    return "Nie ma połączenia z modelem. Sprawdź sieć i spróbuj jeszcze raz.";
  }
  if (/worker error|runtimeerror|unavailable|503|502/i.test(raw)) {
    return "Darmowy model jest chwilowo niedostępny. Spróbuj jeszcze raz za chwilę.";
  }
  return "Nie udało się podmienić osoby. Spróbuj inne zdjęcie albo za chwilę.";
}

const previewUrls = { source: "", target: "", result: "" };

function rememberUrl(slot, url) {
  if (previewUrls[slot]) URL.revokeObjectURL(previewUrls[slot]);
  previewUrls[slot] = url;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Nie umiem odczytać tego zdjęcia. Zapisz je jako JPEG."));
    image.src = url;
  });
}

async function fileToJpeg(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const longest = Math.max(image.naturalWidth, image.naturalHeight) || 1;
    const scale = Math.min(1, PHOTO_MAX / longest);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, width, height);
    image.src = "";
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Nie umiem zmniejszyć zdjęcia."))), "image/jpeg", 0.82);
    });
    canvas.width = 1;
    canvas.height = 1;
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadFile(base, blob, name, signal) {
  const body = new FormData();
  body.append("files", blob, name);
  const response = await fetch(base + "/gradio_api/upload", { method: "POST", body, signal });
  if (!response.ok) throw new Error("upload " + response.status);
  const paths = await response.json();
  return {
    path: paths[0],
    orig_name: name,
    mime_type: "image/jpeg",
    meta: { _type: "gradio.FileData" },
  };
}

async function fnIndex(base, api, signal) {
  const response = await fetch(base + "/config", { signal });
  if (!response.ok) throw new Error("config " + response.status);
  const config = await response.json();
  const index = (config.dependencies || []).findIndex((item) => item.api_name === api);
  if (index < 0) throw new Error("Brak endpointu " + api);
  return index;
}

function describe(message) {
  if (message.msg === "estimation") {
    const rank = Number(message.rank || 0) + 1;
    const size = message.queue_size || rank;
    return { text: "Kolejka: miejsce " + rank + " z " + size + ".", ratio: 0.08 };
  }
  if (message.msg === "process_starts") return { text: "Zaczynam na darmowej karcie…", ratio: 0.15 };
  if (message.msg === "log") {
    const log = message.log || "";
    if (/wait|queue|gpu/i.test(log)) return { text: "Czekam na wolną kartę graficzną…", ratio: 0.2 };
    return { text: log, ratio: null };
  }
  if (message.msg === "progress") {
    const item = (message.progress_data || [])[0];
    if (!item) return null;
    const desc = item.desc || "";
    const ratio = item.length ? item.index / item.length : null;
    if (/zerogpu init/i.test(desc)) return { text: "Wstaje model…", ratio: 0.25 + (ratio || 0) * 0.2 };
    if (item.length) return { text: "Rysuję, krok " + (item.index + 1) + " z " + item.length + "…", ratio: 0.45 + (ratio || 0) * 0.5 };
    return { text: desc || "Pracuję…", ratio };
  }
  return null;
}

async function readResult(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;
  while (!completed) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop();
    for (const part of parts) {
      const dataLine = part.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const message = JSON.parse(dataLine.slice(5).trim());
      const status = describe(message);
      if (status) setStatus(status.text, status.ratio);
      if (message.msg === "process_completed") completed = message;
    }
  }
  if (!completed) throw new Error("Połączenie z modelem urwało się w trakcie.");
  if (completed.success === false || (completed.output && completed.output.error)) {
    throw new Error(completed.output && completed.output.error ? completed.output.error : completed.title || "error");
  }
  return completed.output.data;
}

function imageUrlFrom(data, base) {
  const found = [];
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.url === "string") found.push(value.url);
    if (typeof value.path === "string" && /\.(png|jpe?g|webp)$/i.test(value.path)) {
      found.push(base + "/gradio_api/file=" + value.path);
    }
    if (Array.isArray(value)) value.forEach(walk);
    else Object.values(value).forEach(walk);
  };
  walk(data);
  if (!found.length) throw new Error("Model nie oddał obrazu.");
  return found[0];
}

async function callSpace(space, source, target, prompt, signal) {
  setStatus("Łączę z modelem " + space.name + "…", 0.04);
  const index = await fnIndex(space.base, space.api, signal);
  const sourceFile = await uploadFile(space.base, source, "source.jpg", signal);
  const targetFile = target ? await uploadFile(space.base, target, "target.jpg", signal) : null;
  const data = target ? space.build(sourceFile, targetFile, prompt) : space.buildText(sourceFile, prompt);
  const session = crypto.randomUUID();
  const joined = await fetch(space.base + "/gradio_api/queue/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data, fn_index: index, session_hash: session }),
    signal,
  });
  if (!joined.ok) throw new Error("queue " + joined.status);
  const stream = await fetch(space.base + "/gradio_api/queue/data?session_hash=" + encodeURIComponent(session), { signal });
  if (!stream.ok) throw new Error("stream " + stream.status);
  const output = await readResult(stream);
  const url = imageUrlFrom(output, space.base);
  const image = await fetch(url, { signal });
  if (!image.ok) throw new Error("result " + image.status);
  return image.blob();
}

async function generate(source, target, prompt) {
  let lastError = null;
  for (const space of SPACES) {
    try {
      const blob = await callSpace(space, source, target, prompt, state.abort.signal);
      return { blob, space: space.name };
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      lastError = error;
      setStatus("Model " + space.name + " nie doszedł. Próbuję zapasowy…", 0.1);
    }
  }
  throw lastError || new Error("unavailable");
}

async function blobToJpeg(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0);
    image.src = "";
    const jpeg = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Nie umiem zapisać wyniku."))), "image/jpeg", 0.86);
    });
    canvas.width = 1;
    canvas.height = 1;
    return jpeg;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function showResult(blob, note) {
  const jpeg = blob.type === "image/jpeg" ? blob : await blobToJpeg(blob);
  state.resultBlob = jpeg;
  const url = URL.createObjectURL(jpeg);
  rememberUrl("result", url);
  els.resultImage.src = url;
  els.resultImage.hidden = false;
  els.resultCard.hidden = false;
  els.resultCard.dataset.state = "done";
  els.resultNote.textContent = note;
}

async function saveResult() {
  if (!state.resultBlob) return;
  const file = new File([state.resultBlob], "podmianka.jpg", { type: "image/jpeg" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Podmianka" });
      return;
    } catch (error) {
      if (error && error.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(state.resultBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "podmianka.jpg";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
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
    setError(friendlyError(error));
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
  try {
    state.sourceBlob = await fileToJpeg(file);
    const url = URL.createObjectURL(state.sourceBlob);
    rememberUrl("source", url);
    els.previewSource.src = url;
    els.previewSource.hidden = false;
    els.pickSource.textContent = "Zmień swoje zdjęcie";
    setError("");
  } catch (error) {
    setError(friendlyError(error));
  }
});

els.fileTarget.addEventListener("change", async () => {
  const file = els.fileTarget.files && els.fileTarget.files[0];
  els.fileTarget.value = "";
  if (!file) return;
  try {
    state.targetBlob = await fileToJpeg(file);
    const url = URL.createObjectURL(state.targetBlob);
    rememberUrl("target", url);
    els.previewTarget.src = url;
    els.previewTarget.hidden = false;
    els.pickTarget.textContent = "Zmień zdjęcie";
    setError("");
  } catch (error) {
    setError(friendlyError(error));
  }
});

els.btnSwap.addEventListener("click", () =>
  start(async () => {
    if (!state.sourceBlob) throw new Error("Najpierw wybierz swoje zdjęcie.");
    if (!state.targetBlob) throw new Error("Wybierz zdjęcie, na które Cię wstawiamy.");
    const result = await generate(state.sourceBlob, state.targetBlob, PHOTO_PROMPT);
    await showResult(result.blob, "Wynik z modelu " + result.space + ". Pora, tło i światło mają zostać z drugiego zdjęcia, a wygląd z Twojego.");
  }),
);

els.btnCreate.addEventListener("click", () =>
  start(async () => {
    if (!state.sourceBlob) throw new Error("Najpierw wybierz swoje zdjęcie.");
    const prompt = els.prompt.value.trim();
    if (prompt.length < 3) throw new Error("Napisz krótko, gdzie masz się znaleźć.");
    const result = await generate(state.sourceBlob, null, prompt);
    await showResult(result.blob, "Scena z opisu, z osobą z Twojego zdjęcia. Model: " + result.space + ".");
  }),
);

els.btnCancel.addEventListener("click", () => state.abort && state.abort.abort());
els.btnSave.addEventListener("click", () => saveResult());

if ("serviceWorker" in navigator && location.hostname.endsWith("github.io")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
