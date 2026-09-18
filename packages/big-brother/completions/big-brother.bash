_big_brother_completion() {
  local current previous
  current="${COMP_WORDS[COMP_CWORD]}"
  previous="${COMP_WORDS[COMP_CWORD-1]}"
  if [[ "$previous" == "--config" ]]; then
    COMPREPLY=( $(compgen -f -- "$current") )
    return
  fi
  if [[ "$COMP_CWORD" == 1 ]]; then
    COMPREPLY=( $(compgen -W "agent config review watch service completion --help" -- "$current") )
    return
  fi
  case "${COMP_WORDS[1]}" in
    agent) COMPREPLY=() ;;
    config) COMPREPLY=( $(compgen -W "validate --config --help" -- "$current") ) ;;
    review) COMPREPLY=( $(compgen -W "--config --repo --commit --help" -- "$current") ) ;;
    watch) COMPREPLY=( $(compgen -W "--config --once --interval-ms --help" -- "$current") ) ;;
    service) COMPREPLY=( $(compgen -W "render launchd systemd --config --executable --working-directory --env-file --label --restart-seconds --help" -- "$current") ) ;;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$current") ) ;;
  esac
}
complete -F _big_brother_completion big-brother
