# dsh-song-id

给一条视频链接，听出里面是什么歌。（目前只测试了b站视频链接）

> 「这个视频的 BGM 是什么？」
> 「第 70 秒那段是什么歌？」
> 「这条降调版的曲子是谁的？」

工具 `song_identify` 用 yt-dlp 取音频、ffmpeg 切片，再**同时**问 Shazam 和网易云音乐两个识曲引擎，
返回歌名 / 歌手 / 专辑 / 流派 / 封面 / 命中时间点。串烧、混剪、DJ 串烧会把每一段扫到的歌都列出来。

---

## 目录

- [安装](#安装)
- [用法](#用法)
- [引擎设置](#引擎设置)
- [工作原理](#工作原理)
- [目录结构](#目录结构)
- [依赖与环境变量](#依赖与环境变量)
- [排错](#排错)
- [隐私](#隐私)

---

## 安装

### 1. 装插件

插件是一个普通的 DSH bundle（`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`）。

**从本地目录装（推荐，改代码立即生效）：**

```bash
# 在 DSH 的对话里让 agent 执行，或直接用 dsh 的插件管理。
# 把 <插件目录> 换成这个包所在的绝对路径（link: 后面跟目录，不要带引号以外的修饰）：
plugin_manager install_bundle  target="link:<插件目录>"
```

装完会做三件事：把依赖写进 profile 的 `package.json`、把 `dsh-song-id` 追加进
`dsh.profile.bundles`、在 profile 的 `node_modules` 里建一个指向本目录的符号链接。

**开发时也可以手工挂：** 在 profile 的 `package.json` 里加

```json
"dependencies": { "dsh-song-id": "link:<插件目录>" },
"dsh": { "profile": { "bundles": [ "...", "dsh-song-id" ] } }
```

> **装完必须重启一次 DSH。** bundle 的树是在宿主启动时组合的，热装进 profile 不会动态加载。

### 2. 装依赖

插件本身零 npm 依赖，但识曲依赖三个外部程序。**装完一定要跑一次 `node bin/doctor.mjs` 确认全绿。**

#### yt-dlp —— 解析链接、下载音频

| 平台      | 命令                                                        |
| ------- | --------------------------------------------------------- |
| Windows | `winget install yt-dlp.yt-dlp`（或 `pip install -U yt-dlp`） |
| macOS   | `brew install yt-dlp`                                     |
| Linux   | `pipx install yt-dlp`（或发行版包管理器）                           |

B 站经常改接口，**yt-dlp 要勤更新**：`yt-dlp -U`（pip 装的用 `pip install -U yt-dlp`）。

查找顺序：`DSH_YTDLP_PATH` → `PATH` → `%APPDATA%\\Python\\Python3xx\\Scripts` → `%LOCALAPPDATA%\\Programs\\Python\\Scripts`。

#### ffmpeg —— 切片、转 8 kHz PCM

| 平台      | 命令                                                     |
| ------- | ------------------------------------------------------ |
| Windows | `winget install Gyan.FFmpeg`（或 `scoop install ffmpeg`） |
| macOS   | `brew install ffmpeg`                                  |
| Linux   | `sudo apt install ffmpeg`                              |

只要 `ffmpeg` 在 `PATH` 上即可；装在别处就用 `DSH_FFMPEG_PATH` 指定到 `ffmpeg.exe`。

#### Python 3.9+ —— 跑 shazamio

| 平台      | 命令                                  |
| ------- | ----------------------------------- |
| Windows | `winget install Python.Python.3.12` |
| macOS   | `brew install python`               |
| Linux   | `sudo apt install python3`          |

查找顺序：`DSH_PYTHON_PATH` → `PATH` 里的 `python.exe` → `PATH` 里 `python.cmd`/`python.bat`
（会从脚本内容里抠出真正的 `.exe` 路径，因为 Node 在 Windows 上没法直接 spawn `.cmd`）→
`$DSH_HOME/venvs/*/Scripts/python.exe` → `%LOCALAPPDATA%\\Programs\\Python\\*\\python.exe` →
`%APPDATA%\\Python\\*\\python.exe`。

#### shazamio —— 不用手动装

首次识曲时会自动执行：

```bash
python -m pip install --disable-pip-version-check --upgrade --target <本包>/vendor/py shazamio
```

装进**插件自己的 `vendor/py`**，不污染全局 Python 环境（约 21 MB）。想提前装好：

```bash
node scripts/install-vendor.mjs          # 预装
node scripts/install-vendor.mjs --check  # 只检查
```

> 网易云引擎**不需要任何额外依赖**：指纹器是编译好的 wasm（`vendor/afp/`），接口不需要 key、不需要登录。

### 3. 自检

```bash
node bin/doctor.mjs
```

六项检查：yt-dlp / ffmpeg / python / shazamio / 网易云指纹器 / 网易云接口可达性。
任何一项 ❌ 或 ⚠️ 都会告诉你怎么修。

---

## 用法

### 在对话里

装好并重启后，直接说：

- 「试试能不能听歌识曲 https://www.bilibili.com/video/BVxxxxxxxxxx/」
- 「BVxxxxxxxxxx 第 75 秒那首是什么」
- 「这个视频的 BGM 是什么：https://b23.tv/xxxx」

agent 会调用 `song_identify`，把结果整理成 Markdown 给你。

### 参数

| 参数            | 默认   | 说明                                                      |
| ------------- | ---- | ------------------------------------------------------- |
| `url`         | 必填   | B 站链接 / BV 号 / av 号 / b23.tv 短链 / 任意 yt-dlp 支持的链接       |
| `at`          | —    | 从第几秒开始认（给了就从这个点往后连续取，不再按比例撒点）                           |
| `clips`       | `3`  | 试几段（1–5）。越多越可能中，也越慢                                     |
| `clipSeconds` | `12` | 每段多长（5–30）。前奏很长、人声很轻的视频可以调到 20                          |
| `cookies`     | —    | `cookies.txt` 路径，登录 / 会员限定的视频用（也可设 `DSH_VIDEO_COOKIES`） |

`timeoutMs` 是 300 秒；工具声明为并发安全，可以同时识别多条视频。

### 输出长什么样

```
🎵 **Song Title** — Artist Name

- 专辑：Album Name
- 流派：Pop
- 发行：2019
- 厂牌：Label Name
- 封面：https://.../cover.jpg
- Shazam：https://www.shazam.com/track/00000000/...
- 引擎：Shazam（Apple Music 曲库）
- 视频：某个投稿的标题（4:28） [BVxxxxxxxxxx]
- 上传者：某 UP 主
- 命中位置：0:32（12 秒片段）
```

串烧 / 混剪会多一段：

```
- 这条视频里扫到 3 首不同的歌（像是串烧/混剪，位置不同歌就不同）：
  - 0:47：Song A (Remix) — Artist A（×1.06 变调）
  - 1:39：Song B — Artist B（×1.06 变调，网易云）
  - 2:05：Song C — Artist C（网易云）
```

三点提示都会出现在输出里：

- `- 引擎：网易云音乐（曲库里这一版是用户上传的 DJ 版/翻唱…）` —— 主答案来自网易云
- `- 存疑：只有网易云认出来，Shazam 没认到同一首…` —— 只有一家认出来
- `- 变调：原速认不出，把片段升到 ×1.12 才命中 —— 这条视频应该是降调/变速版，结论可能不准，建议核对`

没认出来时：`❓ 没认出来`，列出已经试过的位置和异常，并建议 `at=75` / `clipSeconds=20`。

### 命令行直接跑（调试用）

```bash
node scripts/smoke.mjs "https://www.bilibili.com/video/BVxxxxxxxxxx" 70      # 从第 70 秒
node scripts/smoke.mjs "https://www.bilibili.com/video/BVxxxxxxxxxx" --fresh  # 忽略缓存
```

---

## 引擎设置

设置页里多了一项「听歌识曲」，里面是标题为「选择引擎」的单选：

| 选项 | 说明 |
| --- | --- |
| 自动（默认） | 两个引擎都跑：Shazam 先认，认不出再用网易云补；DJ / 变调视频会自动换几个调门再试 |
| Shazam | 只问 Shazam（Apple Music 曲库），更适合原版歌曲 |
| 网易云 | 只问网易云（曲库里有大量用户上传的 DJ 版 / 翻唱 / AI 版），更适合 DJ、变调 |

- 点一下立刻生效，**不用重启 DSH** —— 每次识曲都会现读偏好。
- 偏好存在 `$DSH_HOME/storages/song-id/settings.json`，只有一个字段：`{"engine": "auto"}`。
- 只影响**之后**的识别：已经认过的视频仍走 7 天缓存（换引擎也不复用旧缓存，缓存键里带了引擎）。
- 选单引擎时，输出里会注明「设置页里固定只用这一个引擎」，也不会再提「另一家没认到」。

---

## 工作原理

### 总流程

```
链接
 │
 ├─ 归一化：BV 号 / av 号 / b23.tv / 带跟踪参数的完整 URL → 干净的网址 + 缓存键
 ├─ 查缓存（命中直接返回，标「来源：缓存」）
 ├─ yt-dlp -J：只解析不下载，拿到标题 / 时长 / 上传者 / 有没有音轨
 │    · 直播 → 直接拒；合集/播放列表 → 直接拒
 │    · 超 60 分钟且没给 at → 直接拒（默默下 200 MB 比让你给个时间点更糟）
 ├─ 采样点：默认按时长 12% / 42% / 72% 撒 3 个点，避开片头 logo 和片尾字幕
 ├─ 取音频：
 │    · ≤ 30 分钟 → yt-dlp 整段下 bestaudio（一般 10 MB 以内）
 │    · > 30 分钟 → yt-dlp --download-sections 只下需要的那几十秒
 │                    （站点不配合就回退整段下载）
 ├─ ffmpeg 切片：16 kHz 单声道 mp3（识曲只需要语音带宽，体积小到 60 KB/段）
 ├─ 识别三轮（见下）
 ├─ 结果写缓存 7 天
 └─ 渲染 Markdown
```

### 三轮识别：一轮比一轮贵，也一轮比一轮脏

| 轮次  | 做什么                       | 什么时候跑                  | 为什么                                           |
| --- | ------------------------- | ---------------------- | --------------------------------------------- |
| 1   | 原速、3 个均匀采样点               | 总是                     | 正常 MV 到这一步就中了，通常 5–7 秒                        |
| 2   | 原速、再补扫 7 个位置              | 第 1 轮全灭，且有整段音频、没给 `at` | DJ 串烧里每首歌只占几十秒，3 个点很容易全落空                     |
| 3   | 变调 ×1.06 / ×1.12，每档 5 个位置 | 全灭，或**只有网易云认出来**       | B 站大量「降调 0.95x / 升调 / 变速」投稿，Shazam 指纹对音高变化不鲁棒 |

变调的实测依据：对一条标着「降调 0.95x」的投稿，Shazam 原速全灭、×1.0526（理论值 1/0.95）也全灭，
**×1.12 才命中**。对变调版只能靠多档位去猜。

第 3 轮最容易误判（同一段音频换个倍率可能指向另一首歌），所以变调结果永远带 `shift` 标记，
渲染时明确写「可能不准，建议核对」；如果主答案不是变调来的，变调结果**只并入候选、不替代主答案**。

### 为什么保留两个引擎

两家用的是**同一系指纹算法**（网易云接口参数就叫 `algorithmCode=shazam_v2`），对变调一样不鲁棒；
但**曲库**完全是两回事：

|           | Shazam            | 网易云音乐                         |
| --------- | ----------------- | ----------------------------- |
| 曲库        | Apple Music 正规发行版 | 用户可上传，DJ 版 / 翻唱 / AI 版 / 伴奏遍地 |
| 元数据       | 专辑、厂牌、流派、发行年份全    | 歌名 + 歌手 + 封面                  |
| 对 DJ 降调视频 | 变调后常认成原唱          | 常直接认出曲库里对应的 DJ 版              |
| 原速误配率     | 低                 | 偏高（原速下偶尔会返回完全无关的歌）            |

所以每轮里两个引擎是 `Promise.all` 并行的（一个挂掉不影响另一个），合并规则：

1. **同一片段 Shazam 有结果 → 丢弃该位置的网易云候选**（网易云的撞库噪声太多）；
2. Shazam 没有 → 取网易云前 2 条作为候选；
3. 主答案优先 Shazam；只有网易云能认出来时标「存疑」；
4. 所有位置的命中汇总去重成候选列表（歌名去掉括号里的版本说明后比较），最多 8 条 ——
   串烧视频只报第一首等于骗人。

### 两个引擎各自怎么调

- **Shazam**：`vendor/py` 里的 Python 库 [shazamio](https://github.com/shazamio/ShazamIO) 逆向实现了
  Shazam 的免费接口，不需要 key。`src/pipeline/recognize.py` 用 `asyncio` 并发（最多 4 路，单段 25 秒超时），
  逐段识别、命中即停，结果用 `<<<SONGID>>>{json}` 一行回传给 Node。
- **网易云**：网页版识曲是纯前端的 —— 3 秒 8 kHz 单声道 PCM → 本地 wasm 算指纹 →
  `POST interface.music.163.com/api/music/audio/match?algorithmCode=shazam_v2&rawdata=<指纹>`。
  指纹器在 `vendor/afp/`（来自 [mos9527/ncm-afp](https://github.com/mos9527/ncm-afp)，以 NeteaseCloudMusicApi
  的 demo 形式分发）。每个 12 秒片段取 **0 秒和 6 秒两个 3 秒窗口**各问一次 ——
  实测 3 秒的偏移就足够让指纹落到另一首歌上，多问一个窗口几乎不花时间（一次查询约 200 ms）。

### 缓存

`$DSH_HOME/storages/song-id/cache.json`，按「视频 + 采样参数 + 引擎」为键，TTL 7 天，最多 500 条。
命中过缓存的输出会多一行「来源：缓存（7 天内问过同一条视频）」。删掉这个文件即清空。
**没认出来的不缓存** —— 下次换个时间点可能就中了。

临时切片放在 `$DSH_HOME/storages/song-id/tmp/run-XXXX/`，每次调用结束就删。

---

## 目录结构

```
dsh-song-id/
├── package.json            # dsh.bundle.patch 指向 cordis.patch.yml；dsh.client 指向 client.js
├── cordis.patch.yml        # 往 loader 里 insert 一个 dsh-song-id 条目
├── client.js               # 客户端半边：设置页里的「听歌识曲 → 选择引擎」
├── icon.svg  locale/{zh,en}.json
├── src/
│   ├── index.js            # 插件入口：注册 song_identify + 设置页读写端点
│   ├── tool-spec.js        # 工具契约：参数 / 输出 schema / timeout
│   ├── format.js           # 结果 → Markdown
│   └── pipeline/
│       ├── url.js          # 链接归一化、BV 号提取、缓存键
│       ├── ytdlp.js        # 找 yt-dlp / ffmpeg、spawn、错误翻译
│       ├── media.js        # yt-dlp -J 探元信息、整段/区间下载、采样点
│       ├── clips.js        # ffmpeg 切片（原速 / 变调）
│       ├── shazam.js       # 调 recognize.py，解析 MARK 行
│       ├── recognize.py    # asyncio + shazamio，并发识别
│       ├── netease.js      # 网易云：PCM → wasm 指纹 → audio/match
│       ├── settings.js     # 引擎偏好（设置页写的那个文件）
│       ├── vendor.js       # 找 python、懒装 shazamio 到 vendor/py
│       ├── cache.js        # 7 天缓存
│       └── identify.js     # 主流程：三轮识别、双引擎合并
├── bin/doctor.mjs          # 依赖自检
├── scripts/
│   ├── smoke.mjs           # 命令行冒烟：node scripts/smoke.mjs <url> [at] [--fresh]
│   └── install-vendor.mjs  # 预装 shazamio
├── test/                   # 单元测试
└── vendor/
    ├── py/                 # shazamio 及其依赖（自动装，不入库）
    └── afp/                # 网易云指纹器 wasm
```

---

## 依赖与环境变量

| 环境变量                | 作用                                    |
| ------------------- | ------------------------------------- |
| `DSH_YTDLP_PATH`    | 指定 yt-dlp 可执行文件                       |
| `DSH_FFMPEG_PATH`   | 指定 ffmpeg 可执行文件                       |
| `DSH_PYTHON_PATH`   | 指定 Python 解释器                         |
| `DSH_SONGID_VENDOR` | 改 shazamio 的安装目录（默认 `<本包>/vendor/py`） |
| `DSH_VIDEO_COOKIES` | 默认 cookies.txt 路径                     |
| `DSH_HOME`          | 决定缓存与临时目录位置（默认 `~/.dsh`）              |
| `DSH_SONGID_DEBUG`  | 设了之后 `apply` 抛出的异常不再被吞，便于排查           |

---

## 排错

| 现象                | 怎么办                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| **工具不出现在对话里**     | ① 装完是否重启过 DSH；② `node bin/doctor.mjs` 看依赖；③ `DSH_SONGID_DEBUG=1` 重启后看日志里的 `[dsh-song-id] failed to load` |
| **没认出来**          | 先 `at=秒` 指一个你确定有歌的位置，再把 `clipSeconds` 调到 20。纯音乐、现场翻唱、人声盖过伴奏的段落，两个引擎都可能认不出                                |
| **认出来但不像**        | DJ 混音 / 串烧里同一段音频在两家曲库可能对应不同的歌，输出会把候选都列出来，对照着看                                                            |
| **长视频报「太长」**      | 用 `at` 指定时间点，或先用 `clips`/`at` 缩小范围                                                                       |
| **要登录的视频**        | 导出一份 `cookies.txt` 传给工具（`cookies` 参数或 `DSH_VIDEO_COOKIES`）                                               |
| **B 站解析失败 / 403** | `yt-dlp -U` 更新；仍不行多半要 cookies                                                                            |
| **shazamio 坏了**   | 删掉 `vendor/py`，下次识曲自动重装                                                                                  |
| **网易云连不上**        | 只有 Shazam 引擎工作，结果仍可用（`doctor` 里会标 ⚠️）                                                                    |
| **中文歌名乱码**        | 已修：`recognize.py` 强制 UTF-8 输出，`shazam.js` 给子进程设 `PYTHONIOENCODING=utf-8`                                 |

---

## 隐私

识曲时**片段音频会发给第三方**：

- Shazam（Apple）—— Shazam 引擎；
- 网易云音乐 —— 上传的是 3 秒 8 kHz 的指纹数据。

这是这个能力的本质，不是实现细节上的妥协。指纹计算在本地完成，但算完的指纹本身也要上传才能查库。
不想外发就别用。

插件本身不收集任何统计、不写云端，视频标题/上传者只出现在给你的回答里。

---

## License

MIT
