# 松林待机与听令视频验收 · 2026-09-05

## 范围

新背景为 `assets/backgrounds/pine-clearing-v2.png`，参考用户提供的低机位、松林、草覆岩台构图。只调整 2D 桌面战场；不恢复 Three.js，不改变规则结算、阵容和攻击视频调度。

默认阵容仍是皮卡丘／小火龙。其它阵容使用新背景与本地像素精灵，不误播默认角色视频。中性听令仍仅在双方无异常、无混乱且素材已缓冲时启用；喊招来自原有浏览器语音合成，听令视频自身静音。

## 真实生成与素材

| 素材 | 生成方式 | 实际时长 | 结果 |
| --- | --- | --- | --- |
| `pine-idle-v1.mp4` | H3 Max 双参考视频 | 约 5 秒 | 小火龙悬空，不准使用；保留备份 |
| `pine-idle-v2.mp4` | 修正落地要求的 H3 Max 双参考视频 | 约 5 秒 | 角色落地、稳定 2D 动画造型 |
| `pine-idle-v2-loop.mp4` | v2 原片前后 0.5 秒局部交叠 | 4.500 秒 / 108 帧 | 页面使用的循环版本 |
| `pine-command-v2.mp4` | H3 Max Turbo 首尾帧视频 | 5.184 秒 / 124 视频帧 | 全景 → 听令近景 → 同场全景 |

均为 1344×768、24 fps。待机循环无音轨以免重复环境音；听令含音轨但页面静音，不盖过动态喊招。新素材真实提交共 3 次；已完成，没有遗留生成任务。

v2 待机提交至下载完成为 15,261 ms，听令为 10,859 ms（含队列、推理及下载，不是纯推理耗时，也不代表未来保证）。各原片的请求 id、提示词与参考文件保存在同名 `.provenance.json`。生成脚本会恢复已有请求，不重复付费提交；旧资源未覆盖。

待机以背景和旧动画造型为参考，不保留像素网格。循环首帧 `pine-idle-v2-loop-first-frame.png` 同时作为听令输入首帧/期望尾帧；服务端实际锚点是从生成结果提取的 `pine-command-v2-tail.jpg`，不是把期望尾帧冒充真实输出。

SHA-256：

- 待机循环：`d8e341fd166828a3f0907e3fe72659a8fd97feec65b08ea1e680ca90573ec315`
- 听令：`293a22a48db3064890f122814a2a7d1e94afadfa21e6897116de9ea08e83a0ea`
- 听令真实尾帧：`521cfea61c78a438840f3f3f2c90021df913282c5b8d46f02cb0edb046efcc2a`

## 验证证据

- `npm test`：96/96 通过，包括新资源预加载、尾帧同版本、2D 回退、连续播放、跳过与规则事实约束。
- FFmpeg 完整解码两份交付视频；`blackdetect=d=0.02:pix_th=0.1` 未报告黑帧。待机循环末段逐帧接缝检查未见明显角色重影；背景/火焰仍存在生成模型的轻微帧间变化，不宣称数学无损闭环。
- `.local/pine-qa/idle-sheet.jpg`、`command-sheet.jpg`、`loop-seam.jpg`：实际视频抽帧表。loop-seam 最后空格是 tile 填充，不是视频黑帧。
- `.local/pine-qa/idle-desktop-final.png`：本机 4173 实际循环待机，独立 HUD 可见，未遮角色脚部。桌面窄窗口的间距较小。
- `.local/pine-qa/listening-closeup.png`：4190 离线回归页，真实新听令视频 1.48 秒处，双方 HUD 隐藏。
- `.local/pine-qa/fast-return.png`：完整演出后 TURN 02、更新血量及松林待机恢复。
- `.local/pine-qa/delayed-hold.png`：第一攻击视频已 ended 且保留 `is-visible`，第二段未开始，等待画面不是黑屏。
- `.local/pine-qa/skip-return.png` 与 `listening-skip-return.png`：分别在攻击中与听令 1.63 秒处跳过，两个 HUD 恢复，非待机播放器暂停，规则仅结算一次。
- `.local/pine-qa/fallback.png`：换入杰尼龟后待机暂停，stage 移除 idle-active，显示 `squirtle-back.gif` 与同一背景。
- 本次浏览器读取未报告 console error。未在主页面发起攻击，实际演出点击都在 4190 测试页；4173 只刷新并检查展示。

离线回归的攻击段使用历史录像，**只验证播放器与状态链路，不代表本次生成了松林攻击视频**。相关计时见 `.local/replay-evidence.jsonl`：

- fast `7e3aa857-0f79-42f5-b576-265ac9905388`：听令 31 ms；首段 5,280 ms；首段结束 10,510 ms、下一段 10,514 ms；完整返回 15,781 ms。
- delayed `b6bc237c-99ad-4ee5-89b4-ad82d65ea27a`：首段结束 10,499 ms；续段延迟至 14,214 ms 起播；完整返回 19,440 ms。等待期间保留实际尾帧。
- attack skip `9a87f570-3dda-4a53-b48e-6b47f11acfcb`：7,833 ms 取消。
- listening skip `8ba4e9b0-b144-4bce-b3c0-b86d6f6f0985`：1,633 ms 取消。

## 独立审查

review / Ampere 已独立检查代码、96 项测试、实际视频抽帧和桌面截图，并复核最后 5 条流程计时、延迟等待、两种跳过及换人回退证据。最终结论：**PASS，本轮新背景＋待机／听令接入范围可以准出，无阻断项**。窄桌面 HUD 留白较紧、循环轻微生成变化以及未测试新付费攻击的边界保留。

本地非商业原型的权利说明保持不变；生成并不等于取得 Pokémon IP 使用许可。
