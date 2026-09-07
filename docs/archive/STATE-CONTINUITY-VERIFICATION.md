# 状态继承与动画换人验收（2026-09-05）

> 历史验收记录：内容对应记录时的版本，不作为当前运行说明；文内代码路径及命令以项目根目录为基准。

## 本轮结论

独立子 agent 复审 PASS，117/117 自动测试通过。准出范围是本地桌面原型的状态事实传递、播放编排，以及下面实际检查过的生成样片；不是对未来模型输出绝对准确的保证。没有改变战斗伤害公式、回合消耗或像素网页主题。

所有新生成的攻击、换人、待机及听令片统一采用手绘 2D 宝可梦电视动画风格。非像素角色参考用于物种、颜色、轮廓与标志部位；像素只用于 HTML UI 和缺少视频时的兜底。最初生成的像素换人片已拒绝，保留诊断但不进入新版缓存。

## 可复查证据

全部帧表和截图位于 `.local/state-continuity-qa/`。帧表按每秒 1–2 帧抽样检查；不声称逐帧验收了每个编码帧。

| 样片 | 检查结果 | 文件 |
| --- | --- | --- |
| 睡眠孢子 | 小拳石闭眼入睡，区别于 KO 卷卷眼 | `sleep-sheet.jpg` |
| 下一回合普通攻击 | 从上一片真实尾帧开场；小拳石受击仍闭眼，没有主动闪避或恢复清醒 | `sleep-tail-v2-sheet.jpg` |
| 直接击倒 | 小火龙双眼黑色螺旋、失去战斗能力并倒地 | `ko-sheet.jpg` |
| 皮卡丘换成杰尼龟 | 动画收回、精灵球登场、最终同场双角色；非像素 | `switch-v2-sheet.jpg` |
| 新阵容待机 | 杰尼龟／小火龙手绘动画、轻呼吸和眨眼 | `idle-v2-sheet.jpg` |
| 新阵容听令 | 同场→杰尼龟特写→回到同场；非像素 | `command-v2-sheet.jpg` |

真实 localhost:4173 浏览器完成了「换人片→并行生成新待机/听令→敌方攻击换入者→新待机」：`live-switch.png`、`live-idle-return.png`。回到 TURN 02 时杰尼龟为 107/119 HP，小火龙为 100%；视频内联，演出时隐藏 HUD，结束后恢复。

复审发现新近景与左上面板遮挡，已局部收紧面板并移至天空边角。修订截图 `idle-hud-clearance.png` 使用 localhost:4190 离线回放同一批真实生成素材，复核完整换人后的待机 UI；它是布局证据，不是新增付费生成证据。旧 `live-idle-return.png` 留作问题对照。

另外完成正常预热和预热失败两次离线回归：失败不会阻塞规则结算，也不会自动重复收费；匹配的实际尾帧保持可见，下一片解码完成后再切换。离线旧片仅验证流程，不证明新角色造型。日志见 `.local/scene-replay-evidence.jsonl`。

## 实测生成时间

以下是 fal 跑道记录的单段生成时长，非点击到播放的总时长，不包含全部下载、尾帧提取和浏览器缓冲。每片约 5 秒，不保证都能在播放下一片之前完成。

| 验证片段 | 模型 | 生成时间 |
| --- | --- | --- |
| 睡眠孢子 | H3 Max Reference | 4.846 秒 |
| 跨回合熟睡受击（修订） | H3 Max Turbo | 4.646 秒 |
| KO 卷卷眼 | H3 Max Turbo | 3.990 秒 |
| 动画换人（修订） | H3 Max Reference | 10.046 秒 |
| 杰尼龟／小火龙待机 | H3 Max Turbo | 6.078 秒 |
| 杰尼龟／小火龙听令 | H3 Max Turbo | 5.030 秒 |

待机与听令两项并行预热，均使用同一换人片尾帧。对应缓存键：

- 换人：`725d09be29546e618f5402a90d4aa6919c9a92be870ed1715daf9b297e10677e`
- 待机：`c72f5aa410f2cf0637bb782c46a59f171476730ef49927bebfac111055cd6564`
- 听令：`d908189d541574b4b749dd8d8946389d05fa7590920c7f5cb899d4430319e820`

素材及生成信息位于 `.local/scene-videos/<key>/`。攻击记录和视频位于 `.local/runs/<sessionId>/`，验证任务编号保存在 `.local/state-continuity-qa/verification.json`。

## 回归及限制

`npm test`：117 项通过。覆盖状态缓存隔离、睡眠/醒来边界、直接 KO/残余伤害归属、换人瞬时快照、强制换人、事件只应用一次、并行预热去重、迟到取消、素材下载失败、重启后防重复付费，以及第二片中途跳过时恢复可见尾帧。`node --check server.mjs` 和 `node --check src/app.js` 通过。

修复了跨回合尾帧归档尚未完成时退回参考图的竞态；新版等待实际尾帧并支持从可信本地归档恢复。旧 `sleep-next-sheet.jpg` 对应未正确接尾帧的先前样片，不用于连续性准出。新版使用 `sleep-tail-v2-sheet.jpg`。

KO 样片仍有轻微额外色块等造型瑕疵；新版提示词进一步禁止小火龙斑块和皮卡丘面部条纹，但未为这条微调再次付费生成，不能声称瑕疵已被实帧消除。也未穷举六只角色的全部阵容和状态组合生成付费视频。新阵容首次换人需要生成时间；无缓存时保留像素兜底。未完成的付费任务有日志防重复提交，但自动跨重启接管未完成 fal 任务不在本轮范围内。

## 参考

昏厥的螺旋眼视觉参考：[Bulbapedia / Fainting in animation](https://bulbapedia.bulbagarden.net/wiki/Fainting#In_animation)。它是视觉研究来源，不替代本地规则事实。

模型参数核对：[fal H3 Max Reference API](https://fal.ai/models/minimax/h3-max/reference-to-video/api)、[fal H3 Max Turbo API](https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api)。非像素角色参考来自 [PokeAPI/sprites](https://github.com/PokeAPI/sprites)，本地来源清单在 `assets/video-references/artwork/PROVENANCE.md`；公开可获取不代表取得宝可梦角色使用许可。
