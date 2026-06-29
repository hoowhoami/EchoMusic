#!/usr/bin/env bash
# Template wrapper for distro packages that launch EchoMusic with system Electron.
# Install this as /usr/bin/echo-music and install linux-libmpv-env.sh beside the
# app payload, or override the paths through the environment variables below.

ECHO_MUSIC_ELECTRON_BIN="${ECHO_MUSIC_ELECTRON_BIN:-electron42}"
ECHO_MUSIC_APP_ASAR="${ECHO_MUSIC_APP_ASAR:-/usr/lib/echo-music/app.asar}"
ECHO_MUSIC_LIBMPV_ENV_HELPER="${ECHO_MUSIC_LIBMPV_ENV_HELPER:-/usr/lib/echo-music/linux-libmpv-env.sh}"

if [ -r "$ECHO_MUSIC_LIBMPV_ENV_HELPER" ]; then
    # shellcheck source=/usr/lib/echo-music/linux-libmpv-env.sh
    . "$ECHO_MUSIC_LIBMPV_ENV_HELPER"
fi

exec "$ECHO_MUSIC_ELECTRON_BIN" "$ECHO_MUSIC_APP_ASAR" "$@"
