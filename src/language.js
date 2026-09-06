export const LANGUAGES = Object.freeze({
  zh: { label: "中文", html: "zh-CN", name: "Mandarin Chinese", boost: "Chinese", voice: "Chinese (Mandarin)_Straightforward_Boy" },
  en: { label: "English", html: "en", name: "English", boost: "English", voice: "English_Trustworthy_Man" },
  ja: { label: "日本語", html: "ja", name: "Japanese", boost: "Japanese", voice: "Japanese_OptimisticYouth" },
});

export function normalizeLanguage(value = "zh") {
  if (typeof value !== "string" || !Object.hasOwn(LANGUAGES, value)) throw Object.assign(new TypeError("Unsupported language"), { statusCode: 400 });
  return value;
}

// Canonical IDs and battle facts never change with the presentation language.
export const NAMES = {
  "皮卡丘": ["Pikachu", "ピカチュウ"], "杰尼龟": ["Squirtle", "ゼニガメ"], "妙蛙种子": ["Bulbasaur", "フシギダネ"],
  "小火龙": ["Charmander", "ヒトカゲ"], "快龙": ["Dragonite", "カイリュー"], "耿鬼": ["Gengar", "ゲンガー"],
  "小拳石": ["Geodude", "イシツブテ"], "鬼斯": ["Gastly", "ゴース"],
  "十万伏特": ["Thunderbolt", "10まんボルト"], "电光一闪": ["Quick Attack", "でんこうせっか"],
  "电磁波": ["Thunder Wave", "でんじは"], "铁尾": ["Iron Tail", "アイアンテール"], "龙爪": ["Dragon Claw", "ドラゴンクロー"],
  "水枪": ["Water Gun", "みずでっぽう"], "撞击": ["Tackle", "たいあたり"], "摇尾巴": ["Tail Whip", "しっぽをふる"],
  "冰冻光束": ["Ice Beam", "れいとうビーム"], "飞叶快刀": ["Razor Leaf", "はっぱカッター"],
  "催眠粉": ["Sleep Powder", "ねむりごな"], "生长": ["Growth", "せいちょう"], "火花": ["Ember", "ひのこ"],
  "抓": ["Scratch", "ひっかく"], "叫声": ["Growl", "なきごえ"], "烟幕": ["Smokescreen", "えんまく"],
  "落石": ["Rock Throw", "いわおとし"], "变圆": ["Defense Curl", "まるくなる"], "重踏": ["Bulldoze", "じならし"],
  "暗影球": ["Shadow Ball", "シャドーボール"], "舌舔": ["Lick", "したでなめる"],
  "催眠术": ["Hypnosis", "さいみんじゅつ"], "奇异之光": ["Confuse Ray", "あやしいひかり"], "挣扎": ["Struggle", "わるあがき"],
  "伤药": ["Potion", "キズぐすり"], "万灵药": ["Full Heal", "なんでもなおし"],
  "露营少年 阿岚": ["Camper Aran", "キャンプボーイのアラン"], "青叶": ["Aoba", "アオバ"],
};

export function localizedName(name, language = "zh") {
  normalizeLanguage(language);
  return language === "zh" ? name : NAMES[name]?.[language === "en" ? 0 : 1] ?? name;
}

export function localizedSpeech(text, language = "zh") {
  normalizeLanguage(language);
  if (language === "zh") return text;
  const name = value => localizedName(value, language);
  let match = text.match(/^(.+)，使用(.+)！$/);
  if (match) return language === "en" ? `${name(match[1])}, use ${name(match[2])}!` : `${name(match[1])}、${name(match[2])}！`;
  match = text.match(/^回来吧，(.+)！去吧，(.+)！$/);
  if (match) return language === "en" ? `Come back, ${name(match[1])}! Go, ${name(match[2])}!` : `戻れ、${name(match[1])}！いけ、${name(match[2])}！`;
  if (text === "对手准备出招！") return language === "en" ? "The opponent is ready!" : "相手が動くぞ！";
  return text;
}

export function videoLanguageDirection(language = "zh") {
  const locale = LANGUAGES[normalizeLanguage(language)];
  const names = Object.entries(NAMES).slice(0, 8).map(([zh, values]) => `${values[0]} = ${localizedName(zh, language)}`).join("; ");
  return `OUTPUT AUDIO LANGUAGE: ${locale.name} (${language}). Any permitted spoken dialogue or name-based creature calls must use ONLY ${locale.name}, with natural native pronunciation. Localized creature names: ${names}. Do not copy the language of a reference soundtrack. This is a language constraint, NOT permission to add dialogue: preserve every no-speech, no-narration, no-answering-cry and incapacitated-state instruction. Keep UI, written text and subtitles out of the generated picture.`;
}
