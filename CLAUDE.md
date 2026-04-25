# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

Premium Translator —— Chrome MV3 扩展，英译中 + TTS。无构建系统、无依赖、纯 vanilla JS/CSS/HTML。

## 开发与调试

- **加载扩展**：Chrome → `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择本仓库根目录。
- **本地模型源**：选 Local Model 前，需先在终端启动 `mlx_vlm.server --model mlx-community/gemma-4-31b-it-mxfp4 --port 8099`（底层框架是 mlx-vlm，OpenAI 兼容 `/v1/chat/completions`，翻译用例只走纯文本 messages）。
- **本地 TTS 源**：选 Local TTS 前，需先在 `tts` conda 环境里启动 mlx-audio Kokoro server（默认监听 `http://127.0.0.1:8098/v1/audio/speech`，模型 `mlx-community/Kokoro-82M-bf16`）。请求体 `{text, voice}`，响应是 WAV 二进制流，扩展端转 dataURL 经 offscreen 播放。
- **修改后调试**：在 `chrome://extensions` 中点击该扩展的「重新加载」按钮；如改动了 content script，还需刷新目标网页。
- **查看日志**：
  - background service worker：`chrome://extensions` → 该扩展 → 「Service worker」链接打开 DevTools。
  - content script：直接在目标网页 DevTools console 看。
  - popup：右键扩展图标 →「检查弹出内容」。
  - offscreen document：在 background 的 DevTools 中通过 `chrome.runtime.getContexts` 调试，或在控制台查看 `OFFSCREEN_DOCUMENT` 上下文。
- **无测试、无 lint、无构建步骤**。

## 架构

四个进程上下文，通过 `chrome.runtime.sendMessage` 通信，状态共享在 `chrome.storage.local`：

```
popup.js ──┐
           ├──► background.js (service worker) ──► offscreen.js (audio)
content.js ┘                  │
                              └──► Google / Baidu API
```

- **`background.js`** —— 唯一对外发起 HTTP 请求的地方。
  - 翻译：`fetchGoogleTranslation` / `fetchBaiduTranslation`（5s `TIMEOUT_MS`） + `fetchLocalModelTranslation`（30s `LOCAL_TIMEOUT_MS`，POST 到 `http://localhost:<port>/v1/chat/completions`）。
  - TTS：`fetchGoogleTTS` / `fetchBaiduTTS`（5s）+ `fetchLocalTTS`（30s `LOCAL_TIMEOUT_MS`，POST 到用户配置的 endpoint，body `{text, voice}`，响应 WAV blob）。三者均返回 dataURL，再经 offscreen 播放。`fetchLocalTTS` 返回 `{audioData, errorCode?}` 结构（其他两个仍是 dataURL|null），让 SPEAK_TEXT 区分 CONNREFUSED/TIMEOUT/FAILED 给出不同错误文案。
  - 消息路由：`TRANSLATE_TEXT` 根据 `provider` 枚举（`'google'`/`'baidu'`/`'local'`）路由；`SPEAK_TEXT` 根据 `ttsProvider` 枚举（`'google'`/`'baidu'`/`'local'`）路由。两枚字段独立（翻译用本地 ≠ TTS 用本地）。
  - 错误约定：**翻译路径**失败时返回 `'ERROR:TIMEOUT'` / `'ERROR:FAILED'` / `'ERROR:BAIDU_<code>'` / `'ERROR:LOCAL_CONNREFUSED'` 字符串，调用方用 `errorMap` 转人话（content.js × 2 处、popup.js × 1 处共三份相同的映射）。**TTS 路径**不走 ERROR: 前缀协议，背景脚本直接用 `{success: false, error: '人话文案'}` 回包，调用方 `alert()` 显示。
  - 自带 MD5 实现，给百度签名用（仅此一处用途）。
  - `onInstalled`：1) 若无百度密钥，尝试读 `key.baidu`（JSON 格式 `{appid, secret}`，未提交，已在 `.gitignore`）；2) 一次性迁移旧 `useBaidu` 布尔到 `provider`/`ttsProvider` 枚举，并写入本地默认值（`localModelName`/`localModelPort`/`localTtsUrl`/`localTtsVoice`）。

- **`content.js`** —— 注入到 `<all_urls>` 的内容脚本，包含三种交互模式：
  1. **整页翻译（floating widget）**：`startTranslation()` 遍历 block + inline 选择器，按 childNodes 分段（block/BR 为分隔符），跳过非英语和已译节点；译文以 `.pt-translation-line` 节点插入到段尾后，元素打 `data-translated="true"` 标记。状态在 `isTranslating` / `shouldStop` / `translationCache`（内存级 Map）。
  2. **划词翻译（selection mode）**：`mouseup` 监听，弹出 `.pt-selection-popup`（翻译/朗读两按钮），点翻译后改弹 `.pt-translation-bubble`。
  3. **快捷键（Opt+A 翻译，Opt+S 朗读）**：依赖 `mousemove` 持续跟踪 `mouseX/mouseY`；`showTranslationBubbleAtMouse` 的位置算法默认在鼠标下方居中，空间不足才翻到上方，并做水平边界 clamp。
  - 三种模式各自由 storage 标志启用：`floatingMode` / `selectionMode` / `shortcutsEnabled`，popup 通过 `TOGGLE_FLOATING` / `TOGGLE_SHORTCUTS` 消息或 `chrome.storage.onChanged` 同步状态。

- **`offscreen.js` + `offscreen.html`** —— 仅为绕过页面 CSP 而存在的音频播放上下文（`reasons: ['AUDIO_PLAYBACK']`）。background 的 `ensureOffscreenDocument()` 用 `creatingOffscreen` Promise 防并发创建竞态。**不要尝试在 content script 中直接 `new Audio()`**，许多站点的 CSP 会阻断（这是 commit `ca62d0d` 修复的问题）。

- **`popup.js` / `popup.html`** —— 仅是设置面板 + 一个手动翻译框，所有翻译和 TTS 调用同样走 background。

## 关键约定与坑位

- **错误字符串约定**：跨进程返回的翻译错误一律是 `ERROR:` 前缀字符串，**不是** throw。新增错误码时需要在三处 `errorMap` 都同步加上：`content.js` × 2（划词弹泡 + 鼠标快捷键弹泡）、`popup.js` × 1（弹窗输出区）。
- **`provider` 与 `ttsProvider` 独立存储**：翻译源和 TTS 源各走各的两个独立字段。`provider ∈ {google, baidu, local}`（local = mlx-vlm 翻译）、`ttsProvider ∈ {google, baidu, local}`（local = mlx-audio Kokoro TTS）。两个 local 是不同的服务、不同的端口、不同的设置块。Baidu 凭据输入区当 `provider==='baidu' || ttsProvider==='baidu'` 任一为真时显示。
- **本地超时 30s**：`LOCAL_TIMEOUT_MS = 30000` 同时适用于 `fetchLocalModelTranslation` 和 `fetchLocalTTS`（首次加载模型慢），其他源仍用 `TIMEOUT_MS = 5000`。
- **本地连接失败专用错误码**：本地翻译路径在连接拒绝时返回 `'ERROR:LOCAL_CONNREFUSED'`，提示用户启动 `mlx_vlm.server`。本地 TTS 路径不用 ERROR: 前缀，而是回包 `{success: false, error: 'Local TTS Server Unreachable (start mlx_audio TTS server)'}`，因为 TTS 调用方原本就走 alert 路径。
- **localhost vs 127.0.0.1 是不同 origin**：`manifest.json` 的 `host_permissions` 必须同时含 `http://localhost/*` 和 `http://127.0.0.1/*`（mlx-vlm 用 localhost、mlx-audio 用 127.0.0.1）。
- **CSS 类前缀 `pt-`**：所有注入到宿主页面的 DOM 必须带 `pt-` 前缀，避免与宿主样式冲突。`.pt-floating-widget` 用 `z-index: 2147483647`（int32 max）。
- **`isEnglish` 判定**：`/[a-zA-Z]{2,}/`，只要含两个连续英文字母就算，不是严格判定纯英文。
- **整页翻译跳过自身**：处理时必须 `element.closest('.pt-floating-widget')` 排除控件本身，否则会翻译自己的按钮。
- **`key.baidu`**：JSON 格式，已被 `.gitignore`，提交前确认未泄漏密钥。
- **MD5 实现**：仅供百度签名用，不要拿去做安全相关计算。
