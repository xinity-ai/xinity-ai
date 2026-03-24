import type { CommandModule } from "yargs";
import { basename } from "path";

const SHELLS = ["bash", "zsh", "fish"] as const;
type Shell = (typeof SHELLS)[number];

/** Detect the user's shell from $SHELL, falling back to bash. */
function detectShell(): Shell {
  const shell = basename(process.env.SHELL ?? "");
  if (SHELLS.includes(shell as Shell)) return shell as Shell;
  return "bash";
}

function bashScript(): string {
  return `###-begin-xinity-completions-###
#
# yargs command completion script
#
# Installation: xinity completion bash >> ~/.bashrc
#    or xinity completion bash >> ~/.bash_profile on OSX.
#
_xinity_yargs_completions()
{
    local cur_word args type_list

    cur_word="\${COMP_WORDS[COMP_CWORD]}"
    args=("\${COMP_WORDS[@]}")

    # ask yargs to generate completions.
    type_list=$(xinity --get-yargs-completions "\${args[@]}")

    COMPREPLY=( $(compgen -W "\${type_list}" -- \${cur_word}) )

    # if no match was found, fall back to filename completion
    if [ \${#COMPREPLY[@]} -eq 0 ]; then
      COMPREPLY=()
    fi

    return 0
}
complete -o bashdefault -o default -F _xinity_yargs_completions xinity
###-end-xinity-completions-###`;
}

function zshScript(): string {
  return `#compdef xinity

###-begin-xinity-completions-###
#
# yargs command completion script for zsh
#
# Installation: xinity completion zsh > ~/.zsh/completions/_xinity
#    then add ~/.zsh/completions to your fpath:
#    fpath=(~/.zsh/completions $fpath)
#
#    Or for oh-my-zsh: xinity completion zsh > ~/.oh-my-zsh/completions/_xinity
#
_xinity() {
    local completions
    completions=("\${(@f)$(xinity --get-yargs-completions "\${words[@]}")}")
    compadd -a completions
}

compdef _xinity xinity
###-end-xinity-completions-###`;
}

function fishScript(): string {
  return `###-begin-xinity-completions-###
#
# yargs command completion script for fish
#
# Installation: xinity completion fish > ~/.config/fish/completions/xinity.fish
#
function __xinity_completions
    set -l args (commandline -opc)
    set -e args[1]
    xinity --get-yargs-completions $args (commandline -ct)
end

complete -c xinity -f -a '(__xinity_completions)'
###-end-xinity-completions-###`;
}

const scripts: Record<Shell, () => string> = {
  bash: bashScript,
  zsh: zshScript,
  fish: fishScript,
};

export const completionCommand: CommandModule = {
  command: "completion [shell]",
  describe: "Generate shell completion script",
  builder: (yargs) =>
    yargs.positional("shell", {
      describe: "Shell type (auto-detected from $SHELL if omitted)",
      type: "string",
      choices: [...SHELLS],
    }),
  handler: (argv) => {
    const shell = (argv.shell as Shell) ?? detectShell();
    console.log(scripts[shell]());
  },
};
