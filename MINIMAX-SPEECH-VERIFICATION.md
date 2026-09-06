# MiniMax 播报接入验证 — 2026-09-05

## 范围

- 替换浏览器系统朗读，保留对手登场不播报、战斗字幕、原有视频音轨和战斗结算。
- 服务端连接 `wss://api.minimax.cn/ws/v1/t2a_v2`；前端请求 `/api/battle-speech`，使用 Web Audio 解码播放。
- 用户要求更高昂后改为「率真弟弟」`Chinese (Mandarin)_Straightforward_Boy`；`speech-2.8-turbo`，speed 1.1、pitch +2、vol 1.3、emotion happy。旧「不羁青年」音频保留，不混用缓存。
- 密钥只存于忽略版本管理、权限 600 的 `.env.minimax.local`，静态路由禁止点文件。

## 真实合成样本

台词均为「皮卡丘，使用十万伏特！」。这些是单次本机测量，不是服务延迟保证。

| 样本 | 路径 | 实测 |
| --- | --- | --- |
| 不羁青年 HTTP CLI 初测 | `.local/voice-probe/minimax-unrestrained-thunderbolt.mp3` | CLI 总耗时 1173 ms，MP3 约 2.17 秒 |
| 不羁青年 WS 初测 | `.local/battle-speech/cff5bef8b0f2edcb27b1904a96678f89fd45d23409ab1d6155bca41c95711f94.mp3` | 首包 550 ms，总合成 751 ms；缓存回读 0 ms（四舍五入） |
| 率真弟弟 WS 当前版本 | `.local/battle-speech/2624744f0b546e30ec1bd19769908aa14266001fdf4acc37a363f563321c7f6f.mp3` | 首包 623 ms，总合成 893 ms；40941 字节；浏览器解码 2.503 秒 |

当前样本 FFmpeg 检查：MP3 32 kHz 单声道，平均 -20.4 dB、峰值 -3.3 dB。文件可以完整解码；WS 原生拼接文件会提示跳过头部 junk，不阻碍浏览器解码。这不是所有台词的音量或主观效果保证。没有克隆任何人的声音。

## 回归

- 最终全量 `node --test`：185/185 通过（日志 `.local/minimax-speech-tests.txt`）；独立子 agent 复审 PASS，无阻断项。

- `tests/minimax-speech.test.js`：WS 握手顺序、完成确认、错误与超限、不完整音频拒收、同台词去重、跨实例磁盘复用、归档失败不重复付费、在途上限、取消／迟到／自动播放／设备错误与原生 fetch 调用上下文。
- `tests/cinema-speech.test.js`：真实应用入口按阵营禁用对手登场声音；我方调用 MiniMax；不再引用系统朗读。
- `tests/server.test.js`：跨来源、非 JSON、任意台词、对手登场及静态密钥文件读取被拒绝。
- 独立审查最初发现「合成成功但归档失败会再次付费」；现已在付费前创建目录，并有界保留成功字节，补归档不重新合成。
- 浏览器发现默认 fetch 被作为实例方法调用会出现 Illegal invocation。已改为全局函数包装，加入严格 this 回归测试；不是仅用模拟接口判定通过。

## 浏览器证据边界

- 独立页面 `.local/speech-qa.html` 调用真实 BattleNarrator、真实生产音频路由与已生成的 MP3，禁止新付费请求。当前新音色一次缓存测试在约 32 ms 完成解码并开始播放；停止和取消均立即清除声音。
- `.local/speech-replay.mjs` 在隔离服务中运行真实应用／战斗状态／视频播放器，只有 fal／DeepSeek 与远程视频下载被本地已有样片替代。语音使用当前真实生成的 MP3。运行目录 `.local/blocked-replay-s6SuRl/`，包含演出事件证据。
- 修复后的游戏内实测：选择十万伏特后，同一战场已进入 cinema，同时标记 `voice_playing`；不用独立弹窗播放语音。完整成功回合 `dd2b23ce-0055-4817-8f06-58a950db5fc8/playback.jsonl`：语音请求 2 ms、语音播放 26 ms、听令播放 31 ms、首战斗片播放 5248 ms、演出结束 15722 ms，页面恢复 TURN 02。这里的 26 ms 是已缓存语音起播，不是云端合成速度。
- 上述回归没有新购买战斗视频。旧视频用于播放链路测试，不证明它与新音色的表演、口型或状态效果匹配；声音没有烘焙进 MP4。

## 官方参考

- [系统音色列表](https://platform.minimaxi.com/docs/faq/system-voice-id)
- [同步语音合成 WebSocket](https://platform.minimaxi.com/docs/api-reference/speech-t2a-websocket)
- [同步语音合成 HTTP](https://platform.minimaxi.com/docs/api-reference/speech-t2a-http)
