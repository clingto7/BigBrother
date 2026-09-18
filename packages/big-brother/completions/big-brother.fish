complete -c big-brother -n '__fish_use_subcommand' -a 'agent' -d 'start the Big Brother Prime agent for login and model setup'
complete -c big-brother -n '__fish_use_subcommand' -a 'config' -d 'validate control-plane configuration'
complete -c big-brother -n '__fish_use_subcommand' -a 'review' -d 'review one immutable commit'
complete -c big-brother -n '__fish_use_subcommand' -a 'watch' -d 'monitor repositories continuously'
complete -c big-brother -n '__fish_use_subcommand' -a 'service' -d 'render a platform service definition'
complete -c big-brother -n '__fish_use_subcommand' -a 'completion' -d 'print shell completion script'
complete -c big-brother -n '__fish_seen_subcommand_from config' -a 'validate'
complete -c big-brother -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
complete -c big-brother -n '__fish_seen_subcommand_from config review watch service' -l config -r -F
complete -c big-brother -n '__fish_seen_subcommand_from review' -l repo -r
complete -c big-brother -n '__fish_seen_subcommand_from review' -l commit -r
complete -c big-brother -n '__fish_seen_subcommand_from watch' -l once
complete -c big-brother -n '__fish_seen_subcommand_from watch' -l interval-ms -r
complete -c big-brother -n '__fish_seen_subcommand_from service' -a 'render'
complete -c big-brother -n '__fish_seen_subcommand_from service' -a 'launchd systemd'
complete -c big-brother -n '__fish_seen_subcommand_from service' -l executable -r -F
complete -c big-brother -n '__fish_seen_subcommand_from service' -l working-directory -r -a '(__fish_complete_directories (commandline -ct))'
complete -c big-brother -n '__fish_seen_subcommand_from service' -l env-file -r -F
complete -c big-brother -n '__fish_seen_subcommand_from service' -l label -r
complete -c big-brother -n '__fish_seen_subcommand_from service' -l restart-seconds -r
