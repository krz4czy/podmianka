import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const artifacts = "/opt/cursor/artifacts";
mkdirSync(artifacts, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
page.setDefaultTimeout(180000);
page.on("console", (msg) => console.log("PAGE", msg.type(), msg.text()));
page.on("pageerror", (err) => console.log("PAGEERROR", err.message));

const base = process.env.MODEL_BASE || ".model-cache/";
await page.goto("http://127.0.0.1:8765/?engine=wasm&modelBase=" + encodeURIComponent(base), {
  waitUntil: "domcontentloaded",
});
await page.setInputFiles("#file-source", "test/fixtures/source.jpg");
await page.setInputFiles("#file-target", "test/fixtures/target.jpg");
await page.waitForSelector("#preview-source:not([hidden])");
await page.waitForSelector("#preview-target:not([hidden])");
await page.screenshot({ path: artifacts + "/before.png", fullPage: true });

await page.click("#btn-swap");
await page.waitForFunction(() => {
  const status = document.querySelector("#status");
  return status && /Pobieram|Mam już/.test(status.textContent || "");
});
await page.screenshot({ path: artifacts + "/downloading.png", fullPage: true });
await page.waitForSelector('#result-card[data-state="done"]', { timeout: 180000 });
const error = await page.locator("#error").textContent();
if (error && error.trim() && !(await page.locator("#error").isHidden())) {
  throw new Error("page error: " + error);
}
await page.screenshot({ path: artifacts + "/after.png", fullPage: true });
await page.locator("#result-image").screenshot({ path: artifacts + "/result.png" });
const videoHidden = await page.locator("#result-video").isHidden();
if (!videoHidden) throw new Error("video element should stay hidden for a photo");

await page.click("#tab-text");
await page.waitForSelector("#prompt");
const checks = await page.evaluate(async () => {
  const scrfd = await fetch("https://huggingface.co/facefusion/models-3.0.0/resolve/main/scrfd_2.5g.onnx");
  const scrfdBytes = (await scrfd.arrayBuffer()).byteLength;
  const swap = await fetch("https://huggingface.co/facefusion/models-3.0.0/resolve/main/inswapper_128_fp16.onnx", {
    headers: { Range: "bytes=0-15" },
  });
  const arc = await fetch("https://huggingface.co/facefusion/models-3.0.0/resolve/main/arcface_w600k_r50.onnx", {
    headers: { Range: "bytes=0-15" },
  });
  const image = await fetch(
    "https://image.pollinations.ai/prompt/portrait%20photo%20of%20one%20person%20clear%20frontal%20face?width=256&height=256&seed=11&nologo=true&safe=true",
  );
  return {
    scrfdStatus: scrfd.status,
    scrfdBytes,
    swapStatus: swap.status,
    swapRange: swap.headers.get("content-range"),
    arcStatus: arc.status,
    imageStatus: image.status,
    imageType: image.headers.get("content-type"),
  };
});
console.log("remote checks", checks);
if (checks.scrfdStatus !== 200 || checks.scrfdBytes < 3_000_000) throw new Error("scrfd download failed");
if (![200, 206].includes(checks.swapStatus) || ![200, 206].includes(checks.arcStatus)) {
  throw new Error("model range failed");
}
if (checks.imageStatus !== 200 || !String(checks.imageType).includes("image")) {
  throw new Error("pollinations failed " + checks.imageStatus);
}
console.log("e2e ok");
await browser.close();
