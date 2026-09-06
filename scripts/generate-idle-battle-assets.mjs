import { createFalClient } from "@fal-ai/client";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = join(PROJECT_ROOT, "assets", "video");
const FIRST_FRAME_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander-first-frame.png");
const VIDEO_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander.mp4");
const PROVENANCE_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander.provenance.json");
const IMAGE_MODEL = "fal-ai/qwen-image-edit-2511";
const VIDEO_MODEL = "minimax/h3-max-turbo/image-to-video";

const IMAGE_PROMPT = [
  "Edit this battle-game screenshot into a clean production first frame for a looping idle animation.",
  "Preserve the exact two Pokémon identities, colors, silhouettes, proportions, scale, screen direction, and positions: Pikachu is seen from behind in the lower-left foreground, facing Charmander from the front in the middle-right distance.",
  "Preserve the circular grassy clearing, distant rounded hills, shrubs, flowers, blue sky, readable depth, and the same camera viewpoint.",
  "Redraw the entire scene as a polished hand-drawn 2D Japanese television animation frame with clean expressive line art, controlled cel shading, softly painted natural scenery, warm daylight, and restrained cinematic color.",
  "Both Pokémon are calm in neutral idle battle stances. No attack, impact, energy, particles, or dramatic action.",
  "Remove every interface overlay and reconstruct the scenery beneath it: remove the upper-left status panel, lower-right status panel, all names, HP bars, numbers, badges, borders, shadows, icons, and the upper-right 3D LIVE badge.",
  "Keep the upper-left and lower-right scenery visually calm so live HTML status panels remain readable when overlaid.",
  "No text, typography, logos, watermark, screen border, extra creatures, or trainers. Output a clean 16:9 frame.",
].join(" ");

const VIDEO_PROMPT = [
  "A seamless five-second looping idle shot in polished hand-drawn 2D creature-battle television animation.",
  "Locked camera and unchanged composition. Pikachu and Charmander remain in their exact positions and neutral battle stances, facing each other without attacking.",
  "Use only subtle cyclic idle motion: gentle breathing, one small natural ear movement from Pikachu, a soft repeating sway of Charmander's tail flame, slight grass and flower movement, and barely drifting background air.",
  "Preserve character identity, anatomy, scale, colors, linework, scenery, lighting, and spatial continuity perfectly.",
  "The final frame must return exactly to the supplied first frame for a clean loop.",
  "No camera movement, cuts, zoom, dialogue, attack, impact, particles, new objects, text, UI, morphing, costume change, or position drift.",
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

async function runQueued(client, model, input, label) {
  const queued = await client.queue.submit(model, {
    input,
    storageSettings: { expiresIn: "1h" },
  });
  console.log(`${label} submitted: ${queued.request_id}`);
  await client.queue.subscribeToStatus(model, {
    requestId: queued.request_id,
    mode: "polling",
    pollInterval: 1500,
    logs: false,
    timeout: 12 * 60 * 1000,
  });
  return {
    requestId: queued.request_id,
    result: await client.queue.result(model, { requestId: queued.request_id }),
  };
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载生成素材失败：HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

const sourceArgument = process.argv[2];
if (!sourceArgument) throw new Error("请传入战斗截图路径");
const sourcePath = resolve(sourceArgument);
const sourceBytes = await readFile(sourcePath);
const credentials = await loadFalKey();
const client = createFalClient({ credentials });

await mkdir(OUTPUT_DIR, { recursive: true });
const uploadedSource = await client.storage.upload(new Blob([sourceBytes], { type: "image/png" }), {
  lifecycle: { expiresIn: "1h" },
});

const imageRun = await runQueued(client, IMAGE_MODEL, {
  prompt: IMAGE_PROMPT,
  negative_prompt: "text, UI, HUD, status panel, health bar, logo, watermark, extra creature, attack effect",
  image_urls: [uploadedSource],
  image_size: "landscape_16_9",
  num_inference_steps: 28,
  guidance_scale: 4.5,
  num_images: 1,
  enable_safety_checker: true,
  output_format: "png",
  acceleration: "regular",
}, "first-frame");
const firstFrameUrl = imageRun.result.data?.images?.[0]?.url;
if (!firstFrameUrl) throw new Error("fal 未返回首帧图片");
await download(firstFrameUrl, FIRST_FRAME_PATH);

const videoRun = await runQueued(client, VIDEO_MODEL, {
  prompt: VIDEO_PROMPT,
  duration: 5,
  resolution: "768P",
  enable_safety_checker: true,
  prompt_expansion_mode: "balanced",
  image_url: firstFrameUrl,
  end_image_url: firstFrameUrl,
}, "idle-video");
const videoUrl = videoRun.result.data?.video?.url;
if (!videoUrl) throw new Error("fal 未返回待机视频");
await download(videoUrl, VIDEO_PATH);

await writeFile(PROVENANCE_PATH, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: {
    fileName: basename(sourcePath),
    note: "User-provided local battle screenshot; uploaded transiently to fal for the requested edit.",
  },
  firstFrame: {
    model: IMAGE_MODEL,
    requestId: imageRun.requestId,
    prompt: IMAGE_PROMPT,
    output: basename(FIRST_FRAME_PATH),
  },
  video: {
    model: VIDEO_MODEL,
    requestId: videoRun.requestId,
    prompt: VIDEO_PROMPT,
    durationSeconds: 5,
    resolution: "768P",
    startAndEndFrame: basename(FIRST_FRAME_PATH),
    output: basename(VIDEO_PATH),
  },
}, null, 2)}\n`);

console.log(`first frame: ${FIRST_FRAME_PATH}`);
console.log(`idle video: ${VIDEO_PATH}`);
console.log(`provenance: ${PROVENANCE_PATH}`);
