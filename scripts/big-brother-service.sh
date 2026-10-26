#!/bin/sh
# Install or remove the platform-supervised Big Brother observer.
# Secrets are deliberately not copied into either service definition.
set -eu

usage() {
  echo "usage: $0 install|uninstall [--agent-dir DIR] [--interval-secs N] [--socket PATH] [--binary PATH]" >&2
  exit 2
}

command_name=${1:-}
case "$command_name" in
  install|uninstall) shift ;;
  *) usage ;;
esac

agent_dir=${PRIME_AGENT_CODING_AGENT_DIR:-"$HOME/.prime/agent"}
interval_secs=30
socket=
binary=${PA_DAEMON_BIN:-}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent-dir) [ "$#" -ge 2 ] || usage; agent_dir=$2; shift 2 ;;
    --interval-secs) [ "$#" -ge 2 ] || usage; interval_secs=$2; shift 2 ;;
    --socket) [ "$#" -ge 2 ] || usage; socket=$2; shift 2 ;;
    --binary) [ "$#" -ge 2 ] || usage; binary=$2; shift 2 ;;
    *) usage ;;
  esac
done

if [ "$command_name" = install ]; then
  if [ -z "$binary" ]; then
    binary=$(command -v pa-daemon || true)
  fi
  [ -n "$binary" ] || { echo "pa-daemon is not on PATH; pass --binary PATH" >&2; exit 1; }
  [ -x "$binary" ] || { echo "pa-daemon is not executable: $binary" >&2; exit 1; }
fi
case "$interval_secs" in
  ''|*[!0-9]*) echo "--interval-secs must be a positive integer" >&2; exit 2 ;;
esac
[ "$interval_secs" -ge 1 ] || { echo "--interval-secs must be at least 1" >&2; exit 2; }

label=ai.primeintellect.big-brother-observer
launch_dir="$HOME/Library/LaunchAgents"
launch_file="$launch_dir/$label.plist"
systemd_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
systemd_file="$systemd_dir/big-brother-observer.service"

install_macos() {
  mkdir -p "$launch_dir" "$HOME/Library/Logs/BigBrother"
  socket_args=""
  if [ -n "$socket" ]; then
    socket_args="<string>--socket</string><string>$socket</string>"
  fi
  cat >"$launch_file" <<EOF_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$binary</string><string>observer</string>
    <string>--agent-dir</string><string>$agent_dir</string>
    <string>--interval-secs</string><string>$interval_secs</string>
    $socket_args
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRIME_AGENT_CODING_AGENT_DIR</key><string>$agent_dir</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/BigBrother/observer.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/BigBrother/observer.err.log</string>
</dict>
</plist>
EOF_PLIST
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$launch_file"
  echo "installed and started $launch_file"
}

uninstall_macos() {
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$launch_file"
  echo "removed $launch_file"
}

install_linux() {
  mkdir -p "$systemd_dir"
  socket_arg=""
  if [ -n "$socket" ]; then
    socket_arg="--socket $socket"
  fi
  cat >"$systemd_file" <<EOF_UNIT
[Unit]
Description=Big Brother repository review observer
After=default.target

[Service]
Type=simple
ExecStart=$binary observer --agent-dir $agent_dir --interval-secs $interval_secs $socket_arg
Restart=always
RestartSec=10
Environment=PRIME_AGENT_CODING_AGENT_DIR=$agent_dir

[Install]
WantedBy=default.target
EOF_UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now big-brother-observer.service
  echo "installed and started $systemd_file"
}

uninstall_linux() {
  systemctl --user disable --now big-brother-observer.service 2>/dev/null || true
  rm -f "$systemd_file"
  systemctl --user daemon-reload
  echo "removed $systemd_file"
}

case "$(uname -s)" in
  Darwin) [ "$command_name" = install ] && install_macos || uninstall_macos ;;
  Linux) [ "$command_name" = install ] && install_linux || uninstall_linux ;;
  *) echo "unsupported platform: $(uname -s) (use macOS launchd or Linux systemd)" >&2; exit 1 ;;
esac
