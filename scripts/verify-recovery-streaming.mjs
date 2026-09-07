// Isolated browser comparison using an EXISTING local video. No provider API.
// node scripts/verify-recovery-streaming.mjs <existing-recovery-directory>
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { handleHttpRequest } from "../server.mjs";
import { SceneVideoService } from "../src/scene-video-service.js";
import { FAL_VIDEO_MODEL } from "../src/fal-video-runway.js";
import { extractVideoTailFrame } from "../src/video-tail-frame.js";

const source = process.argv[2];
if (!source) throw new Error("Pass an existing recovery directory (no generation is performed)");
const video = await readFile(join(source, "media.mp4"));
const poster = await readFile(join(source, "tail.jpg"));
const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
if (manifest.kind !== "recovery") throw new Error("Expected a recovery clip");
const directory = await mkdtemp(join(tmpdir(), "pokemon-stream-browser-"));
let downloads = 0;
class BaselineService extends SceneVideoService {
  snapshot(job) {
    const value = super.snapshot(job);
    // Reproduce only the old full-download publication gate, not a new model.
    return value.playable ? value : { ...value, streamable: false, videoUrl: null, fallbackVideoUrl: null };
  }
}
const services = Object.fromEntries(["baseline", "stream"].map(mode => {
  const Service = mode === "baseline" ? BaselineService : SceneVideoService;
  return [mode, new Service({ directory: join(directory, mode),
    loadReferences: async () => [], loadContextImages: async () => [],
    loadAttackAnchor: async () => `data:image/jpeg;base64,${poster.toString("base64")}`,
    tailExtractor: extractVideoTailFrame,
    runwayFactory: hooks => {
      let status = "generating";
      const clip = { requestId: randomUUID(), model: FAL_VIDEO_MODEL, generationMs: 0, videoUrl: "https://v3.fal.media/local-fixture.mp4" };
      return {
        create() { void hooks.submittedSink({ clip }).then(() => { status = "ready"; }); return { id: "local-fixture" }; },
        get() { return { status, clips: [clip] }; }, cancel() { status = "cancelled"; },
      };
    },
    fetchImpl: async (_url, { signal }) => {
      downloads++;
      await new Promise(resolve => setTimeout(resolve, 150)); signal.throwIfAborted();
      let offset = 0;
      return new Response(new ReadableStream({ async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 100)); signal.throwIfAborted();
        const next = Math.min(offset + 65536, video.length);
        controller.enqueue(video.subarray(offset, next)); offset = next;
        if (offset === video.length) controller.close();
      } }), { headers: { "content-length": String(video.length) } });
    },
  })];
}));
const html = String.raw`<!doctype html><html lang="zh"><meta charset="utf-8"><title>收尾渐进缓冲对照</title>
<style>body{margin:28px;background:#18263b;color:#fffbde;font:18px system-ui}button{padding:12px 20px;margin:0 12px 16px 0;font:inherit}#stage{position:relative;width:832px;height:480px;background:url('/poster.jpg') center/cover;border:4px solid #ffe174}video{position:absolute;width:100%;height:100%;object-fit:cover;visibility:hidden}video.is-visible{visibility:visible}pre{font-size:15px;white-space:pre-wrap}</style>
<h1>同一段已有收尾 · 旧门槛与渐进缓冲对照</h1><p>仅本地文件，模拟 150 ms 响应延迟 + 每 100 ms 64 KiB；生成时间为 0，无付费请求。</p>
<button id="baseline">旧流程测试</button><button id="stream">渐进收尾测试</button><div id="stage"><video muted playsinline></video><video muted playsinline></video><video muted playsinline></video></div><pre id="log">请选择测试</pre>
<script type="module">
import { requestSceneVideo } from '/src/scene-video-client.js';
import { AttackVideoPlayer } from '/src/attack-video-player.js';
const videos=[...document.querySelectorAll('video')], log=document.querySelector('#log');
const base=${JSON.stringify({ kind: "recovery", scene: manifest.scene, health: manifest.health, sourceAttack: manifest.sourceAttack })};
let controller;
async function run(mode){
 controller?.abort();controller=new AbortController();const signal=controller.signal;
 document.querySelectorAll('button').forEach(b=>b.disabled=true);log.textContent=mode+'\n';
 videos.forEach(v=>{v.pause();v.classList.remove('is-visible');v.removeAttribute('src');v.load();});
 const start=performance.now();const mark=(name,index,value)=>{log.textContent+=Math.round(performance.now()-start)+' ms '+name+(value==null?'':' '+value)+'\n';};
 try{
  const payload={...base,sourceAttack:{...base.sourceAttack,sessionId:crypto.randomUUID()}};
  const job=await requestSceneVideo(payload,signal,(url,options)=>fetch('/'+mode+url,options));
  mark('返回素材');
  const player=new AttackVideoPlayer({videos,signal,configureVideo:v=>{v.muted=true;v.loop=false;},mark,
    waitForClip:async()=>({clip:{index:0,localVideoUrl:'/'+mode+job.videoUrl},session:null})});
  const item=await player.prepare(0);if(item.error)throw item.error;
  const playing=player.play(item.value,null,{onFrame:()=>mark('真实首帧'),onTime:()=>{},onBlocked:()=>{}});
  await playing.ended;mark('播放完成');
  const status=await(await fetch('/'+mode+'/api/scene-videos/'+job.key)).json();
  log.textContent+=JSON.stringify(status.job.timings,null,2)+'\n';
 }catch(error){mark('错误 '+error.message);}finally{document.querySelectorAll('button').forEach(b=>b.disabled=false);}
}
document.querySelector('#baseline').onclick=()=>run('baseline');document.querySelector('#stream').onclick=()=>run('stream');
</script></html>`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html); return; }
    if (request.url === "/poster.jpg") { response.writeHead(200, { "Content-Type": "image/jpeg" }).end(poster); return; }
    const match = /^\/(baseline|stream)(\/api\/scene-videos.*)$/.exec(request.url);
    if (match) {
      const service = services[match[1]]; request.url = match[2];
      if (request.method === "POST" && request.url === "/api/scene-videos") {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const job = service.create(JSON.parse(Buffer.concat(chunks)), "local-fixture-only");
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, job })); return;
      }
      await handleHttpRequest(request, response, service); return;
    }
    // Only static client modules, never a real API on this diagnostic server.
    if (request.method === "GET" && request.url.startsWith("/src/")) { await handleHttpRequest(request, response); return; }
    response.writeHead(404).end();
  } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
});
server.listen(0, "127.0.0.1", () => console.log(`Local-only verification: http://127.0.0.1:${server.address().port}/`));
process.once("SIGTERM", async () => {
  for (const service of Object.values(services)) for (const key of service.jobs.keys()) service.cancel(key);
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await Promise.all(Object.values(services).flatMap(service => [...service.jobs.values()].map(job => job.done)));
  await rm(directory, { recursive: true, force: true });
  console.log(`Closed local fixture, downloads=${downloads}, paid API calls=0`);
});
