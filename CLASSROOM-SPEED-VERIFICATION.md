# 连续演出链路提速验证

日期：2026-09-06。工作目录：`/Users/superx/pokemonlive`。

## 范围与来源

本轮实现四项已核对的 live-classroom 做法：CDN 播放与后台归档解耦、fal 状态流、三播放器预缓冲、更细的时序记录。

参考源码：

- [服务端先返回视频、后台归档](https://github.com/internetphysics/live-classroom/blob/main/src/server/classroom-runtime-instance.ts)
- [fal 状态流与耗时](https://github.com/internetphysics/live-classroom/blob/main/src/server/fal.ts)
- [播放器预缓冲](https://github.com/internetphysics/live-classroom/blob/main/src/components/lesson-deck.tsx)
- [生成与播放配置](https://github.com/internetphysics/live-classroom/blob/main/src/lib/classroom-config.ts)

只做过源码对照，没有运行该仓库作性能基准。未照搬其独立文生视频并发或起播前等待两片的门槛：本游戏保留真实尾帧依赖、固定 seed、原模型与分辨率、战斗事实和状态继承。此次没有新增生成购买，没有更换语音、背景或画风。

## 实现

- `server.mjs` 保留供应商 `videoUrl`，另提供 `localVideoUrl`。浏览器直连失败后回退同源共享下载／归档，不重新提交生成。
- `src/fal-status.js` 自行管理 SDK 状态流的取消与空闲期限；8 秒无更新或流失败后查询原 requestId。避免使用当前 SDK 内部会忽略 abortSignal、超时异步抛错的 streaming subscribe 分支。现有生成期限和远端取消仍由跑道持有。
- `src/attack-video-player.js` 三槽：当前播放、下一段预解码、尾帧保留／故障恢复。`src/app.js` 在听令片播放期间即可加载首、次段；首段不等待次段，接到真实首帧才交接。
- CDN 缓冲／首帧／卡顿期限为 8 秒，同源为 45 秒；原整片 90 秒保护仍在。播放中 CDN 失败时用备用槽从当前时间恢复本地片，旧画面保留到新帧显示，不重复开始或伤害事件。
- `src/fal-video-runway.js` 增加 submitMs、queueWaitMs、providerRunMs、resultMs、statusTransport；`src/video-media-cache.js` 增加 headersMs、firstByteMs、downloadBytes；浏览器记录媒体加载／解码、缓冲时间、片间等待、CDN 回退、卡顿／恢复。
- 埋点只接收有界名称、片号与有限数值，最多 256 条；不新增密钥、视频 URL 或提示词到时序日志。

## 自动化验证

`npm test`：197 项通过，0 失败。完整日志：`.local/classroom-speed-tests.txt`。

新增覆盖状态流成功／中断／空闲回退、晚到流关闭、取消不回退、同 requestId 不重提；第二片提前缓冲、保留可见尾帧、CDN 初始及播放中失败、原进度恢复且事件仅一次、取消后无媒体重绑、双源失败有界退出、卡顿指标、无真实首帧时的独立超时。

独立 agent 的前一轮审查发现“无首帧回调可能等到整片 90 秒”的问题，已增加独立首帧期限及复现测试，复审通过。最终版本复核结果在下方记录。

## 实际浏览器验证（隔离云端）

运行 `.local/classroom-speed-replay.mjs`，端口 4193。使用实际网页、当前服务端与 SDK、现有 5.184 秒 MP4 和已缓存语音；拦截所有云端调用，以可控的状态流和下载模拟网络，不产生新费用。视频素材为历史样片，不以其物种与本测试动作是否相符作画面生成质量验收。

| 场景 | 观察结果 | 证据 |
| --- | --- | --- |
| 正常完整回合 | 两段均在听令结束前缓冲；片 0 结束 10520 ms，片 1 首帧 10531 ms，交接 11 ms；完成回到指令页 | `.local/classroom-speed-replay-O5wnfX/.local/runs/9c978185-f5de-4796-bf21-11f7c974bdfa/playback.jsonl` |
| CDN 404 + 状态流 400 | 原请求回退 polling，浏览器回退同源 MP4；两段完整播放，交接 14 ms；无新生成提交 | 同目录 run `4b43420f-540a-48fa-9f07-118f89452731` 的 playback.jsonl 及 network.jsonl |
| 第二段模拟生成 12 秒 | 首段 5297–10525 ms；次段 13614 ms 起播，18838 ms 完成；记录 3075 ms 准备等待，结果正常 | `.local/classroom-speed-replay-LZ2coh/.local/runs/d193a572-1368-4d1b-a847-1edb48f61eb6/playback.jsonl` |
| 第二段模拟生成 45 秒 | 实际截图确认首段 ended、currentTime=5.184、opacity=1，后两槽不可见，舞台仍在演出中，没有黑屏 | `.local/classroom-speed-replay-APTVRi`；浏览器截图在本次工具输出中已查看 |
| 等待中跳过并重开 | 40831 ms 取消，远端 cancel 仅一次；指令恢复。重开后 TURN 01、满血；超过旧任务 readyAt 后无旧片覆盖、无控制台错误 | 上述目录 run `edd6da9b-3f74-4c71-ab9a-0891524f8d48` 的 playback.jsonl 与 network.jsonl |

正常／回退／慢片完整回合都显示 TURN 02，皮卡丘 80/110、小火龙 50%，与固定测试 RNG 的战斗结果一致。长等待截图和完成页均实际查看，不用单元测试代替运行画面证据。

一次较早的慢片测试遇到隔离服务退出后的 Failed to fetch，未算通过；重新启动服务并保留控制台日志后，慢片完整回合及长等待检查通过。测试 mock 不完全模拟 fetch AbortSignal，因此取消后可出现只读状态查询直至假任务结束；实际浏览器演出已取消，未产生续段归档或迟到 UI 覆盖。

## 速度结论与限制

- 上表为受控链路验证，不是真实 fal 推理提速，也不是优化前后的公网 A/B。11／14 ms 不是所有设备和网络的交接保证。
- 真实调用仍须“前片完整下载 → 实际尾帧 → 后片生成”。本轮未实现 Range 提早尾帧；历史首片下载 15.266 秒的瓶颈不能称为已消除。
- CDN 路径减少浏览器必须经过本地中转的依赖，但浏览器与归档服务各自下载，会增加并行流量；特定网络仍可能同源更快，因此保留自动回退。
- 状态流传递的是任务进度，不是边推理边播放的 MP4 流。queueWaitMs／providerRunMs 是观察时间；浏览器到本地服务仍有约 300 ms 轮询粒度。
- 固定听令片仍正常播放完成；预缓冲缩短的是之后的额外等待，不截断现有听令演出。下一次用户正常生成将记录真实链路耗时，才能评估当前网络的收益。

## 最终准出

- 自动化：197/197。
- 浏览器：上述正常、回退、慢片、尾帧保持、跳过重开检查通过。
- 独立最终审查：PASS，未发现阻断；审查 agent 独立运行全量测试 197/197，并核对取消、回退、首帧截止时间和事件单次触发。浏览器证据由主线程执行，未声称由审查 agent 重跑。
- 正式本地服务：已启动新版本 `node server.mjs`，`http://localhost:4173/` 与新播放器模块只读检查均为 HTTP 200；语法检查通过。启动前确认端口空闲，未终止其他正式进程。启动日志为 `.local/classroom-speed-server.log`。
