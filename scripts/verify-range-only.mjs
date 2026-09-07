// Browser replay of two EXISTING attack videos; no model requests or cache edits.
// node scripts/verify-range-only.mjs .local/runs/<session-id>
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { VideoMediaCache } from "../src/video-media-cache.js";
import { sendDownloadingVideo } from "../src/local-video-response.js";

const source = process.argv[2];
if (!source) throw new Error("Pass an existing two-clip run directory");
const videos = await Promise.all([0, 1].map(index => readFile(join(source, `clip-${index}.mp4`))));
const poster = await readFile(join(source, "clip-0-tail.jpg"));
let entries = [], requests = [], active = [0, 0], peak = [0, 0];
const cache = new VideoMediaCache({ fetchImpl: async (url, { headers, signal }) => {
  const index = Number(new URL(url).pathname.slice(1, 2)), video = videos[index];
  if (!headers?.Range) throw new Error("Unexpected full GET");
  const [start, requestedEnd] = headers.Range.match(/\d+/g).map(Number), end = Math.min(video.length - 1, requestedEnd);
  requests.push({ index, start, end }); active[index]++; peak[index] = Math.max(peak[index], active[index]);
  await new Promise(resolve => setTimeout(resolve, 150)); signal.throwIfAborted();
  let offset = start, ended = false;
  const finish = () => { if (!ended) { ended = true; active[index]--; } };
  return new Response(new ReadableStream({ async pull(controller) {
    await new Promise(resolve => setTimeout(resolve, 50)); signal.throwIfAborted();
    const next = Math.min(offset + 65536, end + 1);
    controller.enqueue(video.subarray(offset, next)); offset = next;
    if (offset > end) { finish(); controller.close(); }
  }, cancel: finish }), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${video.length}`,
    "content-length": String(end - start + 1), etag: `"fixture-${index}"` } });
} });
const html = String.raw`<!doctype html><html lang="zh"><meta charset="utf-8"><title>Range-only 连续播放验证</title>
<style>body{margin:24px;background:#18263b;color:#fffbde;font:17px system-ui}button{padding:12px;font:inherit}#stage{position:relative;width:832px;height:480px;background:url('/poster.jpg') center/cover;border:4px solid #ffe174}video{position:absolute;width:100%;height:100%;object-fit:cover;visibility:hidden}video.is-visible{visibility:visible}pre{white-space:pre-wrap;font-size:14px}</style>
<h1>Range-only · 两段已有视频连续回放</h1><p>不调用模型。模拟每请求 150ms 延迟、每 50ms 传输 64KiB，验证无重复下载。</p><button>开始回放</button>
<div id="stage"><video muted playsinline></video><video muted playsinline></video><video muted playsinline></video></div><pre>等待开始</pre>
<script type="module">
import { AttackVideoPlayer } from '/src/attack-video-player.js';
const log=document.querySelector('pre'), button=document.querySelector('button');
button.onclick=async()=>{button.disabled=true;log.textContent='';const start=performance.now(), events=[];
const mark=(name,index,value)=>{const item={name,index,ms:Math.round(performance.now()-start),...(value===undefined?{}:{value})};events.push(item);log.textContent+=JSON.stringify(item)+'\n';};
try{await fetch('/start',{method:'POST'}); const controller=new AbortController();
const player=new AttackVideoPlayer({videos:[...document.querySelectorAll('video')],signal:controller.signal,configureVideo:v=>{v.muted=true;},mark,
waitForClip:async index=>{while(true){const state=await(await fetch('/state')).json();if(state.error)throw new Error(state.error);if(state.clips[index]?.ready)return {clip:{index,rangeOnly:true,localVideoUrl:'/media/'+index,videoUrl:null},session:{id:'local-range-test'}};await new Promise(r=>setTimeout(r,30));}}});
const a=player.prepare(0), b=player.prepare(1);let old=null;
for(const [index,pending]of[a,b].entries()){const result=await pending;if(result.error)throw result.error;const item=result.value;
const playback=player.play(item,old,{onFrame:()=>mark('playing',index),onTime(){},onBlocked(){}});await playback.ended;mark('ended',index);old=item.video;}
const state=await(await fetch('/state')).json();mark('complete');log.textContent+='验证结果 '+JSON.stringify(state)+'\n';
}catch(error){log.textContent+='FAILED '+error.message;}}
</script>`;

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end(html); return; }
    if (path === "/poster.jpg") { response.writeHead(200, { "content-type": "image/jpeg" }); response.end(poster); return; }
    if (path === "/start" && request.method === "POST" && !entries.length) {
      entries[0] = cache.pin("https://v3.fal.media/0.mp4");
      entries[0].tail.then(() => { entries[1] = cache.pin("https://v3.fal.media/1.mp4"); }).catch(() => {});
      response.end("ok"); return;
    }
    if (path === "/state") {
      const clips = entries.map((entry, index) => {
        const ranges = requests.filter(r => r.index === index).sort((a, b) => a.start - b.start);
        const bytes = ranges.reduce((total, range) => total + range.end - range.start + 1, 0);
        const overlaps = ranges.slice(1).some((range, i) => range.start <= ranges[i].end);
        return { ready: true, complete: entry.settled && !entry.error, metrics: entry.timings,
          requests: ranges.length, requestedBytes: bytes, fileBytes: videos[index].length, overlaps, maxConcurrent: peak[index] };
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ clips, error: entries.find(e => e.error)?.error?.message, paidCalls: 0 })); return;
    }
    const media = /^\/media\/([01])$/.exec(path);
    if (media && entries[Number(media[1])]) { await sendDownloadingVideo(request, response, entries[Number(media[1])]); return; }
    const allowed = new Set(["/src/attack-video-player.js", "/src/inline-cinema.js", "/src/attack-source.js"]);
    if (allowed.has(path)) { response.setHeader("content-type", "text/javascript"); response.end(await readFile(join(process.cwd(), path))); return; }
    response.writeHead(404).end();
  } catch (error) { if (!response.headersSent) response.writeHead(500); response.end(error.message); }
});
server.listen(0, "127.0.0.1", () => console.log(`Range-only verification: http://127.0.0.1:${server.address().port}/`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
