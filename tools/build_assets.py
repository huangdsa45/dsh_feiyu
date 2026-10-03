# -*- coding: utf-8 -*-
"""从仓库内的高清素材生成插件自带的精简动画集。

为什么要有这一步：原桌面宠物把 106 段（70MB）WebM 交给 ffmpeg 按需解码；
浏览器版只需要一组够用的循环片段，包体越小、首屏越省。这个脚本把选中的
片段复制进 `plugin/dsh-pet/assets/`（扁平、ASCII 文件名，便于宿主路由用
严格白名单提供服务），并生成 `clips.json` 描述给客户端读。

用法（在本仓库根目录执行）：
    python tools/build_assets.py                       # 生成
    python tools/build_assets.py --check               # 只校验，不写
    python tools/build_assets.py --source-dir <目录>   # 指定上游源素材目录

注意：源素材属上游桌面版项目（MerZlin/dsh-pet-indesktop）的
`assets/characters/shenshen/videos/`，**不随本仓库分发**。本脚本只读它，不改动源素材；
找不到时会打印所用目录并以 2 退出，用 `--source-dir` 指到你的上游检出即可。
"""

from __future__ import annotations

import argparse
import base64
import json
import shutil
import subprocess
import sys
from pathlib import Path

# 本仓库根目录（package.json 所在层）。assets/ 是**产物**目录，不是源素材目录。
PLUGIN_DIR = Path(__file__).resolve().parent.parent
OUT_DIR = PLUGIN_DIR / "assets"
# 上游源素材目录的默认猜测（同级检出）；实际以 --source-dir 为准。
SOURCE_DIR = PLUGIN_DIR.parent / "dsh-pet-indesktop" / "assets" / "characters" / "shenshen" / "videos"

# (分类, 源文件相对路径, 输出 id)。id 必须是 ASCII：它是宿主路由白名单的键。
CLIPS: tuple[tuple[str, str, str], ...] = (
    ("idle", "idle/待机呼吸休闲.webm", "idle_breath"),
    ("turn", "turn/东张西望.webm", "turn_look"),
    ("move", "move/漂浮踏步.webm", "move_float"),
    ("move", "move/左转奔跑.webm", "move_run"),
    ("click", "click/点击回应-开心跃动.webm", "click_happy"),
    ("click", "click/点击回应-害羞惊讶.webm", "click_shy"),
    ("click", "click/点击回应-傲娇生气.webm", "click_pout"),
    ("drag", "drag/被鼠标拖拽悬空反馈.webm", "drag_hang"),
    ("random", "random/写代码.webm", "act_code"),
    ("random", "random/吃Token.webm", "act_token"),
    ("random", "random/哈欠连天.webm", "act_yawn"),
    ("random", "random/超大伸懒腰.webm", "act_stretch"),
    ("random", "random/悠闲哼歌.webm", "act_hum"),
    ("random", "random/撸猫.webm", "act_cat"),
)

# 客户端播放时要用的几何与节奏常量，沿用桌面版 catalog.py 的口径。
CHARACTER = "shenshen"
CANVAS = [640, 360]
SCALE_STEPS = [0.5, 0.72, 0.85, 1.0]
DEFAULT_SCALE = 0.72
CORNER_MARGIN = 24
DRAG_THRESHOLD = 5
MOVE_MIN_PX = 60
MOVE_MAX_PX = 240
MOVE_STRIDE_DEFAULT_PX = 120
HEAD_FALLBACK_RATIO = 0.45

# 动画链概率（累计阈值），与桌面版 catalog.py 一致：
# 30% 待机 / 10% 转向 / 40% 动作 / 20% 移动。
CHAIN = {
    "idle": 0.30,
    "turn": 0.40,
    "act": 0.80,
    "move": 1.00,
}

SIZE_BUDGET_MB = 8.0


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def png_has_transparency(path: Path) -> bool:
    """这张 PNG 是否**真的**有透明像素。

    只看 IHDR 的颜色类型不够：ffmpeg 的 `-pix_fmt rgba` 会产出颜色类型 6 但
    alpha 全 255 的帧（看着"有 alpha 通道"，实际是不透明黑底）——这正是本项目
    踩过的坑。必须解出 alpha 通道的取值区间，判定 min < 255。

    Pillow 不可用时退化为颜色类型检查（能拦住最初那版 RGB 黑底，但拦不住
    "RGBA 全不透明"），并明确打印警告。
    """
    try:
        raw = path.read_bytes()
    except OSError:
        return False
    if len(raw) < 26 or raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
        return False
    if raw[25] != 6:
        return False

    try:
        from PIL import Image
    except ImportError:
        print(
            f"警告：没有 Pillow，无法校验 {path.name} 的 alpha 取值区间"
            "（仅检查了颜色类型，可能放过「RGBA 全不透明」的黑底帧）",
            file=sys.stderr,
        )
        return True

    try:
        with Image.open(path) as image:
            lowest = image.convert("RGBA").getchannel("A").getextrema()[0]
    except Exception as exc:
        print(f"警告：{path.name} 的 alpha 校验失败：{exc}", file=sys.stderr)
        return False
    return lowest < 255


def shrink_png(path: Path) -> None:
    """无损重压 PNG（有 Pillow 时）。带 alpha 的帧比不透明帧大，压一下才守得住预算。"""
    try:
        from PIL import Image
    except ImportError:
        return
    try:
        with Image.open(path) as image:
            image.save(path, "PNG", optimize=True, compress_level=9)
    except Exception as exc:  # 压不动不是致命错误，原文件仍在
        print(f"警告：{path.name} 重压失败：{exc}", file=sys.stderr)


def make_posters(clip_ids: list[str], out_dir: Path) -> dict[str, str]:
    """每个片段抽第一帧存成 PNG（必须带 alpha）。

    为什么必须要有：待机时如果一直在播视频，浏览器要持续做 VP9 alpha 的**软件
    解码**（实测单核 34%），与「不许大量占用后台」的红线直接冲突。待机显示静态
    帧后解码归零，动画只在交互与随机事件时播放。

    为什么必须指定 `libvpx-vp9`：VP9 的 alpha 存在 BlockAdditional 的独立 alpha
    流里，ffmpeg 的**原生 vp9 解码器会把它丢掉**，只输出不透明的黑底帧（实测
    alpha 全为 255）；只有 libvpx-vp9 解出来才是 (0,255)。这条不加，桌宠就会
    一直坐在一块黑色方块上。

    抽帧失败不算致命：客户端对没有 poster 的片段退化为持续播放，而不是整个
    插件起不来。
    """
    try:
        import imageio_ffmpeg
    except ImportError:
        print("警告：没有 imageio-ffmpeg，跳过 poster 生成（待机将退化为持续播放）", file=sys.stderr)
        return {}

    exe = imageio_ffmpeg.get_ffmpeg_exe()
    produced: dict[str, str] = {}
    opaque: list[str] = []
    for clip_id in clip_ids:
        source = out_dir / f"{clip_id}.webm"
        target = out_dir / f"{clip_id}.png"
        if not source.is_file():
            continue
        result = subprocess.run(
            [
                exe, "-y", "-loglevel", "error",
                # The decoder that actually honours the VP9 alpha stream.
                "-c:v", "libvpx-vp9",
                "-i", str(source),
                "-frames:v", "1",
                "-pix_fmt", "rgba",
                str(target),
            ],
            capture_output=True,
            check=False,
        )
        if result.returncode != 0 or not target.is_file():
            reason = result.stderr.decode("utf-8", "replace").strip()
            print(f"警告：{clip_id} 抽帧失败：{reason}", file=sys.stderr)
            continue
        if not png_has_transparency(target):
            opaque.append(clip_id)
            continue
        shrink_png(target)
        if not png_has_transparency(target):
            opaque.append(clip_id)
            continue
        produced[clip_id] = f"{clip_id}.png"

    if opaque:
        print(
            "以下片段的静态帧没有 alpha 通道（会变成黑底），已拒绝使用："
            + "、".join(opaque)
            + "\n请确认抽帧使用 libvpx-vp9 解码器。",
            file=sys.stderr,
        )
    return produced


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="只校验，不写文件")
    parser.add_argument(
        "--source-dir",
        default=None,
        help="上游桌面项目的素材目录（默认按同级检出推测；本仓库不分发源素材）",
    )
    args = parser.parse_args()

    source_dir = Path(args.source_dir).expanduser() if args.source_dir else SOURCE_DIR
    if not source_dir.is_dir():
        print(
            f"源素材目录不存在：{source_dir}\n"
            "本仓库只含插件与派生素材；源素材在上游桌面项目 "
            "(MerZlin/dsh-pet-indesktop) 的 assets/characters/shenshen/videos/ 下，"
            "请用 --source-dir 指到该目录。",
            file=sys.stderr,
        )
        return 2

    manifest = load_json(source_dir / "manifest.json")
    strides_raw = load_json(source_dir / "move_strides.json")

    # 源文件用中文名做键，输出 id 用 ASCII；步幅按源名反查后改写成 id 键。
    # 文件里可能混有非步幅字段（字符串等），一律跳过而不是让整条流水线炸掉。
    stride_by_source = {}
    for name, value in strides_raw.items():
        if isinstance(value, dict) and isinstance(value.get("stride"), (int, float)):
            stride_by_source[name] = int(value["stride"])

    clips = []
    strides = {}
    missing = []
    total_bytes = 0
    for category, relative, clip_id in CLIPS:
        source = source_dir / relative
        if not source.is_file():
            missing.append(relative)
            continue
        size = source.stat().st_size
        total_bytes += size
        clips.append(
            {
                "id": clip_id,
                "category": category,
                "file": f"{clip_id}.webm",
                "bytes": size,
            }
        )
        source_name = Path(relative).stem
        if source_name in stride_by_source:
            strides[clip_id] = stride_by_source[source_name]

    if missing:
        print("以下源素材缺失，请先确认素材目录：", file=sys.stderr)
        for item in missing:
            print(f"  - {item}", file=sys.stderr)
        return 3

    total_mb = total_bytes / (1024 * 1024)
    print(f"片段数：{len(clips)}    合计：{total_mb:.2f} MB（预算 {SIZE_BUDGET_MB} MB）")
    if total_mb > SIZE_BUDGET_MB:
        print(
            f"超出预算 {SIZE_BUDGET_MB} MB —— 请减少片段或先重编码，不要直接放大预算。",
            file=sys.stderr,
        )
        return 4

    if args.check:
        print("--check：未写任何文件。")
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # 清掉上一轮产物与早期嵌套目录，保证 assets/ 里只有白名单形状的文件。
    legacy_nested = OUT_DIR / "characters"
    if legacy_nested.exists():
        shutil.rmtree(legacy_nested)
    for stale in list(OUT_DIR.glob("*.webm")) + list(OUT_DIR.glob("*.png")):
        stale.unlink()

    for (_, relative, clip_id) in CLIPS:
        source = source_dir / relative
        if source.is_file():
            shutil.copy2(source, OUT_DIR / f"{clip_id}.webm")

    # 只抽**待机**那一段的静态帧，其余片段不需要。
    #
    # 为什么：静态帧只在「没有在播动画」时显示，而那个状态永远是待机（播完、
    # 走完、点击结束都会回到待机）。给每段动画都准备文件既不会显示，又会在
    # 资源路由不认 .png 时变成 404，被浏览器画成一个带边框的破图占位——正是
    # 用户看到的那个白框。所以：只内联待机帧，一个文件都不落盘。
    idle_ids = [clip["id"] for clip in clips if clip["category"] == "idle"]
    posters = make_posters(idle_ids, OUT_DIR)
    idle_poster = None
    for name in posters.values():
        idle_poster = "data:image/png;base64," + base64.b64encode((OUT_DIR / name).read_bytes()).decode("ascii")
    # 只在顶层放一份：写进每个片段会让同一张图重复 14 次，clips.json 直接翻十倍。
    for clip in clips:
        clip.pop("poster", None)
    # 抽帧产物只用于内联，落盘会让宿主白名单多一个用不到的扩展名。
    for produced_png in OUT_DIR.glob("*.png"):
        produced_png.unlink()

    description = {
        "character": CHARACTER,
        "assetVersion": 1,
        "canvas": CANVAS,
        # 待机帧（内联 PNG，带 alpha）。待机时只放这一张，浏览器不需要再取任何图片。
        "idle_poster": idle_poster,
        "body_box": manifest["body_box"],
        "head_box": manifest.get("head_box"),
        "head_fallback_ratio": HEAD_FALLBACK_RATIO,
        "scale_steps": SCALE_STEPS,
        "default_scale": DEFAULT_SCALE,
        "corner_margin": CORNER_MARGIN,
        "drag_threshold": DRAG_THRESHOLD,
        "move_min_px": MOVE_MIN_PX,
        "move_max_px": MOVE_MAX_PX,
        "move_stride_default_px": MOVE_STRIDE_DEFAULT_PX,
        "chain": CHAIN,
        "move_strides": strides,
        "clips": clips,
    }
    target = OUT_DIR / "clips.json"
    with target.open("w", encoding="utf-8") as handle:
        json.dump(description, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    print(f"已写入 {target}")

    # 预算门必须以**真实产物目录**为准：只看 webm 源大小会漏掉 PNG 与内联的
    # base64，而带 alpha 的帧正好是超预算的那部分。
    shipped = sum(path.stat().st_size for path in OUT_DIR.iterdir() if path.is_file())
    shipped_mb = shipped / (1024 * 1024)
    print(f"产物目录合计：{shipped_mb:.2f} MB（预算 {SIZE_BUDGET_MB} MB）")
    if shipped_mb > SIZE_BUDGET_MB:
        print(
            f"产物超出预算 {SIZE_BUDGET_MB} MB —— 请减少片段或重压 PNG，不要直接放大预算。",
            file=sys.stderr,
        )
        return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
