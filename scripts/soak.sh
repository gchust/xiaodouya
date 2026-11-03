#!/usr/bin/env bash
# 临时：在 CI 模拟器上反复做某一件事，数 adb 断开了几次。
set -u
ARM="$1"
ART=.artifacts
mkdir -p "$ART/maestro" "$ART/soak-flows"
DURATION="${SOAK_SECONDS:-1500}"
setsid bash scripts/e2e-monitor.sh "$ART" &
MON=$!
trap 'kill -- -$MON 2>/dev/null' EXIT
bash scripts/dismiss-anr.sh > "$ART/anr.log" 2>&1 &

cat > "$ART/soak-flows/short.yaml" <<'EOF'
appId: com.android.settings
---
- launchApp
- pressKey: Home
EOF
cat > "$ART/soak-flows/long.yaml" <<'EOF'
appId: com.android.settings
---
- launchApp
- repeat:
    times: 2000
    commands:
      - scroll
      - scrollUntilVisible:
          element: { text: "Network.*" }
          direction: UP
          timeout: 5000
EOF

end=$((SECONDS + DURATION))
n=0; fails=0
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$ART/soak.log"; }
case "$ARM" in
  starts|starts-noreinstall)
    extra=""; [ "$ARM" = starts-noreinstall ] && extra="--no-reinstall-driver"
    while [ $SECONDS -lt $end ]; do
      n=$((n + 1))
      adb wait-for-device
      if maestro test $extra --debug-output "$ART/maestro" --flatten-debug-output "$ART/soak-flows/short.yaml" > "$ART/last.out" 2>&1; then
        log "start $n ok"
      else
        fails=$((fails + 1)); log "start $n FAILED: $(grep -m1 -oE 'device offline|not found|DeviceServerDied[A-Za-z]*|Unknown error|Element not found.*' "$ART/maestro/maestro.log" | tail -1)"
      fi
    done ;;
  airplane)
    maestro test --debug-output "$ART/maestro" --flatten-debug-output "$ART/soak-flows/long.yaml" > "$ART/long.out" 2>&1 &
    M=$!
    while [ $SECONDS -lt $end ]; do
      n=$((n + 1))
      adb shell cmd connectivity airplane-mode enable; sleep 6
      adb shell cmd connectivity airplane-mode disable; log "toggle $n"; sleep 14
      kill -0 $M 2>/dev/null || { log "long flow ended"; maestro test --debug-output "$ART/maestro" --flatten-debug-output "$ART/soak-flows/long.yaml" >> "$ART/long.out" 2>&1 & M=$!; }
    done
    kill $M 2>/dev/null ;;
  idle)
    while [ $SECONDS -lt $end ]; do n=$((n + 1)); adb shell input keyevent KEYCODE_WAKEUP; sleep 10; done ;;
esac
drops=$(awk '{state = ($0 ~ /emulator-[0-9]+[ \t]+device$/) ? "device" : "lost"} prev == "device" && state == "lost" {n++} {prev = state} END {print n + 0}' "$ART/adb-track.log")
log "ARM=$ARM iterations=$n failures=$fails drops=$drops"
echo "### $ARM: iterations=$n failures=$fails drops=$drops" >> "$GITHUB_STEP_SUMMARY"
