// One paid text-to-video request per fixed asset. Existing/uncertain submissions
// are never silently re-purchased. Raw outputs stay local for review/recovery.
import { createFalClient } from "@fal-ai/client";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { waitForFalStatus } from "../src/fal-status.js";
import { downloadVideo } from "../src/video-tail-frame.js";
import { FAL_VIDEO_SEED } from "../src/fal-video-runway.js";

const root = new URL("../", import.meta.url);
const mode = process.argv[2];
if (!["command", "recall"].includes(mode)) throw new Error("Usage: node scripts/generate-trainer-videos.mjs command|recall");
process.loadEnvFile(new URL(".env.local", root));
if (!process.env.FAL_KEY) throw new Error("FAL_KEY is not configured");
const client = createFalClient({ credentials: process.env.FAL_KEY });
const directory = new URL(".local/trainer-assets/", root);
await mkdir(directory, { recursive: true });
const ledger = new URL(`${mode}-v1.json`, directory);
const raw = new URL(`${mode}-v1.raw.mp4`, directory);
const output = new URL(`assets/video/trainer-${mode}-v1.mp4`, root);
const model = "minimax/h3-max-turbo/text-to-video";
const shared = [
  "A five-second 16:9 hand-drawn 2D cel-animation cut-in for a Pokemon-style television anime battle. This is a finished anime scene, not a logo, flat vector poster, pixel sprite, 3D game or live action.",
  "ONE original anonymous young-adult male monster trainer, not any named existing character. A slim athletic silhouette with a plain forward-facing baseball cap, short tousled hair under the cap, a high-collar short-sleeve adventure vest and fingerless gloves. He is entirely dark navy-black in strong backlight, with a narrow warm rim along his cap brim, cheek profile, shoulders and arm. His face and eyes stay hidden in silhouette throughout. Natural organic anime anatomy and traditional ink contours, two-tone cel paint, expressive key poses with clean in-between animation.",
  "Medium waist-up three-quarter side view from a slightly low angle; trainer on the left facing screen right. Softly painted sunny green pine-forest clearing behind him, warm sunlight, pale blue sky, gently swaying blurred foliage. Maintain the same outdoor background, left-to-right direction, scale and outfit throughout. One restrained camera push, no full orbit or scene change. Keep the right lower quarter uncluttered for text added later by the game.",
  "Only this one trainer. No visible Pokemon or other people, no body or face morphing, no extra limbs, no logos, no text, subtitles, captions, UI or watermarks. Silent clip: no dialogue, narration, singing or music; the game adds the selected command voice separately.",
].join(" ");
const action = mode === "command"
  ? "0.0-1.0 seconds: silhouette holds a determined ready pose, right forearm near chest, slight wind in vest. 1.0-2.5 seconds: he energetically extends his right arm toward screen right in one clear commanding gesture, index finger pointing, other fingers naturally curled. 2.5-4.0 seconds: the pointing pose settles with subtle shoulder and chest movement, as though calling an order, without revealing facial features. 4.0-5.0 seconds: hold the resolved forward-pointing pose with gentle cloth motion for the cut to the Pokemon close-up. One continuous shot, no ball, no throwing and no attacks."
  : "0.0-1.0 seconds: trainer silhouette stands ready with ONE closed red-and-white spherical capture ball held in his right hand near his waist. 1.0-2.5 seconds: lift that same ball smoothly to shoulder height, then extend it slightly toward screen right to prepare recalling his monster. The ball stays gripped between natural fingers, red upper hemisphere, white lower hemisphere, a black equatorial band and one small round front button. 2.5-4.0 seconds: a modest push-in emphasizes the silhouette hand and CLOSED ball, keeping trainer cap and shoulder visible. 4.0-5.0 seconds: hold the raised-ball pose steadily. The ball must remain closed and in his hand; no laser, no recall beam, no opening, no throwing, no appearing creature. The actual recall happens only in the next separate game clip.";
const input = { prompt: `${shared} ${action}`, duration: 5, resolution: "768P", aspect_ratio: "16:9",
  seed: FAL_VIDEO_SEED, prompt_expansion_mode: "balanced", enable_safety_checker: true };
let record;
try { record = JSON.parse(await readFile(ledger, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (!record) {
  record = { model, input, status: "submitting", startedAt: Date.now() };
  await writeFile(ledger, JSON.stringify(record, null, 2), { flag: "wx" });
  const queued = await client.queue.submit(model, { input, abortSignal: AbortSignal.timeout(45000), storageSettings: { expiresIn: "1d" } });
  record = { ...record, requestId: queued.request_id, status: "submitted" };
  await writeFile(ledger, JSON.stringify(record, null, 2));
  console.log(`${mode}: submitted ${record.requestId}`);
}
if (!record.requestId) throw new Error("UNCONFIRMED_SUBMISSION: inspect the existing ledger before any new paid request");
if (!record.videoUrl) {
  await waitForFalStatus(client, record.model, { requestId: record.requestId, signal: AbortSignal.timeout(720000),
    onTransport: mode => console.log(`status: ${mode}`), onQueueUpdate: () => {} });
  const result = await client.queue.result(record.model, { requestId: record.requestId });
  if (!result.data?.video?.url) throw new Error("Video result missing");
  record = { ...record, status: "generated", videoUrl: result.data.video.url, generatedAt: Date.now(), timings: result.data.timings };
  await writeFile(ledger, JSON.stringify(record, null, 2));
}
try { await access(raw); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  const bytes = await downloadVideo(record.videoUrl, { signal: AbortSignal.timeout(90000) });
  await writeFile(raw, bytes, { flag: "wx" });
}
try { await access(output); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-n", "-i", raw.pathname,
      "-t", "5", "-map", "0:v:0", "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output.pathname], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`)));
  });
}
record = { ...record, status: "downloaded", completedAt: Date.now(), output: output.pathname };
await writeFile(ledger, JSON.stringify(record, null, 2));
console.log(JSON.stringify({ mode, output: output.pathname, generationMs: record.generatedAt - record.startedAt }));
