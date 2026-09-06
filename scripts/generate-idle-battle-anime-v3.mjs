import { createFalClient } from "@fal-ai/client";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = join(PROJECT_ROOT, "assets", "video");
const SOURCE_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander-pixel-v1-source.png");
const FIRST_FRAME_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander-anime-v3-first-frame.png");
const VIDEO_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander-anime-v3.mp4");
const PROVENANCE_PATH = join(OUTPUT_DIR, "idle-battle-pikachu-charmander-anime-v3.provenance.json");
const IMAGE_MODEL = "fal-ai/nano-banana-pro/edit";
const VIDEO_MODEL = "minimax/h3-max-turbo/image-to-video";

const IMAGE_PROMPT = [
  "Redraw this exact UI-free pixel battle scene as a polished Pokémon television anime frame.",
  "Preserve the recognizable Pikachu back view in the lower-left foreground, Charmander front view in the upper-right distance, their scale relationship, facing directions, grassy arena, sky, clouds, camera height, and all screen positions.",
  "Use unmistakable flat hand-drawn 2D cel animation: clean dark ink contours, faithful canonical species anatomy and colors, simplified expressive shapes, flat local color, two or three hard-edged cel-shadow tones, restrained highlights, and a softly painted television-anime grassland background.",
  "Both Pokémon remain calm in neutral idle battle stances. Keep the upper-left and lower-right regions visually calm because live HTML status panels will be overlaid there.",
  "Remove the pixel grid and low-resolution artifacts in the final redraw. No interface, health bars, text, logo, watermark, trainers, extra creatures, attack, particles, split screen, 3D, CGI, glossy plastic, clay, photorealism, volumetric light, depth-of-field blur, or soft 3D gradient shading.",
  "Output one clean 16:9 production frame.",
].join(" ");

const VIDEO_PROMPT = [
  "A seamless five-second idle loop in authentic hand-drawn 2D Pokémon television animation.",
  "Keep the exact supplied composition, clean ink outlines, flat colors, hard-edged cel shadows, painted grassy background, character identities, anatomy, scale, facing, and positions. Lock the camera.",
  "Pikachu and Charmander continue facing each other in calm neutral battle stances without attacking.",
  "Animate only subtle repeating limited-animation motion: gentle breathing, one small Pikachu ear movement, a soft cyclic Charmander tail-flame flicker, and barely perceptible grass and cloud drift.",
  "Keep drawings stable and return the final frame exactly to the supplied first frame for a clean loop.",
  "No camera movement, cuts, zoom, attack, impact, energy, dialogue, new objects, text, UI, logo, pixel-art regression, morphing, anatomy change, position drift, CGI, plastic surfaces, volumetric lighting, or 3D shading.",
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

async function uploadPng(client, path) {
  const bytes = await readFile(path);
  return client.storage.upload(new Blob([bytes], { type: "image/png" }), {
    lifecycle: { expiresIn: "1h" },
  });
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
  throw new Error("用法：node scripts/generate-idle-battle-anime-v3.mjs [first-frame|video]");
}

const client = createFalClient({ credentials: await loadFalKey() });

if (command === "first-frame") {
  const sourceUrl = await uploadPng(client, SOURCE_PATH);
  const imageRun = await runQueued(client, IMAGE_MODEL, {
    prompt: IMAGE_PROMPT,
    image_urls: [sourceUrl],
    num_images: 1,
    aspect_ratio: "16:9",
    output_format: "png",
    safety_tolerance: "4",
    resolution: "2K",
    limit_generations: true,
    enable_web_search: false,
  }, "anime-v3-first-frame");
  const imageUrl = imageRun.result.data?.images?.[0]?.url;
  if (!imageUrl) throw new Error("fal 未返回动画风格首帧");
  await download(imageUrl, FIRST_FRAME_PATH);
  await writeFile(PROVENANCE_PATH, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: {
      fileName: basename(SOURCE_PATH),
      note: "UI-free source captured from the current local pixel-2D battle stage.",
    },
    firstFrame: {
      model: IMAGE_MODEL,
      requestId: imageRun.requestId,
      elapsedMs: imageRun.elapsedMs,
      prompt: IMAGE_PROMPT,
      output: basename(FIRST_FRAME_PATH),
    },
  }, null, 2)}\n`);
  console.log(`anime v3 first frame: ${FIRST_FRAME_PATH}`);
  console.log(`elapsed: ${(imageRun.elapsedMs / 1000).toFixed(1)}s`);
}

if (command === "video") {
  const imageUrl = await uploadPng(client, FIRST_FRAME_PATH);
  const videoRun = await runQueued(client, VIDEO_MODEL, {
    prompt: VIDEO_PROMPT,
    duration: 5,
    resolution: "768P",
    enable_safety_checker: true,
    prompt_expansion_mode: "balanced",
    image_url: imageUrl,
    end_image_url: imageUrl,
  }, "anime-v3-idle-video");
  const videoUrl = videoRun.result.data?.video?.url;
  if (!videoUrl) throw new Error("fal 未返回动画风格待机视频");
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
  console.log(`anime v3 idle video: ${VIDEO_PATH}`);
  console.log(`elapsed: ${(videoRun.elapsedMs / 1000).toFixed(1)}s`);
}
