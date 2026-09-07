export const GPT_DOUG_MODULE_ID = "gpt-doug-llm:pokemonlive";

const FORBIDDEN_ACTIONS = new Set([
  "set-hp",
  "apply-damage",
  "force-hit",
  "force-status",
  "declare-winner",
  "mutate-battle-outcome",
]);

function sanitize(value, depth = 0) {
  if (depth > 6) return "[max-depth]";
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 128).map(item => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 128)) {
      if (typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") continue;
      output[String(key).slice(0, 120)] = sanitize(child, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function createGptDougContext({ battle, events = [], language = "en", source = "pokemonlive" } = {}) {
  if (!battle || typeof battle !== "object" || Array.isArray(battle)) {
    throw new TypeError("battle context must be an object");
  }

  return Object.freeze({
    schemaVersion: 1,
    moduleId: GPT_DOUG_MODULE_ID,
    source,
    language: String(language || "en").slice(0, 16),
    authority: Object.freeze({
      battleOutcome: "rules-engine",
      agent: "presentation-orchestration-only",
      readOnly: true,
    }),
    battle: sanitize(battle),
    events: sanitize(events),
    capabilities: Object.freeze([
      "battle-context-read",
      "presentation-orchestration",
      "storyboard-context",
      "media-pipeline-observability",
    ]),
  });
}

export function assertGptDougAction(action) {
  const type = String(action?.type || "").trim().toLowerCase();
  if (!type) throw new TypeError("GPT-DOUG action type is required");
  if (FORBIDDEN_ACTIONS.has(type)) {
    const error = new Error(`GPT-DOUG action '${type}' is outside presentation authority`);
    error.code = "GPT_DOUG_ACTION_DENIED";
    throw error;
  }
  return Object.freeze({ ...sanitize(action), type });
}

export function gptDougHealth() {
  return Object.freeze({
    ok: true,
    moduleId: GPT_DOUG_MODULE_ID,
    mode: "read-only-battle-context",
    battleAuthority: "rules-engine",
  });
}
