#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 前沿日报 · 每日更新脚本（零第三方依赖）

做四件事：
  1. 抓取若干 AI 相关 RSS/Atom 源
  2. 过滤与 AI 相关的条目，自动归类（模型 / 政策 / 行业）
  3. 抽取式摘要（≤100 字，保证不超字数）
  4. 与 data/news.js 中已有内容合并去重，按日期倒序写回

用法：
  python scripts/refresh_news.py            # 抓取并合并
  python scripts/refresh_news.py --dry-run  # 只看会新增什么，不写文件
  python scripts/refresh_news.py --limit 8  # 本次最多新增 8 条

说明：
  · 已有条目的 id 不会被改写，阅读记录（localStorage）不会失联。
  · 摘要为「提取式」——直接从原文首段截取，不改写、不编造；
    若需要更自然的摘要，可在 classify() 之后接入任意 LLM 做改写。
"""

import argparse
import email.utils
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

# 统一按北京时间记录与展示，不受运行环境（本地 / CI 的 UTC）影响
CN_TZ = timezone(timedelta(hours=8))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS_PATH = os.path.join(ROOT, "data", "news.js")
JSON_PATH = os.path.join(ROOT, "data", "news.json")

FEEDS = [
    ("36氪", "https://www.36kr.com/feed"),
    ("钛媒体", "https://www.tmtpost.com/rss"),
    ("TechCrunch AI", "https://techcrunch.com/category/artificial-intelligence/feed/"),
    ("VentureBeat AI", "https://venturebeat.com/category/ai/feed/"),
    ("The Verge AI", "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"),
]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# 只收最近几天发布的条目：部分源的 RSS 是全量存档（如 VentureBeat 停在数月前），
# 没有这道闸门的话每跑一次就会把历史存量往前回填 12 条。
MAX_AGE_DAYS = 3

# 标题级关键词：只认这些，避免「正文提了一句 AI」的泛科技稿混进来
AI_WORDS = [
    "AI", "人工智能", "大模型", "模型", "智能体", "Agent", "多模态", "算力", "GPU", "芯片",
    "训练", "推理", "开源", "OpenAI", "Anthropic", "Claude", "GPT", "Gemini", "DeepSeek",
    "Qwen", "千问", "混元", "豆包", "Kimi", "Llama", "Mistral", "英伟达", "Nvidia",
    "机器学习", "深度学习", "AIGC", "生成式", "机器人", "具身", "自动驾驶", "世界模型", "大语言",
]

# 明显不是资讯的栏目稿，直接跳过
NOISE_WORDS = [
    "邀请函", "WISE2026", "苏客松", "报名", "招聘", "活动预告", "直播预告",
    "也能获得36氪报道吗", "融资快报", "一周要闻",
]

POLICY_WORDS = [
    "政策", "监管", "立法", "法规", "备案", "合规", "治理", "法案", "标准", "规范",
    "发改委", "网信办", "工信部", "欧盟", "白宫", "国会", "出口管制", "禁令", "处罚",
    "法院", "起诉", "诉讼", "隐私", "版权", "反垄断", "沙盒",
    "policy", "regulation", "regulator", "lawsuit", "sue", "court", "antitrust",
    "ban", "copyright", "privacy", "compliance", "executive order",
]

MODEL_WORDS = [
    "发布", "上线", "开源", "模型", "参数", "基准", "评测", "多模态", "智能体", "Agent",
    "上下文", "推理", "训练", "版本", "GPT", "Gemini", "Claude", "Qwen", "Llama",
    "DeepSeek", "混元", "LongCat", "SenseNova", "Kimi",
    "model", "release", "launch", "benchmark", "open-source", "multimodal",
    "agent", "llm", "reasoning", "context window", "weights",
]

INDUSTRY_WORDS = [
    "融资", "投资", "IPO", "上市", "收购", "并购", "营收", "财报", "估值", "股价",
    "芯片", "算力", "数据中心", "合作", "订单", "裁员", "涨价", "产能", "供应链",
    "采购", "合同", "中标", "签单", "交付", "销量", "市场",
    "funding", "raises", "valuation", "acquisition", "acquire", "revenue",
    "deal", "market", "stock", "billion", "data center", "chip",
]

TAG_RULES = [
    ("大模型", ["大模型", "模型", "参数", "LLM"]),
    ("智能体", ["智能体", "Agent", "agent"]),
    ("多模态", ["多模态", "视觉", "视频生成", "图像"]),
    ("算力", ["算力", "GPU", "芯片", "数据中心", "TPU", "NPU"]),
    ("政策", ["政策", "监管", "立法", "备案", "合规"]),
    ("融资", ["融资", "估值", "IPO", "上市"]),
    ("开源", ["开源", "open source"]),
    ("机器人", ["机器人", "具身", "自动驾驶"]),
    ("安全", ["安全", "对齐", "风险", "漏洞"]),
]


# ---------------------------------------------------------------- 工具

def fetch(url, timeout=12):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def strip_html(text):
    if not text:
        return ""
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def clip(text, limit=100):
    """严格限制在 limit 字符内（含省略号）。"""
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    # 尽量在句读处断开
    for sep in ("。", "！", "？", "；", "，", ". "):
        idx = cut.rfind(sep)
        if idx >= limit * 0.55:
            return cut[: idx + 1].rstrip("，、, ")
    return cut.rstrip("，、,; ") + "…"


def to_local(pub):
    """把各站五花八门的时间写成北京时间。

    实测各源格式并不统一，必须逐种兜底，否则会静默退回「抓取时刻」：
      · 标准 RSS：Thu, 27 Aug 2026 14:01:00 GMT      → email.utils
      · 36氪：    2026-11-03 18:02:03  +0800         → strptime（非标准，双空格）
      · The Verge：2026-11-02T13:56:02-05:00         → fromisoformat
      · 无时区：  2026-11-03 18:02:03                → 按北京时间补齐
    """
    if not pub:
        return None
    s = re.sub(r"\s+", " ", pub.strip())
    dt = None

    # 1) ISO 8601（含 Z 结尾）
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        pass

    # 2) RFC 822 / RFC 2822
    if dt is None:
        try:
            dt = email.utils.parsedate_to_datetime(s)
        except (TypeError, ValueError):
            dt = None

    # 3) 常见手工格式
    if dt is None:
        for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M:%S",
                    "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M:%S"):
            try:
                dt = datetime.strptime(s, fmt)
                break
            except ValueError:
                continue

    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=CN_TZ)
    return dt.astimezone(CN_TZ)


def slug(title):
    h = hashlib.md5(title.encode("utf-8")).hexdigest()[:10]
    return "auto-" + h


# ---------------------------------------------------------------- 解析

def decode_text(raw):
    """按声明编码解码「一次」，避免 ET 从字节流自行解码时把个别坏字节变成 U+FFFD。

    直接把 bytes 交给 ET.fromstring 时，expat 会自己解码，遇到源站偶发的
    非法字节就静默替换成 �（实测 36氪 会出现「机器人」→「机��人」）。
    这里先解成 str 再交给 ET，并去掉 XML 声明（expat 不接受带 encoding 声明的 str）。
    """
    m = re.search(rb"encoding=[\"']([\w\-]+)[\"']", raw[:300], re.I)
    declared = m.group(1).decode("ascii", "ignore").lower() if m else "utf-8"
    text = None
    for enc in (declared, "utf-8", "gb18030"):
        try:
            text = raw.decode(enc)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if text is None:
        text = raw.decode("utf-8", "replace")
    return re.sub(r"^\s*<\?xml[^>]*\?>", "", text, count=1)


def clean_text(s):
    """去掉控制字符、BOM 与解码残留的替换字符。"""
    if not s:
        return ""
    s = s.replace("\ufeff", "").replace("\ufffd", "")
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)
    return re.sub(r"[ \t]+", " ", s).strip()


def parse_feed(xml_bytes):
    """同时兼容 RSS 2.0 与 Atom，返回 [{title, link, desc, pub}]。"""
    out = []
    if isinstance(xml_bytes, (bytes, bytearray)):
        xml_bytes = decode_text(bytes(xml_bytes))
    if isinstance(xml_bytes, str) and "\ufffd" in xml_bytes:
        xml_bytes = xml_bytes.replace("\ufffd", "")
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return out

    def local(tag):
        return tag.split("}")[-1].lower()

    for node in root.iter():
        if local(node.tag) not in ("item", "entry"):
            continue
        title = link = desc = pub = ""
        for child in node:
            name = local(child.tag)
            if name == "title":
                title = strip_html("".join(child.itertext()))
            elif name == "link":
                link = (child.get("href") or (child.text or "")).strip()
            elif name in ("description", "summary", "content"):
                if not desc:
                    desc = strip_html("".join(child.itertext()))
            elif name in ("pubdate", "published", "updated", "date"):
                if not pub:
                    pub = (child.text or "").strip()
        title, desc = clean_text(title), clean_text(desc)
        if title and link:
            out.append({"title": title, "link": link.strip(), "desc": desc, "pub": pub})
    return out


def is_ai(text):
    low = text.lower()
    return any(w.lower() in low for w in AI_WORDS)


def title_relevant(title):
    """标题必须直接谈论 AI / 算力 / 机器人，正文顺带一提的不算。"""
    low = title.lower()
    if any(w.lower() in low for w in NOISE_WORDS):
        return False
    return any(w.lower() in low for w in AI_WORDS)


def classify(title, desc):
    """按「标题权重 3、正文权重 1」给三类打分，取最高分。"""
    t, d = title.lower(), desc.lower()

    def score(words):
        return sum(3 for w in words if w.lower() in t) + sum(1 for w in words if w.lower() in d)

    scores = {
        "model": score(MODEL_WORDS),
        "policy": score(POLICY_WORDS),
        "industry": score(INDUSTRY_WORDS),
    }
    best = max(scores, key=lambda k: scores[k])
    if scores[best] == 0:
        return "model"
    return best


def make_tags(text):
    low = text.lower()
    tags = [name for name, words in TAG_RULES if any(w.lower() in low for w in words)]
    return tags[:3] or ["AI"]


def norm_key(s):
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", s.lower())


# ---------------------------------------------------------------- 读取 / 写出

def load_existing():
    if not os.path.exists(JS_PATH):
        return {"updatedAt": "", "edition": "", "articles": []}
    with open(JS_PATH, "r", encoding="utf-8") as f:
        raw = f.read()
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1:
        return {"updatedAt": "", "edition": "", "articles": []}
    try:
        data = json.loads(raw[start:end + 1])
    except json.JSONDecodeError:
        return {"updatedAt": "", "edition": "", "articles": []}
    data.setdefault("articles", [])
    return data


def write_out(data):
    data["articles"].sort(key=lambda a: (a.get("date", ""), a.get("time", "")), reverse=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    os.makedirs(os.path.dirname(JS_PATH), exist_ok=True)
    with open(JS_PATH, "w", encoding="utf-8") as f:
        f.write("/* AI 前沿日报 · 数据文件（由 scripts/refresh_news.py 生成，可手工编辑） */\n")
        f.write("window.AI_DAILY_DATA = ")
        f.write(payload)
        f.write(";\n")
    with open(JSON_PATH, "w", encoding="utf-8") as f:
        f.write(payload + "\n")


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser(description="抓取 AI 资讯并合并进日报数据")
    ap.add_argument("--dry-run", action="store_true", help="只打印结果，不写文件")
    ap.add_argument("--limit", type=int, default=12, help="本次最多新增条数")
    args = ap.parse_args()

    data = load_existing()
    articles = data["articles"]
    known_urls = {a.get("url", "") for a in articles}
    known_titles = {norm_key(a.get("title", "")) for a in articles}

    fresh = []
    report = []
    now_ref = datetime.now(CN_TZ)
    stale = 0
    for name, url in FEEDS:
        try:
            raw = fetch(url)
            items = parse_feed(raw)
            report.append((name, len(items), "ok"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            report.append((name, 0, "失败：%s" % type(exc).__name__))
            continue

        for it in items:
            if not title_relevant(it["title"]):
                continue
            blob = it["title"] + " " + it["desc"]
            if it["link"] in known_urls or norm_key(it["title"]) in known_titles:
                continue
            dt = to_local(it["pub"]) or now_ref
            if now_ref - dt > timedelta(days=MAX_AGE_DAYS):
                stale += 1
                continue
            summary = clip(it["desc"] or it["title"], 100)
            body_src = strip_html(it["desc"])
            paragraphs = [p.strip() for p in re.split(r"(?<=[。！？.!?])\s+", body_src) if len(p.strip()) > 30]
            body = paragraphs[:3] or [summary]
            fresh.append({
                "id": slug(it["title"]),
                "title": it["title"][:120],
                "category": classify(it["title"], it["desc"]),
                "date": dt.strftime("%Y-%m-%d"),
                "time": dt.strftime("%H:%M"),
                "source": name,
                "url": it["link"],
                "featured": False,
                "tags": make_tags(blob),
                "summary": summary,
                "body": body,
            })
            known_urls.add(it["link"])
            known_titles.add(norm_key(it["title"]))

    # 过滤掉摘要过短的噪声条目
    fresh = [f for f in fresh if len(f["summary"]) >= 20]
    fresh.sort(key=lambda a: (a["date"], a["time"]), reverse=True)
    fresh = fresh[: max(0, args.limit)]

    print("抓取结果：")
    for name, n, status in report:
        print("  - %-14s 条目 %2d  %s" % (name, n, status))
    if stale:
        print("  （另有 %d 条超过 %d 天，属源站历史存量，已跳过）" % (stale, MAX_AGE_DAYS))
    print("\n本次新增 %d 条：" % len(fresh))
    for a in fresh:
        print("  [%s] %s  %s" % (a["category"], a["date"], a["title"][:46]))

    if args.dry_run:
        print("\n--dry-run：未写入文件。")
        return

    if fresh:
        data["articles"] = fresh + articles
        if len(data["articles"]) > 300:
            data["articles"] = data["articles"][:300]
    else:
        # 没有新条目就不动文件：避免每天产生「只改 updatedAt」的空提交，
        # 页面上的「更新于」也才真实表示内容最后一次变化的时刻。
        print("\n本次没有新增条目，数据文件保持不变。")
        return

    now = datetime.now(CN_TZ)
    data["updatedAt"] = now.isoformat(timespec="seconds")
    data["edition"] = now.strftime("%Y-%m-%d")
    write_out(data)
    print("\n已写入：%s（共 %d 条）" % (JS_PATH, len(data["articles"])))


if __name__ == "__main__":
    sys.exit(main())
