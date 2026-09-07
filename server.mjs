import { createReadStream } from "node:fs";
import { readFile, stat, mkdir, writeFile, appendFile, rename } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createFallbackStoryboard,
  createRealtimeStoryboard,
  normalizeStoryboardPlan,
  sanitizeAttackRecords,
} from "./src/attack-storyboard.js";
import { SPECIES } from "./src/data.js";
import { FalVideoRunway, FAL_VIDEO_RESOLUTIONS } from "./src/fal-video-runway.js";
import { SceneVideoService, sceneVideoSpec, SCENE_VIDEO_KEY } from "./src/scene-video-service.js";
import { attackVisualScene, visualSceneKey, validateSwitch } from "./src/visual-battle-state.js";
import { downloadVideo } from "./src/video-tail-frame.js";
import { CloudTailFrames } from "./src/cloud-tail-frame.js";
import { loadAttackSceneAnchor, loadArchivedAttackTail, sceneAfterBeat, ATTACK_TAIL_URL_TTL_MS } from "./src/attack-scene-anchor.js";
import { VideoMediaCache } from "./src/video-media-cache.js";
import { sendLocalVideo, sendDownloadingVideo } from "./src/local-video-response.js";
import { SpeechCache } from "./src/minimax-speech.js";
import { buildDeepSeekMessages, normalizeCompactStoryboard } from "./src/compact-storyboard.js";
import { normalizeLanguage } from "./src/language.js";

const PROJECT_ROOT = fileURLToPath(new URL(".", import.meta.url));
const battleSpeech = new SpeechCache({ directory: join(PROJECT_ROOT, ".local", "battle-speech") });
const PORT = Number(process.env.PORT || 4173);
const BODY_LIMIT = 64 * 1024;
const VIDEO_BODY_LIMIT = 4.5 * 1024 * 1024;
const REFERENCE_IMAGE_LIMIT = 512 * 1024;
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const attackContinuity = new Map();
const attackMedia = new VideoMediaCache();
const attackTailFrames = new CloudTailFrames({ loadCredentials: loadFalKey,
  metricSink: metric => console.info(`[attack-tail-metric] ${JSON.stringify(metric)}`) });
const sceneVideos = new SceneVideoService({
  directory: join(PROJECT_ROOT, ".local", "scene-videos"),
  loadAttackAnchor: (source, scene, signal, recoveryHealth) => loadAttackSceneAnchor(source, scene, signal, {
    continuity: attackContinuity, runway: attackVideoRunway, directory: join(PROJECT_ROOT, ".local", "runs"), recoveryHealth,
  }),
  loadDefaultAnchor: async (scene, kind) => {
    if (scene.player.speciesId !== "pikachu" || scene.opponent.speciesId !== "charmander"
      || Object.values(scene).some(p => p.status || p.confused || p.fainted)) return null;
    const path = kind === "command" ? "assets/video/pine-idle-v2-loop-first-frame.png" : "assets/video/pine-command-v2-tail.jpg";
    const bytes = await readFile(join(PROJECT_ROOT, path));
    return `data:image/${kind === "command" ? "png" : "jpeg"};base64,${bytes.toString("base64")}`;
  },
  loadReferences: scene => loadBattleReferenceImages([{ actor: { ...scene.player, side: "player" }, target: { ...scene.opponent, side: "opponent" } }], { artwork: true }),
  loadContextImages: async (before, after) => {
    const side = visualSceneKey(before) === visualSceneKey(after) ? null : validateSwitch(before, after);
    return Promise.all(["assets/backgrounds/pine-clearing-v2.png", ...(side ? [`assets/video-references/artwork/${before[side].speciesId}.png`] : [])].map(async path => {
      const bytes = await readFile(join(PROJECT_ROOT, path));
      return `data:image/png;base64,${bytes.toString("base64")}`;
    }));
  },
});
const FAL_RESOLUTION = FAL_VIDEO_RESOLUTIONS.has(process.env.FAL_VIDEO_RESOLUTION)
  ? process.env.FAL_VIDEO_RESOLUTION
  : "480P";
const attackVideoRunway = new FalVideoRunway({
  resolution: FAL_RESOLUTION,
  tailFrameExtractor: (url, options) => attackTailFrames.url(url, options),
  metricSink: (metric) => console.info(`[attack-video-metric] ${JSON.stringify(metric)}`),
  clipSink: archiveAttackClip,
});

export async function archiveAttackClip({ session, clip, prompt }, {
  cache = attackMedia, continuity = attackContinuity.get(session.id)?.clips[clip.index],
  directory = join(PROJECT_ROOT, ".local", "runs", session.id), writeArtifact = writeCompleteMedia,
  tailFrames = attackTailFrames,
  fetchTail = url => downloadVideo(url, { maxBytes: 3 * 1024 * 1024, signal: AbortSignal.timeout(15000) }),
} = {}) {
    const tailStarted = performance.now();
    let media, tailReadyMs;
    // Also extract the final clip for recovery/state prewarm. This shares the
    // continuation request and is independent of media-cache/disk failures.
    const tail = tailFrames.url(clip.videoUrl).then(url => {
      tailReadyMs = Math.round(performance.now() - tailStarted);
      if (continuity) continuity.tailExpiresAt = Date.now() + ATTACK_TAIL_URL_TTL_MS;
      continuity?.resolveTail(url);
      return url;
    });
    tail.catch(() => continuity?.resolveTail(null));
    try {
      media = cache.pin(clip.videoUrl);
      await mkdir(directory, { recursive: true });
      const writes = await Promise.allSettled([
        writeFile(join(directory, `clip-${clip.index}.json`), JSON.stringify({ ...clip, prompt }, null, 2)),
        media.bytes.then(bytes => writeArtifact(join(directory, `clip-${clip.index}.mp4`), bytes)),
        tail.then(async url => {
          await writeArtifact(join(directory, `clip-${clip.index}-tail.json`), JSON.stringify({ url, createdAt: Date.now() }));
          // Persistence only: do not compete with this video's playback download
          // for the JPEG. Continuation already received the cloud URL above.
          await media.bytes.catch(() => {});
          const bytes = await fetchTail(url);
          await writeArtifact(join(directory, `clip-${clip.index}-tail.jpg`), bytes);
        }),
      ]);
      await writeFile(join(directory, `clip-${clip.index}-media.json`), JSON.stringify({ ...media.timings,
        tailSource: "cloud", tailReadyMs: tailReadyMs ?? null, cloudTailMs: tailReadyMs ?? null }));
      const failed = writes.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
      cache.release(clip.videoUrl);
    } finally { await tail.catch(() => {}); if (media) cache.unpin(clip.videoUrl); }
}

async function writeCompleteMedia(path, bytes) {
  await writeFile(`${path}.part`, bytes);
  await rename(`${path}.part`, path);
}
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("请求体过大");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求体不是有效 JSON");
    error.statusCode = 400;
    throw error;
  }
}

function parseEnvValue(contents, names) {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || !names.includes(match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) return value;
  }
  return "";
}

async function loadDeepSeekKey() {
  const direct = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY;
  if (direct) return direct;
  const userRoot = homedir();
  const candidates = [
    process.env.DEEPSEEK_ENV_FILE,
    join(userRoot, "agentlive", ".env.local"),
    join(userRoot, "Agenticlive", "agentlive", ".env"),
    join(userRoot, "threejs-agent-world", ".env.local"),
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      const value = parseEnvValue(await readFile(path, "utf8"), ["DEEPSEEK_API_KEY", "DEEPSEEK_KEY"]);
      if (value) return value;
    } catch (error) {
      if (error.code !== "ENOENT") continue;
    }
  }
  return "";
}

async function loadFalKey() {
  if (process.env.FAL_DISABLE_VIDEO === "1") return "";
  const direct = process.env.FAL_KEY;
  if (direct) return direct;
  const userRoot = homedir();
  const candidates = [
    process.env.FAL_ENV_FILE,
    join(PROJECT_ROOT, ".env.local"),
    join(PROJECT_ROOT, ".env"),
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      const value = parseEnvValue(await readFile(path, "utf8"), ["FAL_KEY"]);
      if (value) return value;
    } catch (error) {
      if (error.code !== "ENOENT") continue;
    }
  }
  return "";
}

async function loadMinimaxKey() {
  if (process.env.MINIMAX_DISABLE_SPEECH === "1") return "";
  if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY;
  for (const file of [".env.minimax.local", ".env.local", ".env"]) {
    try {
      const key = parseEnvValue(await readFile(join(PROJECT_ROOT, file), "utf8"), ["MINIMAX_API_KEY"]);
      if (key) return key;
    } catch { /* Missing local configuration is reported without exposing it. */ }
  }
  return "";
}

function parseModelJson(content) {
  if (typeof content !== "string" || !content.trim()) throw new Error("EMPTY_RESPONSE");
  const clean = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(clean);
  } catch {
    throw new Error("INVALID_JSON");
  }
}

async function planWithDeepSeek(attacks, externalSignal, language = "zh") {
  const apiKey = await loadDeepSeekKey();
  if (!apiKey) throw new Error("MISSING_KEY");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 22_000);
  const abortFromClient = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortFromClient, { once: true });
  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: buildDeepSeekMessages(attacks, language),
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`UPSTREAM_${response.status}`);
    const payload = await response.json();
    if (payload.choices?.[0]?.finish_reason === "length") throw new Error("TRUNCATED_RESPONSE");
    const candidate = parseModelJson(payload.choices?.[0]?.message?.content);
    return { model, plan: normalizeCompactStoryboard(candidate, attacks) };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromClient);
  }
}

function failureCode(error) {
  if (error?.name === "AbortError") return "timeout";
  if (error?.code === "INVALID_STORYBOARD") return "invalid_storyboard";
  const known = {
    EMPTY_RESPONSE: "empty_response",
    INVALID_JSON: "invalid_json",
    MISSING_KEY: "missing_key",
    TRUNCATED_RESPONSE: "truncated_response",
  };
  if (known[error?.message]) return known[error.message];
  if (error?.message?.startsWith("UPSTREAM_")) return "upstream_error";
  return "planner_error";
}

function failureDetail(error, code) {
  if (code === "invalid_storyboard") return error.message;
  if (code === "invalid_json") return "DeepSeek 返回内容不是有效 JSON";
  if (code === "empty_response") return "DeepSeek 返回了空内容";
  if (code === "truncated_response") return "DeepSeek 响应因长度限制被截断";
  return "";
}

async function handleStoryboardRequest(request, response) {
  const startedAt = performance.now();
  const clientController = new AbortController();
  const abortClient = () => clientController.abort();
  const abortOnResponseClose = () => {
    if (!response.writableEnded) abortClient();
  };
  request.once("aborted", abortClient);
  response.once("close", abortOnResponseClose);
  try {
    const body = await readJsonBody(request);
    if (body?.version !== 2) throw new Error("分镜请求必须使用 version=2 联合时间线");
    const language = normalizeLanguage(body.language);
    const attacks = sanitizeAttackRecords(body?.attacks);
    try {
      const result = await planWithDeepSeek(attacks, clientController.signal, language);
      if (clientController.signal.aborted) return;
      jsonResponse(response, 200, {
        ok: true,
        source: "deepseek",
        language,
        model: result.model,
        planningMs: Math.round(performance.now() - startedAt),
        plan: result.plan,
      });
    } catch (error) {
      if (clientController.signal.aborted) return;
      const code = failureCode(error);
      const detail = failureDetail(error, code);
      jsonResponse(response, 200, {
        ok: true,
        source: "local-fallback",
        language,
        model: null,
        planningMs: Math.round(performance.now() - startedAt),
        failureCode: code,
        failureDetail: detail,
        warning: `DeepSeek 分镜不可用（${code}），已使用确定性本地分镜。`,
        plan: createFallbackStoryboard(attacks, code),
      });
    }
  } catch (error) {
    if (clientController.signal.aborted) return;
    jsonResponse(response, error.statusCode ?? 400, { ok: false, error: error.message });
  } finally {
    request.removeListener("aborted", abortClient);
    response.removeListener("close", abortOnResponseClose);
  }
}

function requireTurnContext(body, attacks) {
  if (!Number.isInteger(body?.battleEpoch) || body.battleEpoch < 0) {
    throw new TypeError("battleEpoch 无效");
  }
  if (!Number.isInteger(body?.turn) || body.turn < 1) throw new TypeError("turn 无效");
  if (attacks.some((attack) => (
    attack.battleEpoch !== body.battleEpoch || attack.turn !== body.turn
  ))) {
    throw new TypeError("分镜与回合上下文不一致");
  }
}

export async function loadBattleReferenceImages(attacks, { artwork = true } = {}) {
  const bySide = new Map();
  for (const attack of attacks) {
    for (const combatant of [attack.actor, attack.target]) {
      const existing = bySide.get(combatant.side);
      if (existing && existing.speciesId !== combatant.speciesId) {
        throw new TypeError("同一回合的参考图角色不一致");
      }
      bySide.set(combatant.side, combatant);
    }
  }
  return Promise.all(["player", "opponent"].map(async (side) => {
    const combatant = bySide.get(side);
    const species = combatant && SPECIES[combatant.speciesId];
    if (!species?.videoReference) throw new TypeError(`缺少${side === "player" ? "我方" : "对方"}宝可梦参考图`);
    const bytes = await readFile(join(PROJECT_ROOT, artwork ? `assets/video-references/artwork/${species.id}.png` : species.videoReference));
    if (!bytes.length || bytes.length > REFERENCE_IMAGE_LIMIT) throw new RangeError("宝可梦参考图大小无效");
    return {
      side,
      speciesId: species.id,
      name: species.name,
      imageUrl: `data:image/png;base64,${bytes.toString("base64")}`,
    };
  }));
}

async function handleAttackVideoCreate(request, response) {
  let sessionId = null;
  let clientDisconnected = false;
  const cancelCreatedSession = () => {
    clientDisconnected = true;
    if (sessionId) attackVideoRunway.cancel(sessionId);
  };
  request.once("aborted", cancelCreatedSession);
  response.once("close", () => {
    if (!response.writableEnded) cancelCreatedSession();
  });
  try {
    const body = await readJsonBody(request, VIDEO_BODY_LIMIT);
    if (body?.version !== 2) throw new TypeError("视频请求必须使用 version=2 联合时间线");
    const language = normalizeLanguage(body.language);
    const attacks = sanitizeAttackRecords(body?.attacks);
    requireTurnContext(body, attacks);
    let plan = normalizeStoryboardPlan({ version: 2, sequence: body?.sequence }, attacks);
    let openingFrame = null;
    if (body.presentation === "inline-command-v1") {
      const player = attacks[0].actor.side === "player" ? attacks[0].actor : attacks[0].target;
      const opponent = attacks[0].actor.side === "opponent" ? attacks[0].actor : attacks[0].target;
      const matchingPair = player.speciesId === "pikachu" && opponent.speciesId === "charmander";
      if (body.sceneAnchorKey && SCENE_VIDEO_KEY.test(body.sceneAnchorKey)) {
        openingFrame = await sceneVideos.anchor(body.sceneAnchorKey, attackVisualScene(attacks[0]));
      }
      if (!openingFrame && body.continuationSessionId) {
        openingFrame = await loadAttackContinuation(body.continuationSessionId, attackVisualScene(attacks[0]));
      }
      if (!openingFrame && body.commandBridge && matchingPair && !player.status && !opponent.status && !player.confused && !opponent.confused) {
        const frame = await readFile(join(PROJECT_ROOT, "assets/video/pine-command-v2-tail.jpg"));
        openingFrame = `data:image/jpeg;base64,${frame.toString("base64")}`;
        // Let the shot end on its actual reaction; an idle end-image suppresses
        // camera coverage and can erase fainting or persistent status acting.
      }
      plan = createRealtimeStoryboard(attacks, plan, Boolean(openingFrame));
    }
    const credentials = await loadFalKey();
    if (!credentials) {
      jsonResponse(response, 503, {
        ok: false,
        code: "missing_fal_key",
        error: "未配置 FAL_KEY；请在服务端环境或项目 .env.local 中设置后重启。",
      });
      return;
    }
    const referenceImages = await loadBattleReferenceImages(attacks);
    if (clientDisconnected) return;
    const session = attackVideoRunway.create({
      credentials,
      language,
      beats: plan.turn.sequence,
      referenceImages,
      battleEpoch: body.battleEpoch,
      turn: body.turn,
      openingFrame,
    });
    sessionId = session.id;
    const clips = plan.turn.sequence.map(beat => {
      let resolveTail;
      const tail = new Promise(resolve => { resolveTail = resolve; });
      return { scene: sceneAfterBeat(beat, attacks), tail, resolveTail };
    });
    attackContinuity.set(sessionId, { scene: clips.at(-1).scene, clips, attacks });
    if (attackContinuity.size > 40) attackContinuity.delete(attackContinuity.keys().next().value);
    const directory = join(PROJECT_ROOT, ".local", "runs", sessionId);
    void mkdir(directory, { recursive: true })
      .then(() => writeFile(join(directory, "plan.json"), JSON.stringify({ attacks, plan, session }, null, 2)))
      .catch(() => console.warn("Attack plan archive failed", sessionId));
    if (clientDisconnected) {
      attackVideoRunway.cancel(sessionId);
      return;
    }
    jsonResponse(response, 202, { ok: true, session: playbackSession(session) });
  } catch (error) {
    if (clientDisconnected) return;
    const statusCode = error.code === "MISSING_FAL_KEY"
      ? 503
      : error.code === "FAL_RUNWAY_BUSY" ? 429
      : error.statusCode ?? (error instanceof TypeError || error instanceof RangeError ? 400 : 500);
    jsonResponse(response, statusCode, {
      ok: false,
      code: error.code === "FAL_RUNWAY_BUSY" ? "fal_runway_busy" : undefined,
      error: error.message,
    });
  }
}

export async function loadAttackContinuation(id, scene, {
  continuity = attackContinuity, runway = attackVideoRunway, runsDirectory = join(PROJECT_ROOT, ".local", "runs"),
} = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) return null;
  const previous = continuity.get(id);
  const session = previous ? runway.get(id) : null;
  if (previous && session) {
    if (session.status !== "ready" || visualSceneKey(previous.scene) !== visualSceneKey(scene)) return null;
    const final = previous.clips.at(-1);
    if (!final.tailExpiresAt || Date.now() < final.tailExpiresAt) return final.tail;
  }
  // Reuse an already-paid, locally archived final frame after a server restart.
  // Only server-produced records and media under the UUID directory are read.
  try {
    const directory = join(runsDirectory, id);
    const saved = JSON.parse(await readFile(join(directory, "plan.json"), "utf8"));
    const attacks = sanitizeAttackRecords(saved.attacks);
    if (visualSceneKey(attackVisualScene(attacks.at(-1), true)) !== visualSceneKey(scene)) return null;
    const index = saved.plan.turn.sequence.length - 1;
    if (!Number.isInteger(index) || index < 0 || index > 3) return null;
    return await loadArchivedAttackTail(directory, index);
  } catch { return null; }
}

function attackVideoSessionId(pathname) {
  const match = pathname.match(/^\/api\/attack-videos\/([0-9a-f-]{36})$/i);
  return match?.[1] ?? null;
}

function handleAttackVideoStatus(response, sessionId) {
  const session = attackVideoRunway.get(sessionId);
  if (!session) {
    jsonResponse(response, 404, { ok: false, error: "找不到该视频生成任务" });
    return;
  }
  jsonResponse(response, 200, { ok: true, session: playbackSession(session) });
}

export function playbackSession(session) {
  if (!session) return session;
  return { ...session, clips: session.clips.map(clip => ({ ...clip,
    // Attack media must not open a competing browser CDN download.
    localVideoUrl: clip.videoUrl ? `/api/attack-videos/${session.id}/clips/${clip.index}.mp4` : null,
    sharedDownloadOnly: Boolean(clip.videoUrl),
  })) };
}

async function handleAttackMedia(request, response, id, index) {
  const path = join(PROJECT_ROOT, ".local", "runs", id, `clip-${index}.mp4`);
  // While the archive is being written, serve the completed shared bytes, never
  // an incomplete file. After release/restart the finished local archive wins.
  const clip = attackVideoRunway.get(id)?.clips[index];
  try {
    if (clip?.status === "ready" && attackMedia.entries.has(clip.videoUrl)) {
      await sendDownloadingVideo(request, response, attackMedia.prepare(clip.videoUrl));
    } else {
      await sendLocalVideo(request, response, { path });
    }
  } catch { if (!response.destroyed && !response.headersSent) response.writeHead(404).end(); }
}

function handleAttackVideoCancel(response, sessionId) {
  if (!attackVideoRunway.cancel(sessionId)) {
    jsonResponse(response, 404, { ok: false, error: "找不到该视频生成任务" });
    return;
  }
  jsonResponse(response, 200, { ok: true, session: playbackSession(attackVideoRunway.get(sessionId)) });
}

function acceptsJson(request) {
  return /^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "");
}

function hasTrustedOrigin(request) {
  const host = request.headers.host ?? "";
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://${host}`;
}

function resolveStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (relativePath.split("/").some((part) => part.startsWith("."))) return null;
  const filePath = normalize(join(PROJECT_ROOT, relativePath));
  const projectRelative = relative(PROJECT_ROOT, filePath);
  if (!projectRelative || projectRelative.startsWith("..") || projectRelative.includes("../")) return null;
  return filePath;
}

async function serveStatic(request, response, pathname) {
  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("NOT_FILE");
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Length": info.size,
      "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

export async function handleHttpRequest(request, response, sceneService = sceneVideos) {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/api/battle-speech" && request.method === "POST") {
    if (!hasTrustedOrigin(request) || !acceptsJson(request)) { jsonResponse(response, 403, { ok: false }); return; }
    try {
      const body = await readJsonBody(request, 4096);
      if (response.destroyed) return;
      const audio = await battleSpeech.get(body?.text, loadMinimaxKey, body?.language);
      if (response.destroyed) return;
      response.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.bytes.length,
        "Cache-Control": "no-store", "X-Voice-Cache": audio.cached ? "hit" : "miss",
        "X-Voice-Generation-Ms": String(audio.timings?.totalMs ?? 0) });
      response.end(audio.bytes);
    } catch (error) {
      if (!response.destroyed) jsonResponse(response, error.statusCode ?? 502, { ok: false, error: error.statusCode === 400 ? "不支持的播报台词" : "MiniMax 语音暂不可用" });
    }
    return;
  }
  if (url.pathname === "/api/scene-videos" && request.method === "POST") {
    if (!hasTrustedOrigin(request) || !acceptsJson(request)) { jsonResponse(response, 403, { ok: false }); return; }
    let key;
    let disconnected = false;
    response.once("close", () => { if (!response.writableEnded) { disconnected = true; if (key) sceneService.cancel(key); } });
    try {
      const body = await readJsonBody(request);
      const spec = sceneVideoSpec(body);
      const cached = await sceneService.get(spec.key);
      if (cached?.status === "ready") { jsonResponse(response, 200, { ok: true, job: cached }); return; }
      const credentials = await loadFalKey();
      if (!credentials) { jsonResponse(response, 503, { ok: false, error: "服务端未配置 FAL_KEY" }); return; }
      if (disconnected) return;
      const job = sceneService.create(body, credentials);
      key = job.key;
      jsonResponse(response, 202, { ok: true, job });
    } catch (error) { if (!disconnected) jsonResponse(response, error.statusCode ?? 400, { ok: false, error: error.message }); }
    return;
  }
  const sceneRoute = url.pathname.match(/^\/api\/scene-videos\/([0-9a-f]{64})(?:\/(media\.mp4|tail\.jpg))?$/);
  if (sceneRoute && ["GET", "HEAD", "DELETE"].includes(request.method)) {
    if (!hasTrustedOrigin(request)) { jsonResponse(response, 403, { ok: false }); return; }
    const [, key, media] = sceneRoute;
    const job = await sceneService.get(key);
    if (!job) { jsonResponse(response, 404, { ok: false }); return; }
    if (!media) {
      if (request.method === "DELETE") sceneService.cancel(key);
      jsonResponse(response, 200, { ok: true, job: await sceneService.get(key) });
    } else if (media === "media.mp4" && job.streamable && !job.playable && request.method !== "DELETE") {
      const entry = sceneService.downloading(key);
      if (entry) await sendDownloadingVideo(request, response, entry);
      else jsonResponse(response, 409, { ok: false });
    } else if ((job.playable || job.status === "ready") && (media === "media.mp4" || job.tailReady) && request.method !== "DELETE") {
      const path = join(sceneService.directory, key, media);
      try {
        await sendLocalVideo(request, response, { path, contentType: MIME_TYPES[extname(media)] });
      } catch { response.writeHead(404).end(); }
    } else jsonResponse(response, 409, { ok: false });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/attack-storyboards") {
    if (!acceptsJson(request)) {
      jsonResponse(response, 415, { ok: false, error: "Content-Type 必须是 application/json" });
      return;
    }
    if (!hasTrustedOrigin(request)) {
      jsonResponse(response, 403, { ok: false, error: "不接受跨来源的分镜请求" });
      return;
    }
    await handleStoryboardRequest(request, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/attack-videos") {
    if (!acceptsJson(request)) {
      jsonResponse(response, 415, { ok: false, error: "Content-Type 必须是 application/json" });
      return;
    }
    if (!hasTrustedOrigin(request)) {
      jsonResponse(response, 403, { ok: false, error: "不接受跨来源的视频生成请求" });
      return;
    }
    await handleAttackVideoCreate(request, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/cinema-metrics") {
    if (!hasTrustedOrigin(request) || !acceptsJson(request)) {
      jsonResponse(response, 403, { ok: false });
      return;
    }
    try {
      const body = await readJsonBody(request);
      if (!/^[0-9a-f-]{36}$/i.test(body.sessionId ?? "") || !Array.isArray(body.events) || body.events.length > 256) throw new TypeError("invalid metrics");
      const events = body.events.map(event => {
        if (!Number.isFinite(event.ms) || event.ms < 0) throw new TypeError("invalid timing");
        return { name: String(event.name).slice(0, 60), ms: event.ms,
          clipIndex: Number.isInteger(event.clipIndex) ? event.clipIndex : null,
          ...(Number.isFinite(event.value) && event.value >= 0 ? { value: event.value } : {}),
        };
      });
      const directory = join(PROJECT_ROOT, ".local", "runs", body.sessionId);
      await mkdir(directory, { recursive: true });
      await appendFile(join(directory, "playback.jsonl"), JSON.stringify({ events }) + "\n");
      jsonResponse(response, 200, { ok: true });
    } catch { jsonResponse(response, 400, { ok: false }); }
    return;
  }
  const attackMediaRoute = url.pathname.match(/^\/api\/attack-videos\/([0-9a-f-]{36})\/clips\/([0-3])\.mp4$/i);
  if (attackMediaRoute && ["GET", "HEAD"].includes(request.method)) {
    if (!hasTrustedOrigin(request)) { jsonResponse(response, 403, { ok: false }); return; }
    await handleAttackMedia(request, response, attackMediaRoute[1], Number(attackMediaRoute[2]));
    return;
  }
  const sessionId = attackVideoSessionId(url.pathname);
  if (sessionId && (request.method === "GET" || request.method === "DELETE")) {
    if (!hasTrustedOrigin(request)) {
      jsonResponse(response, 403, { ok: false, error: "不接受跨来源的视频任务请求" });
      return;
    }
    if (request.method === "GET") handleAttackVideoStatus(response, sessionId);
    else handleAttackVideoCancel(response, sessionId);
    return;
  }
  if (request.method === "GET" || request.method === "HEAD") {
    await serveStatic(request, response, url.pathname);
    return;
  }
  response.writeHead(405, { Allow: "GET, HEAD, POST, DELETE" }).end("Method not allowed");
}

export function createAppServer({ sceneService = sceneVideos } = {}) {
  return createHttpServer((request, response) => handleHttpRequest(request, response, sceneService));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAppServer().listen(PORT, "127.0.0.1", () => {
    console.log(`Pocket Battle Lab: http://localhost:${PORT}`);
  });
}
