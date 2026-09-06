// Paid, reusable scene assets. A saved request is resumed, never resubmitted.
import { createFalClient } from "@fal-ai/client";
import { readFile, writeFile, access } from "node:fs/promises";
import { extractVideoTailFrame } from "../src/video-tail-frame.js";
import { FAL_VIDEO_SEED } from "../src/fal-video-runway.js";
import { spawn } from "node:child_process";

const root = new URL("../", import.meta.url);
const base = new URL("assets/video/", root);
const mode = process.argv[2];
if (!["idle", "bridge"].includes(mode)) throw new Error("Usage: node scripts/generate-pine-battle-videos.mjs idle|bridge");
process.loadEnvFile(new URL(".env.local", root));
if (!process.env.FAL_KEY) throw new Error("FAL_KEY is not configured");
const client = createFalClient({ credentials: process.env.FAL_KEY });
const prefix = mode === "idle" ? "pine-idle-v2" : "pine-command-v2";
const model = mode === "idle" ? "minimax/h3-max/reference-to-video" : "minimax/h3-max-turbo/image-to-video";
const references = mode === "idle"
  ? ["assets/backgrounds/pine-clearing-v2.png", "assets/video/idle-battle-pikachu-charmander-anime-v3-first-frame.png"]
  : ["assets/video/pine-idle-v2-loop-first-frame.png"];
const prompt = mode === "idle" ? [
  "A five-second seamless calm idle animation for a 2D hand-drawn Pokemon battle, one locked low eye-level wide shot, 16:9.",
  "Image 1 is the exact environment and low camera reference: bright level grass, low grass-capped ochre rock ledges, a layered pine slightly left of center, other pines behind, rounded deciduous tree at right, blue sky. Preserve this layout and its softly painted 2D foliage; no empty rolling-hill replacement or overhead angle.",
  "Image 2 identifies the ONLY two characters and their established clean 2D cel-animation designs; do not use its old hill background. Pikachu stands in rear three-quarter view in the lower-left foreground facing the distant Charmander; keep the yellow body, black-tipped long ears, two brown back stripes, red cheek and lightning-shaped tail. Charmander is a smaller ORANGE bipedal earless lizard in right middle distance facing left, cream belly, smooth orange tail with a flame. Never exchange their features.",
  "CRITICAL GROUND CONTACT: both creatures stand on the SAME FLAT GRASS FLOOR in front of every tree and rock ledge. Charmander is NOT flying or jumping and NOT on a tree, bush or ledge. Its two soles visibly press into the open grass, with a dark oval contact shadow attached directly beneath the soles. Put Charmander LOWER in the image than in Image 2: feet at 73% of frame height, well below the 56% high tree-line; head around 47%. Leave visible clear grass between its shadow and the distant trees. Pikachu is MUCH larger in the foreground, feet at 93% height, ears at 35% height. Its contact shadow touches its feet. Do not copy the character positions of Image 2. Keep Pikachu left and Charmander at 70% width, a large clear diagonal battle floor between them. No graphic panels.",
  "Only tiny cyclic breathing, a restrained ear twitch, soft tail-flame flicker and slight grass movement. No steps, turning around, attacks, injuries, energy, moving camera, zooms or cuts. Finish in exactly the initial poses, drawing scale, background and framing for looping.",
  "Faithful flat cel colors, clean dark ink, two-tone shadows, hand-painted backdrop, bright outdoor daylight. No 3D, CGI, pixel grid, plastic, morphing, additional creatures, people, text, UI, logos or watermark. Quiet outdoor ambience, no music or speech.",
].join(" ") : [
  "A five-second neutral command-and-reaction shot in this exact hand-drawn 2D pine-clearing battle scene.",
  "Start on the supplied wide frame. At 0.4 seconds cut to a lively three-quarter close-up of Pikachu listening: ears perk once, eyes focus, one subtle ready crouch. At 2.4 seconds cut back to the original low wide shot. From 3.3 seconds hold both original neutral ready poses with tiny breathing; finish exactly on the supplied end frame.",
  "The shot only anticipates the next command. No electricity, attack, projectile, approach, impact, injury, damage, fainting or victory. Charmander remains orange, distinct, watchful and unharmed. Either side can act first afterward.",
  "Preserve the supplied species designs, positions, flat cel shadows, pine trees, grass-capped ochre ledges, low battle viewpoint and light direction. No 3D, pixel art, humans, extra creatures, UI, words, captions, logos or morph transitions. Straight cuts; no speech or music, gentle outdoor ambience only. The app supplies the spoken command.",
].join(" ");

const recordPath = new URL(`${prefix}.provenance.json`, base);
let record;
try { record = JSON.parse(await readFile(recordPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (!record) {
  const images = await Promise.all(references.map(async path => {
    const bytes = await readFile(new URL(path, root));
    return client.storage.upload(new Blob([bytes], { type: "image/png" }), { lifecycle: { expiresIn: "1h" } });
  }));
  const input = { prompt, duration: 5, resolution: "768P", seed: FAL_VIDEO_SEED, prompt_expansion_mode: "balanced", enable_safety_checker: true };
  if (mode === "idle") Object.assign(input, { reference_image_urls: images, aspect_ratio: "16:9" });
  else Object.assign(input, { image_url: images[0], end_image_url: images[0] });
  const startedAt = Date.now();
  const queued = await client.queue.submit(model, { input, storageSettings: { expiresIn: "1h" } });
  record = { model, seed: FAL_VIDEO_SEED, requestId: queued.request_id, startedAt, references, prompt, durationSeconds: 5, resolution: "768P", status: "submitted" };
  await writeFile(recordPath, JSON.stringify(record, null, 2));
  console.log(`${prefix} submitted ${record.requestId}`);
}
if (record.status !== "downloaded") {
  await client.queue.subscribeToStatus(record.model, { requestId: record.requestId, mode: "polling", pollInterval: 1000, logs: false, timeout: 720000 });
  const result = await client.queue.result(record.model, { requestId: record.requestId });
  const url = result.data?.video?.url;
  if (!url) throw new Error("Video result is missing");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Video download HTTP ${response.status}`);
  await writeFile(new URL(`${prefix}.mp4`, base), Buffer.from(await response.arrayBuffer()));
  record = { ...record, status: "downloaded", completedAt: Date.now(), elapsedMs: Date.now() - record.startedAt, timings: result.data.timings, output: `${prefix}.mp4` };
  await writeFile(recordPath, JSON.stringify(record, null, 2));
}
async function runFfmpeg(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-n", ...args], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
  });
}
if (mode === "idle") {
  const loopPath = new URL(`${prefix}-loop.mp4`, base);
  const posterPath = new URL(`${prefix}-loop-first-frame.png`, base);
  try { await access(loopPath); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Join the final half-second to the opening half-second, then wrap from
    // that opening pose to the next chronological frame. Preserve the raw clip.
    await runFfmpeg(["-i", new URL(`${prefix}.mp4`, base).pathname, "-filter_complex",
      "[0:v]split[a][b];[a]trim=start=0.5:end=5,setpts=PTS-STARTPTS[main];[b]trim=start=0:end=0.5,setpts=PTS-STARTPTS[head];[main][head]xfade=transition=fade:duration=0.5:offset=4,format=yuv420p[out]",
      "-map", "[out]", "-an", "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", loopPath.pathname]);
  }
  try { await access(posterPath); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await runFfmpeg(["-i", loopPath.pathname, "-frames:v", "1", posterPath.pathname]);
  }
}
if (mode === "bridge") {
  const tailPath = new URL(`${prefix}-tail.jpg`, base);
  try { await access(tailPath); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const bytes = await readFile(new URL(`${prefix}.mp4`, base));
    const tail = await extractVideoTailFrame("http://localhost/pine-command-v2.mp4", { fetchImpl: async () => new Response(bytes) });
    await writeFile(tailPath, Buffer.from(await tail.arrayBuffer()));
  }
}
console.log(`${prefix} saved; generation and download ${record.elapsedMs} ms`);
