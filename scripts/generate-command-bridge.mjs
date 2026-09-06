// One paid, reusable neutral command shot. Never contains a specific attack outcome.
import { createFalClient } from "@fal-ai/client";
import { readFile, writeFile } from "node:fs/promises";
import { extractVideoTailFrame } from "../src/video-tail-frame.js";

process.loadEnvFile(new URL("../.env.local", import.meta.url));
const client = createFalClient({ credentials: process.env.FAL_KEY });
const base = new URL("../assets/video/", import.meta.url);
const frame = await readFile(new URL("idle-battle-pikachu-charmander-anime-v3-first-frame.png", base));
const imageUrl = await client.storage.upload(new Blob([frame], { type: "image/png" }));
const prompt = [
  "A five-second hand-drawn Pokémon TV anime command-and-reaction shot in this exact grassy arena.",
  "Start with the supplied wide composition: Pikachu lower-left, Charmander upper-right. At 0.3 seconds cut to a lively three-quarter close-up of Pikachu: ears perk, eyes focus, it lowers its center of gravity and listens to its offscreen trainer. At 2.5 seconds cut back to the original wide shot. From 3.5 seconds both Pokémon hold a neutral ready stance with subtle breathing; finish on the supplied end image.",
  "This is anticipation only, not an attack: no electricity, projectile, running toward the opponent, impact, injury or victory. Charmander remains watchful and unharmed. The opponent may act first next.",
  "Preserve faithful species anatomy, clean ink contours, flat cel shadows and painted background. No 3D, pixel art, UI, text, additional characters or trainers on screen. No speech or music: gentle outdoor ambience only; the application supplies the exact spoken command separately.",
].join(" ");
const input = { prompt, duration: 5, resolution: "480P", prompt_expansion_mode: "balanced", enable_safety_checker: true, image_url: imageUrl, end_image_url: imageUrl };
const model = "minimax/h3-max-turbo/image-to-video";
const started = Date.now();
const queued = await client.queue.submit(model, { input });
await writeFile(new URL("command-bridge.request.json", base), JSON.stringify({ requestId: queued.request_id, model, prompt, startedAt: started }, null, 2));
console.log("Bridge submitted", queued.request_id);
await client.queue.subscribeToStatus(model, { requestId: queued.request_id, mode: "polling", pollInterval: 500, timeout: 720000 });
const result = await client.queue.result(model, { requestId: queued.request_id });
const url = result.data.video.url;
const bytes = await fetch(url).then(r => { if (!r.ok) throw new Error(`Download ${r.status}`); return r.arrayBuffer(); });
await writeFile(new URL("command-bridge.mp4", base), Buffer.from(bytes));
const tail = await extractVideoTailFrame(url);
await writeFile(new URL("command-bridge-tail.jpg", base), Buffer.from(await tail.arrayBuffer()));
await writeFile(new URL("command-bridge.provenance.json", base), JSON.stringify({ model, requestId: queued.request_id, prompt, elapsedMs: Date.now() - started, timings: result.data.timings, video: "command-bridge.mp4", tail: "command-bridge-tail.jpg" }, null, 2));
console.log("Bridge saved", Date.now() - started, "ms");
