#!/usr/bin/env bash
# E2E 期间记录现场，查模拟器断开用。只在宿主机上取数，不发 adb shell：不给设备添负担。
#   .artifacts/adb-track.log    adb server 推送的每次设备状态变化（断开多短都留得下）
#   .artifacts/e2e-monitor.log  每 20 秒一行：负载、CPU、内存、模拟器进程、设备状态
set -u
ART="${1:?要写日志目录}"
INTERVAL="${E2E_MONITOR_SECONDS:-20}"

now() { date -u +%H:%M:%S; }

track_devices() {
  while true; do
    # track-devices 每次变化输出一行，前面带 4 位十六进制长度。server 重启时它会退出，这本身也要留痕。
    while IFS= read -r line; do
      echo "$(now) ${line}"
    done < <(adb track-devices 2>&1 </dev/null)
    echo "$(now) track-devices 退出"
    sleep 1
  done
}

cpu_line() { awk '/^cpu /{print $2+$3+$4+$7+$8, $9, $2+$3+$4+$5+$6+$7+$8+$9; exit}' /proc/stat; }

sample() {
  local busy steal total prev_busy=0 prev_steal=0 prev_total=0 prev_qemu=0 ncpu
  ncpu="$(nproc)"
  while true; do
    read -r busy steal total < <(cpu_line)
    local dt=$((total - prev_total)) pid ticks=0 rss=0 state
    # 第一行是开机以来的平均值，后面每行是这 20 秒内的。
    local busy_pct=$(( dt > 0 ? (busy - prev_busy) * 100 / dt : 0 ))
    local steal_pct=$(( dt > 0 ? (steal - prev_steal) * 100 / dt : 0 ))
    # 模拟器进程这段时间用了几个核（100% 是一个核）。
    pid="$(pgrep -f 'qemu-system-x86_64' | head -1 || true)"
    if [ -n "$pid" ] && [ -r "/proc/$pid/stat" ]; then
      read -r ticks rss < <(awk '{print $14 + $15, int($24 * 4096 / 1048576)}' "/proc/$pid/stat")
    fi
    local qemu_pct=$(( dt > 0 && prev_qemu > 0 ? (ticks - prev_qemu) * 100 * ncpu / dt : 0 ))
    prev_busy=$busy; prev_steal=$steal; prev_total=$total; prev_qemu=$ticks
    state="$(adb get-state 2>&1 </dev/null | tail -1)"
    echo "$(now) load=$(cut -d' ' -f1-3 /proc/loadavg | tr ' ' ',') busy=${busy_pct}% steal=${steal_pct}% mem_avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)M qemu=${qemu_pct}%/${rss}M adb=${state}"
    sleep "$INTERVAL"
  done
}

track_devices >> "$ART/adb-track.log" 2>&1 &
TRACK_PID=$!
trap 'kill "$TRACK_PID" 2>/dev/null; pkill -P "$TRACK_PID" 2>/dev/null' EXIT
sample >> "$ART/e2e-monitor.log" 2>&1
