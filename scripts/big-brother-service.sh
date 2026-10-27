#!/bin/sh
# Install or remove the platform-supervised Big Brother services: the
# observer (always) and, with --supervisor, the Prime Agent supervisor the
# observer talks to. Secrets are deliberately not copied into either
# service definition.
set -eu

usage() {
  echo "usage: $0 install|uninstall [--agent-dir DIR] [--interval-secs N] [--socket PATH] [--binary PATH] [--supervisor]" >&2
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
with_supervisor=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent-dir) [ "$#" -ge 2 ] || usage; agent_dir=$2; shift 2 ;;
    --interval-secs) [ "$#" -ge 2 ] || usage; interval_secs=$2; shift 2 ;;
    --socket) [ "$#" -ge 2 ] || usage; socket=$2; shift 2 ;;
    --binary) [ "$#" -ge 2 ] || usage; binary=$2; shift 2 ;;
    --supervisor) with_supervisor=true; shift ;;
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

observer_label=ai.primeintellect.big-brother-observer
supervisor_label=ai.primeintellect.big-brother-supervisor
launch_dir="$HOME/Library/LaunchAgents"
observer_plist="$launch_dir/$observer_label.plist"
supervisor_plist="$launch_dir/$supervisor_label.plist"
systemd_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
observer_unit="$systemd_dir/big-brother-observer.service"
supervisor_unit="$systemd_dir/big-brother-supervisor.service"
log_dir="$HOME/Library/Logs/BigBrother"

# The kernel bootstrap shells out to uv (Homebrew or ~/.local/bin, never
# /usr/bin), and platform services run with a minimal PATH: hand both
# service definitions the search path the user's shell would have.
service_path="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

socket_args_observer=""
socket_arg_supervisor=""
if [ -n "$socket" ]; then
  socket_args_observer="<string>--socket</string><string>$socket</string>"
  socket_arg_supervisor="--socket $socket"
fi

install_macos() {
  mkdir -p "$launch_dir" "$log_dir"
  if [ "$with_supervisor" = true ]; then
    cat >"$supervisor_plist" <<EOF_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$supervisor_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$binary</string><string>supervisor</string>
    <string>--agent-dir</string><string>$agent_dir</string>$socket_args_observer
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRIME_AGENT_CODING_AGENT_DIR</key><string>$agent_dir</string>
    <key>PATH</key><string>$service_path</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$log_dir/supervisor.log</string>
  <key>StandardErrorPath</key><string>$log_dir/supervisor.err.log</string>
</dict>
</plist>
EOF_PLIST
    launchctl bootout "gui/$(id -u)/$supervisor_label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$supervisor_plist"
    echo "installed and started $supervisor_plist"
  fi
  cat >"$observer_plist" <<EOF_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$observer_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$binary</string><string>observer</string>
    <string>--agent-dir</string><string>$agent_dir</string>
    <string>--interval-secs</string><string>$interval_secs</string>
    $socket_args_observer
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRIME_AGENT_CODING_AGENT_DIR</key><string>$agent_dir</string>
    <key>PATH</key><string>$service_path</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$log_dir/observer.log</string>
  <key>StandardErrorPath</key><string>$log_dir/observer.err.log</string>
</dict>
</plist>
EOF_PLIST
  launchctl bootout "gui/$(id -u)/$observer_label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$observer_plist"
  echo "installed and started $observer_plist"
}

uninstall_macos() {
  launchctl bootout "gui/$(id -u)/$observer_label" 2>/dev/null || true
  rm -f "$observer_plist"
  echo "removed $observer_plist"
  launchctl bootout "gui/$(id -u)/$supervisor_label" 2>/dev/null || true
  rm -f "$supervisor_plist"
  echo "removed $supervisor_plist"
}

install_linux() {
  mkdir -p "$systemd_dir"
  if [ "$with_supervisor" = true ]; then
    cat >"$supervisor_unit" <<EOF_UNIT
[Unit]
Description=Prime Agent supervisor (Big Brother's review daemon)
After=default.target

[Service]
Type=simple
ExecStart=$binary supervisor --agent-dir $agent_dir $socket_arg_supervisor
Restart=always
RestartSec=10
Environment=PRIME_AGENT_CODING_AGENT_DIR=$agent_dir
Environment=PATH=$service_path

[Install]
WantedBy=default.target
EOF_UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now big-brother-supervisor.service
    echo "installed and started $supervisor_unit"
  fi
  cat >"$observer_unit" <<EOF_UNIT
[Unit]
Description=Big Brother repository review observer
After=default.target

[Service]
Type=simple
ExecStart=$binary observer --agent-dir $agent_dir --interval-secs $interval_secs $socket_arg_supervisor
Restart=always
RestartSec=10
Environment=PRIME_AGENT_CODING_AGENT_DIR=$agent_dir
Environment=PATH=$service_path

[Install]
WantedBy=default.target
EOF_UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now big-brother-observer.service
  echo "installed and started $observer_unit"
}

uninstall_linux() {
  systemctl --user disable --now big-brother-observer.service 2>/dev/null || true
  rm -f "$observer_unit"
  echo "removed $observer_unit"
  systemctl --user disable --now big-brother-supervisor.service 2>/dev/null || true
  rm -f "$supervisor_unit"
  echo "removed $supervisor_unit"
  systemctl --user daemon-reload
}

case "$(uname -s)" in
  Darwin) [ "$command_name" = install ] && install_macos || uninstall_macos ;;
  Linux) [ "$command_name" = install ] && install_linux || uninstall_linux ;;
  *) echo "unsupported platform: $(uname -s) (use macOS launchd or Linux systemd)" >&2; exit 1 ;;
esac
