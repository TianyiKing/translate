# CLAUDE.md

本文件是本项目的开发与 AI 协作说明。`AGENTS.md` 是指向 `./CLAUDE.md` 的软链接，只维护本文件，保留软链接。

## 项目概览

Premium Translator —— Chrome MV3 扩展，英译中 + 英文原文朗读。翻译支持 Google / Baidu / Local Model / Hy-MT2，朗读支持 Google / Baidu / Local TTS，分别选择。无构建系统、无扩展运行时第三方依赖，纯 vanilla JS/CSS/HTML；浏览器验收另需 Puppeteer 和 Chromium。

## 开发与调试

- **加载扩展**：Chrome → `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择本仓库根目录。
- **本地模型源**：连接本机 HTTP 服务的 OpenAI 兼容 `/v1/chat/completions`，只发送纯文本 messages。插件默认模型名 `mlx-community/gemma-4-31b-it-mxfp4`、端口 `8099`，保存时应与服务端实际配置一致。使用同机模型仓库时，在 `../../models/gemma/` 内运行 `./start_gemma_server.sh`，配置与启动约定见 `../../models/gemma/CLAUDE.md`；Gemma 服务要求请求模型名与 `config.toml [model] name` 完全相同，插件默认值不代表当前运行档位。
- **Hy-MT2 翻译源**：使用已启动的本机 Hy-MT2 HTTP 服务，默认端口 `8096`；未启动时，在 `../../models/hy-mt2/` 内运行 `./nohub_start_hy_mt2_server.sh`，详见 `../../models/hy-mt2/CLAUDE.md`。设置面板选择 Hy-MT2，点 `Edit Hy-MT2 Settings` 修改端口（整数 `1–65535`）和超时秒数（整数 `1–120`，默认 `32`），再点 `Save Hy-MT2 Settings` 保存。模型与推理参数由服务端配置，插件只传原文和语言。
- **本地 TTS 源**：在 `../../models/kokoro/` 内运行 `./start_kokoro_server.sh`（脚本激活 `kokoro` conda 环境），启动包装 mlx-audio CLI 的本地 FastAPI 服务。默认地址 `http://127.0.0.1:8098/v1/audio/speech`，模型 `mlx-community/Kokoro-82M-bf16`，默认音色 `af_heart`。请求体 `{text, voice}`，响应是 WAV 二进制数据，扩展端转 dataURL 经 offscreen 播放。
- **修改后调试**：在 `chrome://extensions` 中点击该扩展的「重新加载」按钮；如改动了 content script，还需刷新目标网页。
- **查看日志**：
  - background service worker：`chrome://extensions` → 该扩展 → 「Service worker」链接打开 DevTools。
  - content script：直接在目标网页 DevTools console 看。
  - popup：右键扩展图标 →「检查弹出内容」。
  - offscreen document：在 background 的 DevTools 中通过 `chrome.runtime.getContexts` 调试，或在控制台查看 `OFFSCREEN_DOCUMENT` 上下文。
- **服务地址边界**：Local Model 和 Hy-MT2 都固定使用 `http://localhost:<port>`，设置仅能更换端口，不能切换 HTTPS 或远端主机；配套服务应提供 HTTP。Hy-MT2 使用非流式 `/v1/translate`，不调用 `/v1/translate/stream`，当前固定英译中，不提供语言或模型选择。

## 测试

以下命令均在本项目根目录执行；无 lint、无构建步骤。

```sh
node --test tests/*.test.cjs
node tests/browser-hy-mt2.cjs
HY_MT2_LIVE=1 node tests/browser-hy-mt2.cjs
```

- **单元测试**：`tests/hy-mt2.test.cjs` 使用 Node 原生测试，无安装依赖、无需模型服务；覆盖 Hy-MT2 配置与迁移、请求与错误、完整响应超时与定时器清理、源快照、旧源页面 5s 等待、TTS 路由独立及弹窗结果隔离。
- **浏览器验收**：需本机可用的 Puppeteer 和支持加载扩展的 Chromium。脚本使用独立临时浏览器配置和随机端口的模拟服务，默认无需真实模型；验证配置保存、四入口、31s 成功、32s 超时、正文超时、关闭弹窗与错误不缓存。后台 worker 不附加调试器，避免影响保活验收。两项长等待合计约 63s，完整运行会超过一分钟；截图目录通过末尾 `Artifacts:` 输出。
- **真实服务验收**：设置 `HY_MT2_LIVE=1` 后，模拟测试结束再向已启动的 Hy-MT2 发送固定测试句子，验证四入口。脚本不负责启动模型服务；这些测试不等于 Google/Baidu/Local Model 或 TTS 的真实服务验收。

| 环境变量 | 作用 |
|---|---|
| `PUPPETEER_MODULE` | 可被 `require()` 加载的 Puppeteer 模块路径；默认 `puppeteer` |
| `CHROME_PATH` | Chromium 可执行文件路径；未设时由 Puppeteer 选择 |
| `HY_MT2_LIVE=1` | 追加真实 Hy-MT2 四入口验收 |
| `HY_MT2_PORT` | 真实服务端口，默认 `8096`；不改变模拟服务的随机端口 |
| `HY_MT2_SKIP_SLOW=1` | 调试时跳过 31s 成功与 32s 超时两项；完整超时/保活验收时不要设置 |

## 架构

四种运行上下文，通过 `chrome.runtime.sendMessage` 通信；popup 向页面发消息使用 `chrome.tabs.sendMessage`。设置保存在 `chrome.storage.local`，页面任务状态和缓存留在 content script 内存中：

```
popup.js ──┐
           ├──► background.js (service worker) ──► offscreen.js (audio)
content.js ┘                  │
                              └──► Google / Baidu / Local Model / Hy-MT2
```

- **`background.js`** —— 唯一对外发起 HTTP 请求的地方。
  - 翻译：`fetchGoogleTranslation` / `fetchBaiduTranslation`（5s `TIMEOUT_MS`） + `fetchLocalModelTranslation`（30s `LOCAL_TIMEOUT_MS`，POST 到 `http://localhost:<port>/v1/chat/completions`）。
  - Hy-MT2：`fetchHyMt2Translation` POST 到 `http://localhost:<hyMt2Port>/v1/translate`，body `{text, source_lang: "en", target_lang: "zh"}`，读取非空 `translated_text`。超时统一在后台执行，覆盖排队、推理、读取完整 JSON；期间每 20s 调用 `chrome.runtime.getPlatformInfo()` 保活，成功或失败均清理保活和超时定时器。
  - TTS：`fetchGoogleTTS` / `fetchBaiduTTS`（5s）+ `fetchLocalTTS`（30s `LOCAL_TIMEOUT_MS`，POST 到用户配置的 endpoint，body `{text, voice}`，响应 WAV blob）。音频转为 dataURL 后经 offscreen 播放。`fetchLocalTTS` 返回 `{audioData, errorCode?}` 结构（其他两个是 dataURL|null），让 SPEAK_TEXT 区分 CONNREFUSED/TIMEOUT/FAILED 给出不同错误文案。
  - 消息路由：`TRANSLATE_TEXT` 请求为 `{action, text, provider}`，回应 `{translation}`；根据 `provider` 枚举（`'google'`/`'baidu'`/`'local'`/`'hy_mt2'`）路由，优先使用调用方传入的合法源快照，未传或非法则读取存储。Baidu 缺凭据时沿用 Google 回退；Hy-MT2 失败直接返回错误，不自动换源或重试。`SPEAK_TEXT` 根据 `ttsProvider` 枚举（`'google'`/`'baidu'`/`'local'`）路由。两枚字段独立（翻译用本地 ≠ TTS 用本地）。
  - 错误约定：**翻译路径**失败时返回 `'ERROR:TIMEOUT'` / `'ERROR:FAILED'` / `'ERROR:BAIDU_<code>'` / `'ERROR:GOOGLE_BLOCKED'` / `'ERROR:LOCAL_CONNREFUSED'` / `'ERROR:HY_MT2_CONNREFUSED'` 字符串，调用方用 `errorMap` 转为提示文案（content.js × 2 处、popup.js × 1 处，错误码集合一致、部分文案不同）；整页翻译另有中文错误提示分支。**TTS 路径**不走 ERROR: 前缀协议，背景脚本直接用 `{success: false, error: '人话文案'}` 回包，调用方 `alert()` 显示。
  - 自带 MD5 实现，给百度签名用（仅此一处用途）。
  - `onInstalled`：1) 若百度 appid 和 secret 均未设置，尝试读 `key.baidu`（JSON 格式 `{appid, secret}`，版本控制状态见下文）；2) 一次性迁移旧 `useBaidu` 布尔到 `provider`/`ttsProvider` 枚举，并在缺值时写入本地默认值（`localModelName`/`localModelPort`/`localTtsUrl`/`localTtsVoice`）；3) 仅在 Hy-MT2 字段为 `undefined` 时补 `hyMt2Port: 8096` / `hyMt2TimeoutSeconds: 32`，不覆盖已有翻译源选择。

- **`content.js`** —— 注入到 `<all_urls>` 的内容脚本，包含三种交互模式：
  1. **整页翻译（floating widget）**：`startTranslation()` 遍历 block + inline 选择器，按 childNodes 分段（block/BR 为分隔符），跳过非英语和已译节点；译文以 `.pt-translation-line` 节点插入到段尾后，元素打 `data-translated="true"` 标记。状态在 `isTranslating` / `shouldStop` / `translationCache`（内存级 Map）。
  2. **划词翻译（selection mode）**：`mouseup` 监听，弹出 `.pt-selection-popup`（翻译/朗读两按钮），点翻译后保留按钮并显示 `.pt-translation-bubble`。
  3. **快捷键（Opt+A 翻译，Opt+S 朗读）**：依赖 `mousemove` 持续跟踪 `mouseX/mouseY`；`showTranslationBubbleAtMouse` 的位置算法默认在鼠标下方居中，空间不足才翻到上方，并做水平边界 clamp。
  - 三种模式各自由 storage 标志启用：`floatingMode` / `selectionMode` / `shortcutsEnabled`，缺值时关闭。划词通过 `chrome.storage.onChanged` 同步各页面；浮窗和快捷键通过 `TOGGLE_FLOATING` / `TOGGLE_SHORTCUTS` 消息立即更新当前活动页，其他已打开页面需刷新后读取新设置。

- **`offscreen.js` + `offscreen.html`** —— 仅为绕过页面 CSP 而存在的音频播放上下文（`reasons: ['AUDIO_PLAYBACK']`）。background 的 `ensureOffscreenDocument()` 用 `creatingOffscreen` Promise 防并发创建竞态。**不要尝试在 content script 中直接 `new Audio()`**，许多站点的 CSP 会阻断（这是 commit `ca62d0d` 修复的问题）。

- **`popup.js` / `popup.html`** —— 仅是设置面板 + 一个手动翻译框，所有翻译和 TTS 调用同样走 background。

## 关键约定与坑位

- **错误字符串约定**：跨进程返回的翻译错误一律是 `ERROR:` 前缀字符串，**不是** throw。新增错误码时需要在三处 `errorMap` 都同步加上：`content.js` × 2（划词弹泡 + 鼠标快捷键弹泡）、`popup.js` × 1（弹窗输出区），并检查整页 `processSegment()` 是否需要专用提示；未知错误在整页显示「翻译错误」。
- **`provider` 与 `ttsProvider` 独立存储**：翻译源和 TTS 源各走各的两个独立字段。`provider ∈ {google, baidu, local, hy_mt2}`（local = mlx-vlm 翻译，hy_mt2 = Hy-MT2 专用翻译）、`ttsProvider ∈ {google, baidu, local}`（local = mlx-audio Kokoro TTS）。两个 local 是不同的服务、不同的端口、不同的设置块。Baidu 凭据输入区当 `provider==='baidu' || ttsProvider==='baidu'` 任一为真时显示。
- **旧源超时分层**：后台 `LOCAL_TIMEOUT_MS = 30000` 同时适用于 Local Model 和 Local TTS，Google/Baidu 用 `TIMEOUT_MS = 5000`；这些旧函数收到响应头后即清理计时器，不覆盖完整正文读取。页面端 `translateText()` 对 Google/Baidu/Local Model 另设 5s 等待，所以 Local Model 的划词、快捷键、整页入口仍可能在后台 30s 之前报超时；设置弹窗手动翻译没有这层 5s 限制。页面等待结束不会取消后台请求。
- **Hy-MT2 超时独立**：`hyMt2TimeoutSeconds` 默认 `32`，不复用 `LOCAL_TIMEOUT_MS`，不影响 TTS。手动、划词、快捷键和整页四入口都等待同一后台超时；仅 Hy-MT2 移除 content 的额外 5s 等待限制。32s 是每次 HTTP 请求（包括服务端排队、推理、完整 JSON 读取）的预算，不是整页总耗时；整页按段串行请求，不另加队列或自动重试。后台对无效端口和超时分别回退默认值，不改写存储；修改设置适用于后续请求。
- **Hy-MT2 错误**：无法连接返回 `ERROR:HY_MT2_CONNREFUSED`；超时返回 `ERROR:TIMEOUT`；HTTP、JSON、空译文错误返回 `ERROR:FAILED`。整页翻译只缓存成功译文，不缓存错误码或错误提示。
- **关闭划词/快捷键弹窗**：只移除 UI，不取消已发出的翻译请求；后台继续到完成或配置超时。每次结果只更新发起请求时的同一个、仍连接在页面上的弹窗，旧请求不能覆盖新弹窗，也不会重建已关闭弹窗。插件超时会中断 HTTP 等待，不保证服务端停止模型推理。
- **整页停止与重试**：`Stop` 或翻译中 `Dismiss` 通过 `shouldStop` 停止后续段落，已发出的请求继续，当前段仍可能写入结果。错误不缓存，但对应元素仍有 `data-translated` 标记，直接再点 `Translate` 不会重试这些元素；先停止并等当前请求结束，再点 `Clear` 重译。缓存只按原文索引，不区分翻译源，切源后也需要在任务结束后 `Clear` 或刷新页面以重译。
- **本地连接失败专用错误码**：本地翻译路径在连接拒绝时返回 `'ERROR:LOCAL_CONNREFUSED'`，提示用户启动 `mlx_vlm.server`。本地 TTS 路径不用 ERROR: 前缀，而是回包 `{success: false, error: 'Local TTS Server Unreachable (start mlx_audio TTS server)'}`，因为 TTS 调用方原本就走 alert 路径。
- **Google 反爬专用错误码**：`fetchGoogleTranslation` 在 fetch 后先检查 `response.url.includes('/sorry/')`，用于识别跟随重定向进入 CAPTCHA 页的情形，避免将 HTML 当 JSON 解析后误报通用失败；命中返回 `'ERROR:GOOGLE_BLOCKED'`，UI 显示 "Google Blocked by Anti-Bot (Try Baidu/Local)"。`fetchGoogleTTS` 未做这层判定，失败显示通用朗读错误。
- **Google 触发限流/反爬后的手动解决方案**：可尝试访问 `https://translate.google.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=hello` 手动验证几次看能否解开限流/反爬。
- **本机服务权限**：`manifest.json` 的 `host_permissions` 同时包含 `http://localhost/*` 和 `http://127.0.0.1/*`（Local Model / Hy-MT2 用 localhost，Local TTS 默认用 127.0.0.1）；现有声明覆盖 Hy-MT2 端口，无需为 `8096` 单独新增权限。Local TTS 虽可编辑完整 URL，设置输入校验不代表已拥有目标地址权限。
- **CSS 类前缀 `pt-`**：所有注入到宿主页面的 DOM 必须带 `pt-` 前缀，避免与宿主样式冲突。`.pt-floating-widget` 用 `z-index: 2147483647`（int32 max）。
- **`isEnglish` 判定**：`/[a-zA-Z]{2,}/`，只要含两个连续英文字母就算，不是严格判定纯英文。
- **整页翻译跳过自身**：处理时必须 `element.closest('.pt-floating-widget')` 排除控件本身，否则会翻译自己的按钮。
- **`key.baidu` 版本控制状态**：JSON 格式；2026-10-29 文档核查时，`git ls-files --error-unmatch -- key.baidu` 确认该文件仍被跟踪，项目 `.gitignore` 未包含它。本次仅检查跟踪/忽略状态，未读取内容，不能据此认定其中是真实密钥或占位值。不得将其描述为「未提交、已忽略」；仅添加 ignore 规则也不会自动解除已有跟踪。
- **MD5 实现**：仅供百度签名用，不要拿去做安全相关计算。
