"""
pipeline/recognize.py — Shazam 识别的 python 半边。

为什么要 Python：Shazam 没有公开 API，`shazamio` 是社区维护的逆向客户端，
免费、无 key、识别质量跟 App 一样。代价是要装一份依赖。

**并发识别**（限流 4）：早先是"顺序 + 命中即停"，看着省，实际很亏 ——
19 个片段的串烧视频要跑 150 秒，其中大半时间在等 Shazam 对"认不出"的片段超时。
改成一口气并发问、按传入顺序取第一个命中，同样的活降到 40 秒左右。

每段的异常单独吞掉 —— 某一段没声音不该毁掉整次识别，但错误要带回去（tried[i].error）。
"""

import asyncio
import json
import sys

MARK = "<<<SONGID>>>"

# 并发太高容易被 Shazam 掐；4 条是实测比较稳的一档。
CONCURRENCY = 4
# 单段超时：一段 12 秒的 mp3，正常 2-5 秒就回，超过 25 秒基本是卡住了。
SEGMENT_TIMEOUT = 25

# Windows 上 python 的 stdout 默认是 cp936（GBK）：中文/日文歌名会被编成 GBK 字节，
# JS 侧按 UTF-8 解码就成了乱码，遇到 GBK 编不出的字符还会直接 UnicodeEncodeError。
# 统一锁死 UTF-8，坏字符用 replace —— 宁可少一个字，也不能让整次识别崩掉。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - 老 python / 非标准流就算了
        pass


async def main(paths, retry_miss=False):
    try:
        from shazamio import Shazam
    except Exception as exc:  # noqa: BLE001 - 要把原因原样交给 JS 侧
        print(MARK + json.dumps({"error": "shazamio import failed: %s" % exc}, ensure_ascii=False))
        return

    shazam = Shazam()
    sem = asyncio.Semaphore(CONCURRENCY)

    async def recognize_one(index, path):
        async with sem:
            # 可选重试：Shazam 对同一段音频并不总是给同一个答案，变调片段更容易空手而回。
            # 重试一次能把命中率抬一截（代价只是一段多问一次）。
            last_error = None
            for attempt in range(2 if retry_miss else 1):
                try:
                    result = await asyncio.wait_for(shazam.recognize(path), timeout=SEGMENT_TIMEOUT)
                except Exception as exc:  # noqa: BLE001
                    last_error = str(exc)[:300]
                    continue
                last_error = None
                track = (result or {}).get("track")
                if track:
                    return {
                        "index": index,
                        "path": path,
                        "track": track,
                        "matches": (result or {}).get("matches") or [],
                    }
                if attempt == 0 and retry_miss:
                    await asyncio.sleep(0.4)
            if last_error:
                return {"index": index, "path": path, "error": last_error}
            return {"index": index, "path": path}

    tried = list(await asyncio.gather(*(recognize_one(i, p) for i, p in enumerate(paths))))

    # 所有命中都带回去：串烧/混剪视频里每个位置是不同歌，"只报第一首"等于撒谎。
    hits = [
        {
            "index": entry["index"],
            "path": entry["path"],
            "track": entry["track"],
            "matches": entry.get("matches") or [],
        }
        for entry in tried
        if entry.get("track")
    ]
    for entry in tried:
        entry.pop("track", None)
        entry.pop("matches", None)

    # 按传入顺序取第一个命中：调用方本来就是按"最想先试的位置"排的序
    hit = hits[0] if hits else None

    print(MARK + json.dumps({"hit": hit, "hits": hits, "tried": tried}, ensure_ascii=False))


if __name__ == "__main__":
    argv = sys.argv[1:]
    retry = "--retry-miss" in argv
    clip_paths = [arg for arg in argv if not arg.startswith("--")]
    try:
        asyncio.run(main(clip_paths, retry_miss=retry))
    except Exception as exc:  # noqa: BLE001
        print(MARK + json.dumps({"error": "fatal: %s" % exc}, ensure_ascii=False))
        sys.exit(1)
