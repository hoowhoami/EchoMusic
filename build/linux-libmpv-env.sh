#!/usr/bin/env bash
# Shared Linux libmpv environment setup for EchoMusic launch wrappers.
#
# Electron ships a trimmed libffmpeg.so. When system libmpv is loaded in the
# same process, FFmpeg symbols from Electron can win and make network protocols
# unavailable inside libmpv. This file must be sourced before Electron starts so
# system libav* symbols are preloaded first.

_echo_music_libmpv_flag="ECHO_MUSIC_LIBMPV_ENV_FIXED"

_echo_music_has_command() {
    command -v "$1" >/dev/null 2>&1
}

_echo_music_find_libmpv() {
    local search_paths=(
        "${ECHO_MUSIC_LIBMPV_DIR:-}"
        "/usr/lib/x86_64-linux-gnu"
        "/usr/lib/aarch64-linux-gnu"
        "/usr/lib/i386-linux-gnu"
        "/usr/lib64"
        "/usr/lib"
        "/usr/local/lib"
        "/usr/local/lib64"
    )

    local dir name
    for dir in "${search_paths[@]}"; do
        [ -n "$dir" ] || continue
        for name in libmpv.so.2 libmpv.so.1 libmpv.so; do
            if [ -e "$dir/$name" ]; then
                printf '%s\n' "$dir/$name"
                return 0
            fi
        done
    done

    if _echo_music_has_command ldconfig; then
        ldconfig -p 2>/dev/null | sed -n 's/.*=>[[:space:]]*\(.*libmpv\.so[^[:space:]]*\)$/\1/p' | sed -n '1p'
        return 0
    fi

    return 1
}

_echo_music_find_linked_lib() {
    local libmpv_path="$1"
    local lib_dir="$2"
    local base="$3"
    local escaped_base
    escaped_base=${base//./\\.}

    if _echo_music_has_command ldd && [ -e "$libmpv_path" ]; then
        local linked
        linked=$(ldd "$libmpv_path" 2>/dev/null | sed -n "s/^[[:space:]]*$escaped_base[0-9.]*[[:space:]]*=>[[:space:]]*\\([^[:space:]]*\\).*/\\1/p" | sed -n '1p')
        if [ -n "$linked" ] && [ -e "$linked" ]; then
            printf '%s\n' "$linked"
            return 0
        fi
    fi

    local candidate
    for candidate in "$lib_dir/$base".[0-9]* "$lib_dir/$base"; do
        if [ -e "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    if _echo_music_has_command ldconfig; then
        local ldconfig_match
        ldconfig_match=$(ldconfig -p 2>/dev/null | sed -n "s/.*=>[[:space:]]*\\(.*$escaped_base[^[:space:]]*\\)$/\\1/p" | sed -n '1p')
        if [ -n "$ldconfig_match" ] && [ -e "$ldconfig_match" ]; then
            printf '%s\n' "$ldconfig_match"
            return 0
        fi
    fi

    return 1
}

_echo_music_preload_contains() {
    local lib="$1"
    case " ${LD_PRELOAD:-} " in
        *" $lib "*) return 0 ;;
        *":$lib:"*) return 0 ;;
        *":$lib "*) return 0 ;;
        *" $lib:"*) return 0 ;;
    esac
    return 1
}

_echo_music_prepare_libmpv_env() {
    [ "$(uname -s 2>/dev/null)" = "Linux" ] || return 0
    [ "${!_echo_music_libmpv_flag:-}" = "1" ] && return 0

    local libmpv_path
    libmpv_path=$(_echo_music_find_libmpv)
    [ -n "$libmpv_path" ] && [ -e "$libmpv_path" ] || return 0

    local lib_dir
    lib_dir=$(dirname "$libmpv_path")

    local bases=(
        libavutil.so
        libswresample.so
        libavcodec.so
        libavformat.so
        libswscale.so
        libavfilter.so
    )

    local preload_libs=()
    local base found
    for base in "${bases[@]}"; do
        found=$(_echo_music_find_linked_lib "$libmpv_path" "$lib_dir" "$base")
        if [ -n "$found" ] && [ -e "$found" ] && ! _echo_music_preload_contains "$found"; then
            preload_libs+=("$found")
        fi
    done

    if [ "${#preload_libs[@]}" -gt 0 ]; then
        export LD_PRELOAD="${preload_libs[*]}${LD_PRELOAD:+ $LD_PRELOAD}"
        export LD_LIBRARY_PATH="$lib_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
        export ECHO_MUSIC_LIBMPV_ENV_FIXED=1
    fi
}

_echo_music_prepare_libmpv_env

unset -f _echo_music_has_command
unset -f _echo_music_find_libmpv
unset -f _echo_music_find_linked_lib
unset -f _echo_music_preload_contains
unset -f _echo_music_prepare_libmpv_env
unset _echo_music_libmpv_flag
