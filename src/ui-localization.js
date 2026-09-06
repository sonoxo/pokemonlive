import { LANGUAGES, NAMES, normalizeLanguage, localizedSpeech } from "./language.js";
import { STAT_NAMES, STATUS_NAMES } from "./data.js";

// Presentation strings only: battle-engine events remain canonical for the
// storyboard's status/effect interpretation and saved factual records.
export const UI_TEXT = {
  ...NAMES,
  "语言": ["Language", "言語"], "演出期间暂不可切换语言": ["Language can be changed between turns", "演出が終わってから言語を変更できます"],
  "战斗动画": ["Battle animation", "バトル動画"], "战斗动画续段": ["Next battle clip", "次のバトル動画"], "战斗动画预备": ["Buffered battle clip", "準備中のバトル動画"],
  "训练家喊招剪影": ["Trainer command silhouette", "指示するトレーナーのシルエット"], "训练家举球剪影": ["Trainer recall silhouette", "ボールを構えるトレーナーのシルエット"],
  "生成提示词（原文）": ["Generation prompt (original)", "生成プロンプト（原文）"],
  "口袋对战实验室": ["Pocket Battle Lab", "ポケットバトルラボ"],
  "POCKET BATTLE LAB / 冒险，从这里开始": ["POCKET BATTLE LAB / Your adventure starts here", "POCKET BATTLE LAB / ここから始まる冒険"],
  "AI 分镜": ["AI Storyboard", "AI 絵コンテ"], "规则说明": ["Rules", "ルール"], "重新对战": ["New Battle", "最初から"],
  "宝可梦像素 2D 单打对战": ["Pokémon 2D single battle", "ポケモン 2D シングルバトル"],
  "对手队伍状态": ["Opponent team", "相手の手持ち"], "我方队伍状态": ["Your team", "自分の手持ち"],
  "雄性": ["Male", "オス"], "雌性": ["Female", "メス"], "等待指令": ["Awaiting orders", "指示待ち"],
  "战斗播报": ["Battle log", "バトル実況"], "战斗指令": ["Battle commands", "バトルコマンド"], "查看战斗记录": ["Battle history", "バトル履歴"],
  "选择指令": ["Choose an action", "行動を選ぶ"], "战斗": ["Fight", "たたかう"], "选择招式": ["Choose a move", "わざを選ぶ"],
  "宝可梦": ["Pokémon", "ポケモン"], "替换队员": ["Switch Pokémon", "ポケモンを交代"], "背包": ["Bag", "バッグ"],
  "使用道具": ["Use an item", "どうぐを使う"], "逃跑": ["Run", "にげる"], "训练家对战": ["Trainer battle", "トレーナー戦"],
  "返回主指令": ["Back to actions", "コマンドに戻る"], "快捷键 1–4": ["Shortcuts 1–4", "ショートカット 1–4"],
  "选择宝可梦": ["Choose a Pokémon", "ポケモンを選ぶ"], "替换会消耗回合": ["Switching uses a turn", "交代で1ターン消費"],
  "道具先于招式结算": ["Items act before moves", "どうぐはわざより先に使用"], "再来一场": ["Battle again", "もう一度"],
  "TAB 选择 · 1–4 快捷指令 · ESC 返回": ["TAB Select · 1–4 Actions · ESC Back", "TAB 選択 · 1–4 コマンド · ESC 戻る"],
  "Lv.50 · IV 31 · EV 0 · 无特性": ["Lv.50 · IV 31 · EV 0 · No abilities", "Lv.50 · 個体値31 · 努力値0 · 特性なし"],
  "仅限本地非商业学习与规则验证。实时战场使用本地像素 2D 精灵； 宝可梦角色、名称及图像权利归其权利人所有。": ["For local, non-commercial learning and rules testing only. The fallback battlefield uses local 2D pixel sprites. Pokémon characters, names and images belong to their respective rights holders.", "ローカルでの非商用学習・ルール検証用です。代替表示には2Dドット絵を使用します。ポケモンのキャラクター・名称・画像の権利は各権利者に帰属します。"],
  "本次实现的规则范围": ["Implemented battle rules", "実装済みのバトルルール"], "关闭规则说明": ["Close rules", "ルールを閉じる"],
  "已经实现": ["Included", "実装済み"], "本原型不包含": ["Not included", "未実装"],
  "属性一致加成（STAB）与 18 属性相克": ["STAB and all 18 type matchups", "タイプ一致補正と18タイプの相性"],
  "物理 / 特殊伤害、85–100 随机数与要害": ["Physical/special damage, 85–100 rolls and critical hits", "物理・特殊ダメージ、85–100の乱数、急所"],
  "命中 / 闪避、能力阶级 −6 至 +6": ["Accuracy/evasion and stat stages from −6 to +6", "命中・回避、能力ランク−6から+6"],
  "速度、招式优先度、同速随机": ["Speed, move priority and random speed ties", "素早さ、わざの優先度、同速時のランダム順"],
  "麻痹、灼伤、中毒、睡眠、冰冻与混乱": ["Paralysis, burn, poison, sleep, freeze and confusion", "まひ・やけど・どく・ねむり・こおり・こんらん"],
  "PP、挣扎、换人、道具、濒死与胜负": ["PP, Struggle, switching, items, fainting and battle results", "PP、わるあがき、交代、どうぐ、ひんし、勝敗"],
  "特性、性格、努力值分配与持有物": ["Abilities, natures, EV training and held items", "特性、性格、努力値配分、もちもの"],
  "天气、场地、太晶化与双打目标规则": ["Weather, terrain, Terastallization and double battles", "天候、フィールド、テラスタル、ダブルバトル"],
  "完整招式库、联网匹配与存档": ["Full move library, online matchmaking and saves", "全わざ、オンライン対戦、セーブ"],
  "规则基准采用现代世代的核心单打逻辑；数值固定为等级 50、个体值 31、努力值 0、中性性格。 实时战场为本地像素 2D 表现，AI 生成的攻击视频不参与规则结算。": ["Based on modern-generation singles: level 50, IV 31, EV 0, neutral nature. The local engine decides all results; AI battle videos only visualize them.", "現代世代のシングルバトルを基準に、レベル50・個体値31・努力値0・無補正性格で計算します。結果はローカルエンジンが確定し、AI動画は演出のみを担当します。"],
  "AI 联合战斗分镜": ["AI Battle Storyboard", "AI バトル絵コンテ"], "关闭 AI 分镜": ["Close storyboard", "絵コンテを閉じる"],
  "还没有分镜记录": ["No storyboard yet", "絵コンテはまだありません"],
  "发动招式后，这里会把双方行动合成为一条连续时间线。": ["Use a move to view both sides on one continuous timeline.", "わざを選ぶと、双方の行動を一つのタイムラインにまとめます。"],
  "发动招式后，这里会显示输入事实、镜头节拍与生成耗时。": ["After a move, view battle facts, shot timing and generation latency here.", "わざを使うと、バトルの事実・カット構成・生成時間が表示されます。"],
  "查看结构化 JSON": ["View raw JSON", "生のJSONを見る"],
  "联合分镜会通过服务端正式提交至 fal H3 Max Turbo，并产生实际视频费用。战斗结果仍由本地规则引擎锁定；AI 只负责镜头表现。": ["Storyboards are submitted to fal H3 Max Turbo and incur real video-generation charges. Battle results are fixed by the local rules engine; AI only directs the visuals.", "絵コンテはサーバーからfal H3 Max Turboへ送信され、動画生成料金が発生します。結果はローカルのルールエンジンが確定し、AIは映像演出のみを担当します。"],
  "一": ["N", "ノ"], "无属性": ["Typeless", "タイプなし"], "一般": ["Normal", "ノーマル"], "火": ["Fire", "ほのお"], "水": ["Water", "みず"],
  "电": ["Electric", "でんき"], "草": ["Grass", "くさ"], "冰": ["Ice", "こおり"], "格斗": ["Fighting", "かくとう"],
  "毒": ["Poison", "どく"], "地面": ["Ground", "じめん"], "飞行": ["Flying", "ひこう"], "超能力": ["Psychic", "エスパー"],
  "虫": ["Bug", "むし"], "岩石": ["Rock", "いわ"], "幽灵": ["Ghost", "ゴースト"], "龙": ["Dragon", "ドラゴン"],
  "恶": ["Dark", "あく"], "钢": ["Steel", "はがね"], "妖精": ["Fairy", "フェアリー"],
  "灼伤": ["Burn", "やけど"], "中毒": ["Poisoned", "どく"], "麻痹": ["Paralyzed", "まひ"], "睡眠": ["Asleep", "ねむり"],
  "冰冻": ["Frozen", "こおり"], "混乱": ["Confused", "こんらん"], "混乱自伤": ["Confusion damage", "こんらんで自傷"],
  "攻击": ["Attack", "攻撃"], "防御": ["Defense", "防御"], "特攻": ["Sp. Atk", "特攻"], "特防": ["Sp. Def", "特防"],
  "速度": ["Speed", "素早さ"], "命中": ["Accuracy", "命中"], "闪避": ["Evasion", "回避"],
  "物理": ["Physical", "物理"], "特殊": ["Special", "特殊"], "变化": ["Status", "変化"], "变化招式": ["Status move", "変化わざ"],
  "招式发动": ["Move", "わざ発動"], "伤害结算": ["Damage", "ダメージ"], "招式落空": ["Miss", "わざ失敗"],
  "状态变化": ["Condition changed", "状態変化"], "能力变化": ["Stats changed", "能力変化"], "行动受阻": ["Unable to move", "行動不能"],
  "替换上场": ["Switching in", "交代"], "体力回复": ["HP restored", "HP回復"], "失去战斗能力": ["Fainted", "ひんし"],
  "对战结束": ["Battle over", "バトル終了"], "战况播报": ["Battle update", "バトル実況"], "训练家指令": ["Trainer command", "トレーナーの指示"],
  "完整演出": ["Complete action", "一連の演出"], "决定性铺垫": ["Anticipation", "予備動作"], "命中与收束": ["Impact and reaction", "命中と余韻"],
  "状态阻止出招": ["Status blocks move", "状態で行動不能"], "攻击方 3/4 机位": ["Attacker 3/4 view", "攻撃側の斜め視点"],
  "侧向跟拍": ["Side tracking", "横移動の追従"], "目标近景": ["Target close-up", "対象のアップ"], "战场全景": ["Battlefield wide", "戦場の全景"],
  "大特写": ["Extreme close-up", "極端なアップ"], "近景": ["Close-up", "アップ"], "中景": ["Medium", "ミディアム"], "远景": ["Wide", "ロング"], "大全景": ["Extreme wide", "超ロング"],
  "等待 DeepSeek": ["Waiting for DeepSeek", "DeepSeek待機中"], "本地安全降级": ["Local fallback", "ローカル代替"], "规划中": ["Planning", "構成中"],
  "双方联合分镜": ["Shared battle storyboard", "双方共通の絵コンテ"], "联合战斗分镜 · 双角色同镜": ["Battle storyboard · shared scene", "バトル絵コンテ · 同じシーン"],
  "双角色同一场景": ["Both combatants in one scene", "双方を同じシーンに"],
  "正在把双方行动合成为一条连续时间线……": ["Combining both sides into a continuous timeline…", "双方の行動を一つのタイムラインに構成中…"],
  "正在生成双方共用的连续镜头序列……": ["Preparing continuous shots for both combatants…", "双方共通の連続カットを生成中…"],
  "AI 导演": ["AI Director", "AI 演出"], "正在规划": ["Planning", "構成中"], "本地降级": ["Local fallback", "ローカル代替"], "待机": ["Idle", "待機"],
  "实时分镜预算 3 秒已到，使用按战斗事实编排的本地镜头。": ["The 3-second planning budget was reached. Using local shots based on the actual battle results.", "構成の制限時間3秒に達しました。バトルの事実に基づくローカル絵コンテを使用します。"],
  "本地分镜网关不可用，已在浏览器内生成安全降级分镜。": ["The storyboard gateway is unavailable. Using a browser-generated fallback.", "絵コンテのゲートウェイに接続できません。ブラウザー内の代替構成を使用します。"],
  "声音开启": ["Sound on", "音声オン"], "声音关闭": ["Sound off", "音声オフ"], "点击开启声音": ["Enable sound", "音声を有効にする"],
  "关闭战斗动画声音": ["Mute battle audio", "バトル音声を消す"], "开启战斗动画声音": ["Unmute battle audio", "バトル音声を出す"],
  "声": ["♪", "音"], "跳过动画": ["Skip animation", "演出をスキップ"], "正在准备战斗演出": ["Preparing battle animation", "バトル演出を準備中"],
  "无法行动": ["Unable to move", "動けない"], "交战中": ["In battle", "交戦中"], "连续战斗演出": ["Continuous battle animation", "連続バトル演出"],
  "保持尾帧，后续镜头就绪后续播": ["Holding the final frame until the next clip is ready", "次の動画が完成するまで最終フレームを保持"],
  "战斗收尾": ["Battle recovery", "バトルの締め"], "保持最后画面，收尾就绪后继续": ["Holding the last frame while the closing shot loads", "締めの動画が完成するまで最終画面を保持"],
  "保留战后状态，回到双方同框": ["Back to a shared view, preserving post-battle conditions", "戦闘後の状態を保ち、双方が映る構図へ"],
  "动画中断 · 已保留战斗结果": ["Animation interrupted · battle result preserved", "演出中断 · バトル結果は保持"],
  "收回宝可梦": ["Recalling Pokémon", "ポケモンを戻す"], "准备收回演出，可跳过": ["Preparing recall · can be skipped", "戻す演出を準備中 · スキップ可能"],
  "放出动画正在后台生成": ["Send-out animation is generating in the background", "登場動画をバックグラウンドで生成中"],
  "放出宝可梦": ["Sending out Pokémon", "ポケモンを繰り出す"], "新阵容待机、听令与收回素材正在后台准备": ["Preparing the new team's idle, response and recall clips", "新しい組み合わせの待機・応答・回収動画を準備中"],
  "登场动画未就绪 · 使用本地战场": ["Entrance not ready · using local battlefield", "登場動画が未完成 · ローカル表示を使用"],
  "可战斗": ["Ready", "戦闘可能"], "已倒下": ["Fainted", "ひんし"], "已经失去战斗能力": ["Already fainted", "すでにひんし"],
  "正在战斗": ["In battle", "戦闘中"], "上场中": ["Active", "場に出ている"], "无法战斗": ["Fainted", "戦闘不能"], "自动发动": ["Automatic", "自動発動"],
  "无效": ["No effect", "効果なし"], "效果绝佳": ["Super effective", "効果抜群"], "效果不佳": ["Not very effective", "効果はいまひとつ"],
  "对战胜利": ["Victory!", "勝利！"], "这次惜败": ["Defeat", "敗北"], "同时倒下": ["A draw", "引き分け"],
  "属性判断与队伍轮换都很漂亮。": ["Great type choices and team rotations.", "相性判断と交代が見事でした。"],
  "调整出招与换人时机，再挑战一次。": ["Adjust your moves and switches, then try again.", "わざや交代のタイミングを見直して、もう一度挑戦！"],
  "双方都拼到了最后一刻，本场对战平局。": ["Both sides fought to the end. It's a draw.", "双方が最後まで戦い抜き、引き分けになりました。"],
  "请选择下一只能够战斗的宝可梦。": ["Choose your next battle-ready Pokémon.", "次に戦えるポケモンを選んでください。"], "必须替换": ["Switch required", "交代が必要"],
  "训练家对战中不能逃跑！": ["You can't run from a Trainer battle!", "トレーナー戦からは逃げられない！"],
  "没有效果……": ["It had no effect…", "効果がないようだ…"], "效果绝佳！": ["It's super effective!", "効果は抜群だ！"],
  "效果不理想……": ["It's not very effective…", "効果はいまひとつのようだ…"], "击中了要害！": ["A critical hit!", "急所に当たった！"],
  "现在无法替换为这只宝可梦。": ["You can't switch to that Pokémon now.", "今はそのポケモンに交代できません。"],
  "这个道具现在无法使用。": ["You can't use that item now.", "今はそのどうぐを使えません。"],
  "双方已经没有可战斗的宝可梦，本场对战平局。": ["Neither side has a Pokémon left. It's a draw.", "双方とも戦えるポケモンがいないため、引き分けです。"],
  "露营少年 阿岚 已经没有可战斗的宝可梦了。你赢得了对战！": ["Camper Aran has no Pokémon left. You won!", "キャンプボーイのアランには戦えるポケモンがいない。あなたの勝利！"],
  "你的宝可梦全部倒下了……": ["All your Pokémon have fainted…", "手持ちのポケモンが全員倒れた…"],
  "双方同时倒下；依据反作用力判定，你赢得了对战！": ["Both sides fainted. The recoil rule awards you the win!", "双方同時に倒れた。反動の判定により、あなたの勝利！"],
  "双方同时倒下；依据反作用力判定，对手赢得了对战。": ["Both sides fainted. The recoil rule awards the opponent the win.", "双方同時に倒れた。反動の判定により、相手の勝利。"],
  "回复一只宝可梦 20 点 HP。": ["Restores 20 HP to a Pokémon.", "ポケモン1匹のHPを20回復。"], "治愈异常状态与混乱。": ["Cures status conditions and confusion.", "状態異常とこんらんを治す。"],
  "有 10% 几率使目标麻痹。": ["10% chance to paralyze the target.", "10%の確率で相手をまひにする。"],
  "优先度 +1，通常会先出手。": ["Priority +1; usually moves first.", "優先度+1。通常は先に攻撃する。"],
  "使目标麻痹。地面属性免疫。": ["Paralyzes the target. Ground types are immune.", "相手をまひにする。じめんタイプには無効。"],
  "有 30% 几率降低目标防御。": ["30% chance to lower Defense.", "30%の確率で相手の防御を下げる。"],
  "用锋利的巨爪劈开目标。": ["Slashes the target with sharp claws.", "鋭い爪で相手を切り裂く。"],
  "向目标喷射水流。": ["Shoots a stream of water.", "水を勢いよく発射する。"], "用整个身体撞向目标。": ["Tackles with the whole body.", "全身で相手にぶつかる。"],
  "令目标防御降低 1 级。": ["Lowers the target's Defense by one stage.", "相手の防御を1段階下げる。"],
  "有 10% 几率使目标冰冻。": ["10% chance to freeze the target.", "10%の確率で相手をこおりにする。"], "容易击中要害。": ["High critical-hit ratio.", "急所に当たりやすい。"],
  "使目标陷入 1–3 回合的睡眠。草属性免疫粉末。": ["Puts the target to sleep for 1–3 turns. Grass types are immune to powder.", "相手を1〜3ターン眠らせる。くさタイプには粉が効かない。"],
  "令自己的攻击与特攻各提高 1 级。": ["Raises the user's Attack and Sp. Atk by one stage.", "自分の攻撃と特攻を1段階ずつ上げる。"],
  "有 10% 几率使目标灼伤。": ["10% chance to burn the target.", "10%の確率で相手をやけどにする。"], "用锋利的爪子攻击。": ["Attacks with sharp claws.", "鋭い爪で攻撃する。"],
  "令目标攻击降低 1 级。": ["Lowers the target's Attack by one stage.", "相手の攻撃を1段階下げる。"], "令目标命中降低 1 级。": ["Lowers the target's accuracy by one stage.", "相手の命中を1段階下げる。"],
  "投掷岩石攻击目标。": ["Throws rocks at the target.", "岩を投げて攻撃する。"], "令自己的防御提高 1 级。": ["Raises the user's Defense by one stage.", "自分の防御を1段階上げる。"],
  "命中后令目标速度降低 1 级。": ["Lowers the target's Speed by one stage on hit.", "命中すると相手の素早さを1段階下げる。"],
  "有 20% 几率降低目标特防。": ["20% chance to lower Sp. Def.", "20%の確率で相手の特防を下げる。"], "有 30% 几率使目标麻痹。": ["30% chance to paralyze.", "30%の確率で相手をまひにする。"],
  "使目标陷入 1–3 回合的睡眠。": ["Puts the target to sleep for 1–3 turns.", "相手を1〜3ターン眠らせる。"], "使目标混乱 2–5 回合。": ["Confuses the target for 2–5 turns.", "相手を2〜5ターンこんらんさせる。"],
  "没有可用招式时使出，并承受最大 HP 1/4 的反作用力。": ["Used when no moves remain. Recoil costs 1/4 of maximum HP.", "使えるわざがない時に発動し、最大HPの1/4の反動を受ける。"],
  "自我强化": ["Self boost", "自己強化"], "倒下": ["Fainted", "ひんし"], "攻击方倒下": ["Attacker fainted", "攻撃側がひんし"],
  "MISS": ["MISS", "外れ"], "IMMUNE": ["IMMUNE", "無効"], "STATUS": ["STATUS", "状態"], "STAT": ["STAT", "能力"], "STAT MAX": ["STAT MAX", "能力上限"], "NO EFFECT": ["NO EFFECT", "効果なし"],
};

const rules = [
  [/^DeepSeek 分镜不可用（(.+)），已使用确定性本地分镜。$/, m => [`DeepSeek storyboard unavailable (${m[1]}). Using deterministic local shots.`, `DeepSeekの絵コンテを利用できません（${m[1]}）。ローカルの確定構成を使用します。`]],
  [/^(.+)，本次招式未能使出$/, (m, t) => [`${t(m[1])}: the move could not be used`, `${t(m[1])}のため、わざを出せなかった`]],
  [/^正在把 (.+) 合成为双方共用的连续分镜……$/, (m, t) => [`Planning a shared sequence for ${m[1].split("、").map(t).join(", ")}…`, `${m[1].split("、").map(t).join("・")}を連続カットに構成中…`]],
  [/^(\d+) 镜$/, m => [`${m[1]} shots`, `${m[1]}カット`]],
  [/^(\d+) CLIPS$/, m => [`${m[1]} CLIPS`, `${m[1]}本`]],
  [/^同步点 (.+)$/, m => [`Sync ${m[1]}`, `同期 ${m[1]}`]],
  [/^解除(.+)$/, (m, t) => [`Cured: ${t(m[1])}`, `${t(m[1])}が解除`]],
  [/^(自伤|反伤) (.+)$/, m => [`${m[1] === "自伤" ? "Self damage" : "Recoil"} ${m[2]}`, `${m[1] === "自伤" ? "自傷" : "反動"} ${m[2]}`]],
  [/^要让(.+)做什么？$/, (m, t) => [`What should ${t(m[1])} do?`, `${t(m[1])}はどうする？`]],
  [/^(.+)，使用(.+)！$/, (m, t) => [`${t(m[1])}, use ${t(m[2])}!`, `${t(m[1])}、${t(m[2])}！`]],
  [/^回来吧，(.+)！去吧，(.+)！$/, (m, t) => [`Come back, ${t(m[1])}! Go, ${t(m[2])}!`, `戻れ、${t(m[1])}！いけ、${t(m[2])}！`]],
  [/^(.+)使用了(.+)！$/, (m, t) => [`${t(m[1])} used ${t(m[2])}!`, `${t(m[1])}は${t(m[2])}を使った！`]],
  [/^去吧，(.+)！$/, (m, t) => [`Go, ${t(m[1])}!`, `いけ、${t(m[1])}！`]],
  [/^(.+?)\s*向你发起了挑战！$/, (m, t) => [`${t(m[1])} challenges you!`, `${t(m[1])}が勝負をしかけてきた！`]],
  [/^(.+)派出了(.+)！$/, (m, t) => [`${t(m[1])} sent out ${t(m[2])}!`, `${t(m[1])}は${t(m[2])}を繰り出した！`]],
  [/^(.+)受到了 (\d+) 点伤害！$/, (m, t) => [`${t(m[1])} took ${m[2]} damage!`, `${t(m[1])}は${m[2]}のダメージを受けた！`]],
  [/^(.+)回复了 (\d+) 点 HP！$/, (m, t) => [`${t(m[1])} restored ${m[2]} HP!`, `${t(m[1])}のHPが${m[2]}回復した！`]],
  [/^(.+)陷入了(.+)状态！$/, (m, t) => [`${t(m[1])} is now ${t(m[2]).toLowerCase()}!`, `${t(m[1])}は${t(m[2])}になった！`]],
  [/^(.+)的(.+)已经(无法再提高|无法再降低)了！$/, (m, t) => [`${t(m[1])}'s ${t(m[2])} can't go ${m[3] === "无法再提高" ? "higher" : "lower"}!`, `${t(m[1])}の${t(m[2])}はこれ以上${m[3] === "无法再提高" ? "上がらない" : "下がらない"}！`]],
  [/^(.+)的(.+?)(大幅)?(提高|降低)了！$/, (m, t) => [`${t(m[1])}'s ${t(m[2])} ${m[4] === "提高" ? "rose" : "fell"}${m[3] ? " sharply" : ""}!`, `${t(m[1])}の${t(m[2])}が${m[3] ? "ぐーんと" : ""}${m[4] === "提高" ? "上がった" : "下がった"}！`]],
  [/^粉末对(.+)没有效果！$/, (m, t) => [`Powder has no effect on ${t(m[1])}!`, `${t(m[1])}には粉の効果がない！`]],
  [/^对(.+)没有效果……$/, (m, t) => [`It has no effect on ${t(m[1])}…`, `${t(m[1])}には効果がないようだ…`]],
  [/^(我方|对手)的(.+)$/, (m, t) => [`${m[1] === "我方" ? "Your" : "Opponent's"} ${t(m[2])}`, `${m[1] === "我方" ? "自分" : "相手"}の${t(m[2])}`]],
  [/^(.+)：(.+)$/, (m, t) => [`${t(m[1])}: ${t(m[2])}`, `${t(m[1])}：${t(m[2])}`]],
  [/^替换为(.+)$/, (m, t) => [`Switch to ${t(m[1])}`, `${t(m[1])}に交代`]],
  [/^第 (\d+) 回合$/, m => [`Turn ${m[1]}`, `${m[1]}ターン目`]],
  [/^威力 (\d+)$/, m => [`Power ${m[1]}`, `威力 ${m[1]}`]],
  [/^首段生成 (.+)$/, m => [`First clip ${m[1]}`, `最初の動画 ${m[1]}`]],
  [/^联合行动 (\d+)$/, m => [`Actions ${m[1]}`, `行動 ${m[1]}`]],
  [/^视频段落 (\d+)$/, m => [`Clips ${m[1]}`, `動画 ${m[1]}`]],
  [/^预计时长 (.+)$/, m => [`Duration ${m[1]}`, `予定時間 ${m[1]}`]],
  [/^连续演出 · (\d+) 段( \+ 收尾)?$/, m => [`Continuous · ${m[1]} clips${m[2] ? " + recovery" : ""}`, `連続演出 · ${m[1]}本${m[2] ? " + 締め" : ""}`]],
  [/^未使出(.+)$/, (m, t) => [`${t(m[1])} not used`, `${t(m[1])}は出せなかった`]],
];

const endings = {
  "睡着了！": ["fell asleep!", "は眠ってしまった！"], "醒来了！": ["woke up!", "は目を覚ました！"],
  "正在熟睡。": ["is fast asleep.", "はぐうぐう眠っている。"], "身上的冰融化了！": ["thawed out!", "の氷が溶けた！"],
  "被冻住，无法行动！": ["is frozen and can't move!", "は凍っていて動けない！"],
  "身体麻痹，无法行动！": ["is fully paralyzed and can't move!", "は体がしびれて動けない！"],
  "的混乱解除了！": ["snapped out of confusion!", "のこんらんが解けた！"], "混乱了！": ["is confused!", "はこんらんした！"],
  "已经混乱了。": ["is already confused.", "はすでにこんらんしている。"], "攻击了自己！": ["hurt itself in confusion!", "は自分を攻撃した！"],
  "倒下了！": ["fainted!", "は倒れた！"], "避开了攻击！": ["avoided the attack!", "は攻撃を避けた！"],
  "无法使出这个招式！": ["can't use this move!", "はこのわざを出せない！"],
  "受到了反作用力伤害！": ["was hurt by recoil!", "は反動のダメージを受けた！"],
  "受到了灼伤伤害！": ["was hurt by its burn!", "はやけどのダメージを受けた！"], "受到了毒素伤害！": ["was hurt by poison!", "はどくのダメージを受けた！"],
  "的体力已经是满的。": ["already has full HP.", "のHPは満タンです。"], "没有需要治愈的异常状态。": ["has no condition to cure.", "には治す状態異常がありません。"],
  "恢复了健康！": ["recovered from its condition!", "は元気になった！"], "已经处于异常状态。": ["already has a status condition.", "はすでに状態異常です。"],
  "不会被灼伤！": ["can't be burned!", "はやけどにならない！"], "不会陷入麻痹！": ["can't be paralyzed!", "はまひにならない！"],
  "不会被冰冻！": ["can't be frozen!", "は凍らない！"], "不会中毒！": ["can't be poisoned!", "はどくにならない！"],
};

export function translateText(value, language = "zh") {
  normalizeLanguage(language);
  if (language === "zh" || typeof value !== "string") return value;
  const text = value.trim().replace(/\s+/g, " "), index = language === "en" ? 0 : 1;
  const t = value => translateText(value, language);
  if (UI_TEXT[text]) return UI_TEXT[text][index];
  const speech = localizedSpeech(text, language);
  if (speech !== text) return speech;
  for (const [pattern, format] of rules) { const match = text.match(pattern); if (match) return format(match, t)[index]; }
  for (const [ending, translated] of Object.entries(endings)) {
    if (text.endsWith(ending)) return `${t(text.slice(0, -ending.length))}${language === "en" ? " " : ""}${translated[index]}`;
  }
  if (text.includes(" · ")) return text.split(" · ").map(t).join(" · ");
  if (/[→⇄]/.test(text)) return text.split(/([→⇄])/).map(part => /^[→⇄]$/.test(part) ? part : t(part)).join(" ");
  const shotTime = text.match(/^([\d.]+–[\d.]+s) (.+)$/);
  if (shotTime) return `${shotTime[1]} ${t(shotTime[2])}`;
  for (const prefix of ["效果绝佳", "效果不佳", "速度"]) if (text.startsWith(prefix + " ")) return t(prefix) + text.slice(prefix.length);
  return value;
}

// Rebuild only the display summary from fixed facts; do not translate or
// mutate the authoritative storyboard that the video engine consumes.
export function localizedTurnSummary(plan, language = "zh") {
  normalizeLanguage(language);
  if (language === "zh") return plan.directorNote;
  const t = value => translateText(value, language), ja = language === "ja";
  const lines = plan.attacks.map((attack, index) => {
    const { outcome, actor, target, move } = attack;
    const details = [];
    if (attack.blockedReason) {
      details.push(`${t(STATUS_NAMES[attack.blockedReason] ?? "混乱")} — ${t("无法行动")}`);
      if (outcome.selfDamage) details.push(`${t("自伤 −" + outcome.selfDamage + " HP")}`);
    } else {
      details.push(outcome.damage > 0 ? `${t(target.name)}: −${outcome.damage} HP` : ja ? "直接ダメージなし" : "No direct damage");
      if (outcome.missed) details.push(t("MISS"));
      else if (outcome.effectiveness === 0) details.push(t("IMMUNE"));
      else if (Number.isFinite(outcome.effectiveness) && outcome.effectiveness !== 1) details.push(`${t(outcome.effectiveness > 1 ? "效果绝佳" : "效果不佳")} ×${outcome.effectiveness}`);
      if (outcome.critical) details.push(t("击中了要害！"));
      if (outcome.status) details.push(`${t(target.name)}: ${t(STATUS_NAMES[outcome.status] ?? outcome.status)}`);
      if (outcome.clearedStatus) details.push(`${t(target.name)}: ${t("解除" + (STATUS_NAMES[outcome.clearedStatus] ?? outcome.clearedStatus))}`);
      for (const change of outcome.statChanges) {
        const subject = change.targetSide === actor.side ? actor : target;
        details.push(`${t(subject.name)} ${t(STAT_NAMES[change.stat] ?? change.stat)} ${change.delta > 0 ? "+" : ""}${change.delta}`);
      }
      if (outcome.recoilDamage) details.push(`${t(actor.name)}: ${t("反伤 −" + outcome.recoilDamage + " HP")}`);
    }
    if (outcome.fainted) details.push(`${t(target.name)}: ${t("已倒下")}`);
    if (outcome.actorFainted) details.push(`${t(actor.name)}: ${t("已倒下")}`);
    return `${index + 1}. ${t(actor.name)} — ${t(move.name)}. ${details.join("; ")}.`;
  });
  return `${ja ? "双方の行動を一つのタイムラインに構成。" : "Both sides share one continuous timeline."} ${lines.join(" ")}`;
}

// The existing renderer emits canonical strings into text nodes. Localize that
// boundary without mutating battle records, interpreting HTML, or translating
// the raw JSON/prompt debugger. Remember source text for lossless switching back.
export function createPageLocalizer(document, initialLanguage = "zh") {
  let language = normalizeLanguage(initialLanguage);
  const originals = new WeakMap();
  function apply(node, field, value, write) {
    let fields = originals.get(node);
    if (!fields) { fields = new Map(); originals.set(node, fields); }
    const previous = fields.get(field);
    const source = previous && previous.output === value ? previous.source : value;
    const output = translateText(source, language);
    fields.set(field, { source, output });
    if (value !== output) write(output);
  }
  function visit(node) {
    if (node.nodeType === 3) {
      if (!node.parentElement?.closest("script,style,pre,code,textarea,option,[data-no-translate]")) apply(node, "text", node.data, value => { node.data = value; });
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9) return;
    if (node.nodeType === 1 && node.matches("script,style,pre,code,textarea,option,[data-no-translate]")) return;
    if (node.nodeType === 1) for (const attribute of ["title", "aria-label", "alt", "placeholder"]) {
      if (node.hasAttribute(attribute)) apply(node, attribute, node.getAttribute(attribute), value => node.setAttribute(attribute, value));
    }
    for (const child of node.childNodes) visit(child);
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "childList") for (const node of record.addedNodes) visit(node);
      else visit(record.target);
    }
  });
  function setLanguage(next) {
    language = normalizeLanguage(next);
    observer.disconnect();
    document.documentElement.lang = LANGUAGES[language].html;
    document.title = translateText("口袋对战实验室", language);
    visit(document.body);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title", "aria-label", "alt", "placeholder"] });
  }
  setLanguage(language);
  return { setLanguage, disconnect: () => observer.disconnect() };
}
