#!/bin/sh
# Runs inside cage as speck-ui. Keeps exactly one full-screen browser showing first-boot setup
# (until it's done; on the USB installer, always), Speck (when healthy) or the recovery console
# (when Speck is down), and switches between them.
# The browser is Chromium (Google Chrome on boxes provisioned with BROWSER=chrome); offline speech
# is injected by kiosk-chrome.mjs (speck-voice). See docs/ARCHITECTURE.md §5.
SPECK_URL="${SPECK_UI_URL:-http://127.0.0.1:4310/}"
RECOVERY_URL="${SPECK_RECOVERY_URL:-http://127.0.0.1:4399/}"
SETUP_URL="${RECOVERY_URL%/}/setup"
HEALTH="${SPECK_URL%/}/api/health"
FAILS_TO_RECOVERY=3      # consecutive failed checks (5 s apart) before showing recovery
STARTUP_GRACE=180        # seconds to wait for Speck at session start before showing recovery

healthy() { curl -fsS -o /dev/null --max-time 3 "$HEALTH"; }

# needed | done | unknown (broker not answering: keep showing whatever is on screen)
setup_state() {
  answer=$(curl -fsS --max-time 3 "${RECOVERY_URL%/}/api/setup/needed" 2>/dev/null) || { echo unknown; return; }
  case "$answer" in *'"needed":true'*) echo needed ;; *) echo done ;; esac
}

CHROME_PID=""
SHOWING=""
show() {  # show <speck|recovery|setup>
  [ "$SHOWING" = "$1" ] && [ -n "$CHROME_PID" ] && kill -0 "$CHROME_PID" 2>/dev/null && return
  if [ -n "$CHROME_PID" ]; then
    kill "$CHROME_PID" 2>/dev/null
    wait "$CHROME_PID" 2>/dev/null
  fi
  case "$1" in
    recovery) url=$RECOVERY_URL ;;
    setup) url=$SETUP_URL ;;
    *) url=$SPECK_URL ;;
  esac
  # Chrome via kiosk-chrome.mjs: kiosk flags, plus offline voice injected into the page.
  /usr/bin/node /usr/lib/speck-os/kiosk-chrome.mjs "$url" &
  CHROME_PID=$!
  SHOWING=$1
}

trap 'kill "$CHROME_PID" 2>/dev/null; exit 0' TERM INT

# Session start: wait for setup or Speck, but don't leave a black screen forever.
i=0
while [ $i -lt $STARTUP_GRACE ]; do
  [ "$(setup_state)" = needed ] && break
  healthy && break
  i=$((i + 1)); sleep 1
done
if [ "$(setup_state)" = needed ]; then show setup
elif healthy; then show speck
else show recovery
fi

fails=0
while :; do
  sleep 5
  setup=$(setup_state)
  if [ "$setup" = needed ] || { [ "$setup" = unknown ] && [ "$SHOWING" = setup ]; }; then
    show setup
  elif healthy; then
    fails=0
    show speck
  else
    fails=$((fails + 1))
    [ $fails -ge $FAILS_TO_RECOVERY ] && show recovery
  fi
  # Chrome exited on its own: bring it back showing whatever is current.
  kill -0 "$CHROME_PID" 2>/dev/null || { CHROME_PID=""; show "${SHOWING:-speck}"; }
done
