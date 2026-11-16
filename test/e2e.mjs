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
page.setDefaultTimeout(240000);
page.on("pageerror", (error) => console.log("PAGEERROR", error.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("PAGE", msg.text());
});

await page.goto("http://127.0.0.1:8765/", { waitUntil: "domcontentloaded" });
await page.setInputFiles("#file-source", "test/fixtures/source.jpg");
await page.setInputFiles("#file-target", "test/fixtures/target.jpg");
await page.waitForSelector("#preview-source:not([hidden])");
await page.waitForSelector("#preview-target:not([hidden])");
await page.screenshot({ path: artifacts + "/before.png", fullPage: true });

await page.click("#btn-swap");
await page.waitForFunction(() => {
  const status = document.querySelector("#status");
  return status && (status.textContent || "").length > 0;
});
await page.screenshot({ path: artifacts + "/progress.png", fullPage: true });
await page.waitForSelector('#result-card[data-state="done"]', { timeout: 240000 });
const errorHidden = await page.locator("#error").isHidden();
if (!errorHidden) throw new Error(await page.locator("#error").textContent());
await page.screenshot({ path: artifacts + "/after.png", fullPage: true });
await page.locator("#result-image").screenshot({ path: artifacts + "/result.png" });
const note = await page.locator("#result-note").textContent();
console.log("e2e ok", note);
await browser.close();
