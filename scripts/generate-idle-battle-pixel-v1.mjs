import { createFalClient } from "@fal-ai/client";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = join(PROJECT_ROOT, "assets", "video");
const SOURCE_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander-pixel-v1-source.png");
const VIDEO_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander-pixel-v1.mp4");
const PROVENANCE_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander-pixel-v1.provenance.json");
const VIDEO_MODEL = "minimax/h3-max-turbo/image-to-video";

const VIDEO_PROMPT = [
  "Create a seamless five-second looping idle animation from this exact retro pixel-art creature battle screen.",
  "Preserve the exact integer pixel grid, nearest-neighbor hard edges, limited color palette, sprite scale, battle-field layout, camera, lighting, and the recognizable Pikachu back sprite and Charmander front sprite.",
  "Animate as authentic limited-frame pixel sprite animation: tiny two-frame breathing bobs, one restrained Pikachu ear twitch, and a small repeating Charmander tail-flame flicker. The grass field and sky remain almost still.",
  "Both creatures stay in their starting positions and face each other without attacking. The final frame must return exactly to the supplied first frame.",
  "No camera movement, cut, zoom, attack, impact, particles, new objects, text, user interface, health bars, logo, morphing, anatomy change, position drift, antialiasing, subpixel blur, vector smoothing, hand-painted illustration, CGI, 3D, plastic shading, or photorealism.",
].join(" ");

function parseEnvValue(contents, key) {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] !== key) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return "";
}

async function loadFalKey() {
  if (process.env.FAL_KEY) return process.env.FAL_KEY;
  for (const file of [join(PROJECT_ROOT, ".env.local"), join(PROJECT_ROOT, ".env")]) {
    try {
      const key = parseEnvValue(await readFile(file, "utf8"), "FAL_KEY");
      if (key) return key;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("未配置 FAL_KEY");
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载生成素材失败：HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

const sourceBytes = await readFile(SOURCE_PATH);
const client = createFalClient({ credentials: await loadFalKey() });
const sourceUrl = await client.storage.upload(new Blob([sourceBytes], { type: "image/png" }), {
  lifecycle: { expiresIn: "1h" },
});

const startedAt = Date.now();
const queued = await client.queue.submit(VIDEO_MODEL, {
  input: {
    prompt: VIDEO_PROMPT,
    duration: 5,
    resolution: "768P",
    enable_safety_checker: true,
    prompt_expansion_mode: "balanced",
    image_url: sourceUrl,
    end_image_url: sourceUrl,
  },
  storageSettings: { expiresIn: "1h" },
});
console.log(`pixel-idle-video submitted: ${queued.request_id}`);
await client.queue.subscribeToStatus(VIDEO_MODEL, {
  requestId: queued.request_id,
  mode: "polling",
  pollInterval: 1500,
  logs: false,
  timeout: 12 * 60 * 1000,
});
const result = await client.queue.result(VIDEO_MODEL, { requestId: queued.request_id });
const elapsedMs = Date.now() - startedAt;
const videoUrl = result.data?.video?.url;
if (!videoUrl) throw new Error("fal 未返回像素待机视频");
await download(videoUrl, VIDEO_PATH);

await writeFile(PROVENANCE_PATH, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: {
    fileName: basename(SOURCE_PATH),
    note: "Clean UI-free screenshot captured from the local pixel-2D battle stage.",
  },
  video: {
    model: VIDEO_MODEL,
    requestId: queued.request_id,
    elapsedMs,
    prompt: VIDEO_PROMPT,
    durationSeconds: 5,
    resolution: "768P",
    startAndEndFrame: basename(SOURCE_PATH),
    output: basename(VIDEO_PATH),
  },
}, null, 2)}\n`);

console.log(`pixel idle video: ${VIDEO_PATH}`);
console.log(`elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
