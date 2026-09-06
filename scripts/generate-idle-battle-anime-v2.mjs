import { createFalClient } from "@fal-ai/client";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = join(PROJECT_ROOT, "assets", "video");
const SOURCE_FRAME_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander-first-frame.png");
const FIRST_FRAME_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander-anime-v2-first-frame.png");
const VIDEO_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander-anime-v2.mp4");
const PROVENANCE_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander-anime-v2.provenance.json");
const IMAGE_MODEL = "fal-ai/nano-banana-pro/edit";
const VIDEO_MODEL = "minimax/h3-max-turbo/image-to-video";

const IMAGE_PROMPT = [
  "Transform the supplied clean battle frame into an authentic Pokémon television anime battle frame.",
  "This must be unmistakably flat hand-drawn 2D cel animation, never a softened 3D render.",
  "Use crisp dark anime ink outlines, simplified expressive shapes, flat local colors, two or three hard-edged cel-shadow tones, small hand-painted highlights, and a painted television-anime background.",
  "Preserve the two exact species and their recognizable anatomy, colors, markings, silhouettes, proportions, scale, screen direction, and positions: Pikachu is viewed from behind in the lower-left foreground, facing Charmander from the front in the middle-right distance.",
  "Keep both characters calm in neutral idle battle stances. Preserve the circular grassy clearing, distant hills, shrubs, flowers, blue sky, camera height, depth, and overall composition.",
  "Keep the upper-left and lower-right scenery visually calm because live HTML status panels will be overlaid there.",
  "No 3D, CGI, game-engine render, plastic, clay, glossy toy surface, photorealism, volumetric light, depth-of-field blur, soft 3D gradient shading, attack, particles, extra creatures, trainers, text, UI, logo, watermark, or border.",
  "Output one clean 16:9 production frame with no interface elements.",
].join(" ");

const VIDEO_PROMPT = [
  "A seamless five-second idle loop rendered as authentic hand-drawn 2D Pokémon television anime.",
  "Maintain the supplied cel-animated line art, flat colors, hard-edged two-tone cel shadows, painted background, exact character identity, anatomy, scale, positions, and locked camera.",
  "Pikachu and Charmander remain facing each other in neutral battle stances without attacking.",
  "Animate only subtle repeating television-animation idle motion: gentle breathing, one restrained Pikachu ear twitch, Charmander's tail flame softly cycling, slight grass and flower sway, and a faint background breeze.",
  "Use clean limited-animation timing with stable drawings and no interpolation that creates a 3D or morphing appearance.",
  "The final frame must match the supplied first frame so the loop closes cleanly.",
  "No camera movement, cuts, zoom, attack, impact, energy, dialogue, new object, text, UI, logo, anatomy change, position drift, CGI, plastic surface, volumetric lighting, or 3D shading.",
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
  const startedAt = Date.now();
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
    elapsedMs: Date.now() - startedAt,
    result: await client.queue.result(model, { requestId: queued.request_id }),
  };
}

async function uploadPng(client, path) {
  const bytes = await readFile(path);
  return client.storage.upload(new Blob([bytes], { type: "image/png" }), {
    lifecycle: { expiresIn: "1h" },
  });
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载生成素材失败：HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function readProvenance() {
  try {
    return JSON.parse(await readFile(PROVENANCE_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

const command = process.argv[2] ?? "first-frame";
if (!new Set(["first-frame", "video"]).has(command)) {
  throw new Error("用法：node scripts/generate-idle-battle-anime-v2.mjs [first-frame|video]");
}

const credentials = await loadFalKey();
const client = createFalClient({ credentials });
await mkdir(OUTPUT_DIR, { recursive: true });

if (command === "first-frame") {
  const uploadedSource = await uploadPng(client, SOURCE_FRAME_PATH);
  const imageRun = await runQueued(client, IMAGE_MODEL, {
    prompt: IMAGE_PROMPT,
    image_urls: [uploadedSource],
    num_images: 1,
    aspect_ratio: "16:9",
    output_format: "png",
    safety_tolerance: "4",
    resolution: "2K",
    limit_generations: true,
    enable_web_search: false,
  }, "anime-first-frame");
  const firstFrameUrl = imageRun.result.data?.images?.[0]?.url;
  if (!firstFrameUrl) throw new Error("fal 未返回二维动画首帧");
  await download(firstFrameUrl, FIRST_FRAME_PATH);
  await writeFile(PROVENANCE_PATH, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: {
      fileName: basename(SOURCE_FRAME_PATH),
      note: "Previously cleaned UI-free battle frame; uploaded transiently to fal for a 2D cel-animation redraw.",
    },
    firstFrame: {
      model: IMAGE_MODEL,
      requestId: imageRun.requestId,
      elapsedMs: imageRun.elapsedMs,
      prompt: IMAGE_PROMPT,
      output: basename(FIRST_FRAME_PATH),
    },
  }, null, 2)}\n`);
  console.log(`anime first frame: ${FIRST_FRAME_PATH}`);
  console.log(`elapsed: ${(imageRun.elapsedMs / 1000).toFixed(1)}s`);
}

if (command === "video") {
  const uploadedFrame = await uploadPng(client, FIRST_FRAME_PATH);
  const videoRun = await runQueued(client, VIDEO_MODEL, {
    prompt: VIDEO_PROMPT,
    duration: 5,
    resolution: "768P",
    enable_safety_checker: true,
    prompt_expansion_mode: "balanced",
    image_url: uploadedFrame,
    end_image_url: uploadedFrame,
  }, "anime-idle-video");
  const videoUrl = videoRun.result.data?.video?.url;
  if (!videoUrl) throw new Error("fal 未返回二维待机视频");
  await download(videoUrl, VIDEO_PATH);
  const provenance = await readProvenance();
  provenance.video = {
    model: VIDEO_MODEL,
    requestId: videoRun.requestId,
    elapsedMs: videoRun.elapsedMs,
    prompt: VIDEO_PROMPT,
    durationSeconds: 5,
    resolution: "768P",
    startAndEndFrame: basename(FIRST_FRAME_PATH),
    output: basename(VIDEO_PATH),
  };
  await writeFile(PROVENANCE_PATH, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`anime idle video: ${VIDEO_PATH}`);
  console.log(`elapsed: ${(videoRun.elapsedMs / 1000).toFixed(1)}s`);
}
