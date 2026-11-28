"""Add HLS to the pinned 9.0.2 audio bundle without changing platform flags.

The configure before/after comparison enables exactly HLS/MPEGTS, adding only
hls.c, hls_sample_encryption.c and mpegts.c. All their headers already exist in
the slim bundle. Run with an unmodified FFmpeg 9.0.2 source directory.
"""

import argparse
import difflib
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
vendor = root / "crates/ffmpeg_audio_sys/vendor"
source = args.source
hls = (source / "libavformat/hls.c").read_text()
original = hls
# With custom IO, HTTP is implemented by the caller, not FFmpeg's disabled
# protocol registry. Keep upstream's protocol restrictions for other inputs.
hls = hls.replace(
    "    if (!proto_name)\n        return AVERROR_INVALIDDATA;",
    """    if (!proto_name && (s->flags & AVFMT_FLAG_CUSTOM_IO)) {
        if (av_strstart(url, "https:", NULL)) proto_name = "https";
        else if (av_strstart(url, "http:", NULL)) proto_name = "http";
    }
    if (!proto_name)
        return AVERROR_INVALIDDATA;""",
    1,
)
# Publish a library-owned fact, including EVENT playlists. No private HLS
# structures cross the C/Rust boundary, and no duration heuristic is needed.
needle = "    c->ctx->ctx_flags = c->ctx->ctx_flags & ~(unsigned)AVFMTCTX_UNSEEKABLE;"
hls = hls.replace(
    needle,
    """    if (ret >= 0 && c->n_variants && c->variants[0]->n_playlists) {
        int live = !c->variants[0]->playlists[0]->finished;
        av_dict_set(&c->ctx->metadata, "echo.timeline", live ? "live" : "finite", 0);
    }
""" + needle,
    1,
)
assert hls != original and "echo.timeline" in hls
patch = "".join(
    difflib.unified_diff(
        original.splitlines(True),
        hls.splitlines(True),
        fromfile="a/libavformat/hls.c",
        tofile="b/libavformat/hls.c",
    )
)
(root / "scripts/hls-custom-io.patch").write_text(patch)


def rewrite(name, transform):
    path = vendor / name
    with zipfile.ZipFile(path) as archive:
        entries = {
            info.filename: archive.read(info) for info in archive.infolist() if not info.is_dir()
        }
    entries = transform(entries)
    temp = path.with_suffix(".tmp")
    with zipfile.ZipFile(temp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for key in sorted(entries):
            info = zipfile.ZipInfo(key, date_time=(2026, 9, 18, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, entries[key])
    temp.replace(path)


new_files = ["libavformat/hls.c", "libavformat/hls_sample_encryption.c", "libavformat/mpegts.c"]


def slim(entries):
    # Verify the pinned headers rather than silently mixing FFmpeg revisions.
    for name in ["libavformat/version.h", "libavcodec/version.h"]:
        assert entries[name] == (source / name).read_bytes(), name
    for name in new_files:
        entries[name] = hls.encode() if name.endswith("/hls.c") else (source / name).read_bytes()
    return entries


def configs(entries):
    for name in list(entries):
        text = (
            entries[name].decode(errors="strict")
            if name.endswith(("config_components.h", "demuxer_list.c", "make_dryrun.log"))
            else None
        )
        if text is None:
            continue
        if name.endswith("config_components.h"):
            for component in ["HLS", "MPEGTS"]:
                text = text.replace(
                    f"#define CONFIG_{component}_DEMUXER 0", f"#define CONFIG_{component}_DEMUXER 1"
                )
        elif name.endswith("demuxer_list.c"):
            for symbol, previous in [("hls", "flac"), ("mpegts", "mpc8")]:
                if f"&ff_{symbol}_demuxer," not in text:
                    text = text.replace(
                        f"    &ff_{previous}_demuxer,",
                        f"    &ff_{previous}_demuxer,\n    &ff_{symbol}_demuxer,",
                    )
        else:
            for source_name in new_files:
                if source_name not in text:
                    text += f"\ncc -c -o {source_name[:-2]}.o {source_name}\n"
        entries[name] = text.encode()
    return entries


rewrite("ffmpeg_slim.zip", slim)
rewrite("configs.zip", configs)
