import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { MOVES, SPECIES } from "./data.js";
import { LANGUAGES, normalizeLanguage, localizedSpeech } from "./language.js";

export const SPEECH_VOICE = "Chinese (Mandarin)_Straightforward_Boy";
export const SPEECH_MODEL = "speech-2.8-turbo";
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const settings = {
  model: SPEECH_MODEL, language_boost: "Chinese",
  voice_setting: { voice_id: SPEECH_VOICE, speed: 1.1, vol: 1.3, pitch: 2, emotion: "happy" },
  audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
};
const species = Object.values(SPECIES);
const allowedText = new Set(["对手准备出招！"]);
for (const pokemon of species) {
  for (const move of [...pokemon.moveIds, "struggle"]) allowedText.add(`${pokemon.name}，使用${MOVES[move].name}！`);
  for (const incoming of species) allowedText.add(`回来吧，${pokemon.name}！去吧，${incoming.name}！`);
}

export function speechSpec(text, language = "zh") {
  language = normalizeLanguage(language);
  if (typeof text !== "string" || !allowedText.has(text)) {
    throw Object.assign(new Error("只接受游戏内的喊招和我方换人台词"), { statusCode: 400 });
  }
  const localized = localizedSpeech(text, language);
  const localizedSettings = { ...settings, language_boost: LANGUAGES[language].boost,
    voice_setting: { ...settings.voice_setting, voice_id: LANGUAGES[language].voice } };
  return { sourceText: text, text: localized, language, settings: localizedSettings,
    key: createHash("sha256").update(JSON.stringify({ version: 1, ...localizedSettings, text: localized })).digest("hex") };
}

// Only the server connects to MiniMax. No key, upstream error body, or remote
// audio URL is exposed to the browser. One short line is one bounded WS task.
export function synthesizeSpeech(text, apiKey, { connect = (url, options) => new WebSocket(url, options), timeoutMs = 15000, language = "zh" } = {}) {
  const spec = speechSpec(text, language);
  if (!apiKey) return Promise.reject(Object.assign(new Error("MINIMAX_TTS_KEY_MISSING"), { statusCode: 503 }));
  return new Promise((resolve, reject) => {
    const start = performance.now(), chunks = [];
    let socket, settled = false, phase = "connecting", size = 0, firstAudioMs = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) { if (error) socket.terminate(); else socket.close(); }
      if (error) reject(error);
      else resolve({ bytes: Buffer.concat(chunks), timings: { firstAudioMs, totalMs: Math.round(performance.now() - start) } });
    };
    const fail = code => finish(new Error(code));
    const timer = setTimeout(() => fail("MINIMAX_TTS_TIMEOUT"), timeoutMs);
    try {
      socket = connect("wss://api.minimax.cn/ws/v1/t2a_v2", {
        headers: { Authorization: `Bearer ${apiKey}` }, followRedirects: false,
        handshakeTimeout: timeoutMs, maxPayload: MAX_AUDIO_BYTES * 2 + 65536,
      });
      socket.on("error", () => fail("MINIMAX_TTS_CONNECTION_FAILED"));
      socket.on("close", () => { if (!settled) fail("MINIMAX_TTS_INCOMPLETE"); });
      socket.on("message", raw => {
        if (settled) return;
        try {
          const event = JSON.parse(raw.toString());
          const code = event.base_resp?.status_code;
          if ((code !== undefined && code !== 0) || event.event === "task_failed") {
            fail(`MINIMAX_TTS_REJECTED_${Number.isInteger(code) ? code : "UNKNOWN"}`); return;
          }
          if (event.event === "connected_success" && phase === "connecting") {
            phase = "starting";
            socket.send(JSON.stringify({ event: "task_start", ...spec.settings }));
          } else if (event.event === "task_started" && phase === "starting") {
            phase = "receiving";
            socket.send(JSON.stringify({ event: "task_continue", text: spec.text }));
            // The documented finish command drains pending synthesis before
            // returning task_finished. Never publish a truncated partial MP3.
            socket.send(JSON.stringify({ event: "task_finish" }));
          }
          if (event.data?.audio) {
            const hex = event.data.audio;
            if (phase !== "receiving" || typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(hex)) {
              fail("MINIMAX_TTS_INVALID_AUDIO"); return;
            }
            size += hex.length / 2;
            if (size > MAX_AUDIO_BYTES) { fail("MINIMAX_TTS_TOO_LARGE"); return; }
            firstAudioMs ??= Math.round(performance.now() - start);
            chunks.push(Buffer.from(hex, "hex"));
          }
          if (event.event === "task_finished") {
            if (phase !== "receiving" || !size) fail("MINIMAX_TTS_EMPTY_AUDIO");
            else finish();
          }
        } catch { fail("MINIMAX_TTS_INVALID_RESPONSE"); }
      });
    } catch { fail("MINIMAX_TTS_CONNECTION_FAILED"); }
  });
}

async function writeAudio(path, bytes) {
  await writeFile(`${path}.part`, bytes);
  await rename(`${path}.part`, path);
}

export class SpeechCache {
  constructor({ directory, synthesize = synthesizeSpeech, writeArtifact = writeAudio }) {
    this.directory = directory;
    this.synthesize = synthesize;
    this.writeArtifact = writeArtifact;
    this.pending = new Map();
    this.unarchived = new Map();
  }

  async get(text, loadKey, language = "zh") {
    const spec = speechSpec(text, language);
    if (this.pending.has(spec.key)) return this.pending.get(spec.key);
    // Includes disk reads, so concurrent identical cold requests cannot both
    // miss the file and buy the same line twice.
    if (this.pending.size >= 2) throw Object.assign(new Error("MINIMAX_TTS_BUSY"), { statusCode: 429 });
    if (!this.unarchived.has(spec.key) && this.unarchived.size + this.pending.size >= 4) {
      throw Object.assign(new Error("MINIMAX_TTS_CACHE_FULL"), { statusCode: 503 });
    }
    const pending = this.load(spec, loadKey).finally(() => this.pending.delete(spec.key));
    this.pending.set(spec.key, pending);
    return pending;
  }

  async load(spec, loadKey) {
    const path = join(this.directory, `${spec.key}.mp3`);
    if (this.unarchived.has(spec.key)) {
      const result = this.unarchived.get(spec.key);
      await this.archive(spec, result, path);
      return { ...spec, ...result, cached: true };
    }
    try {
      const bytes = await readFile(path);
      if (bytes.length && bytes.length <= MAX_AUDIO_BYTES) return { ...spec, bytes, cached: true };
    } catch (error) { if (error.code !== "ENOENT") throw new Error("MINIMAX_TTS_CACHE_READ_FAILED"); }
    // Check directory access before spending. Retain successful bytes if the
    // later disk write fails; retries archive them, never buy the line again.
    await mkdir(this.directory, { recursive: true });
    const result = await this.synthesize(spec.sourceText, await loadKey(), { language: spec.language });
    this.unarchived.set(spec.key, result);
    await this.archive(spec, result, path);
    return { ...spec, ...result, cached: false };
  }

  async archive(spec, result, path) {
    try {
      await this.writeArtifact(path, result.bytes);
      await writeFile(join(this.directory, `${spec.key}.json`), JSON.stringify({ ...spec, ...spec.settings, timings: result.timings }));
      this.unarchived.delete(spec.key);
    } catch { result.archiveWarning = true; }
  }
}
