# herdr-metabase-dev

A [Herdr](https://herdr.dev) layout for Metabase development. The status bar
shows the current worktree's backend port (click it to open the app) and a
start/stop control for `ee` (`bun dev-ee`). The Spaces list shows each
space's repo and branch on a second line under its name. A Prompts panel on
the right lists your prompts to the current agent (Claude Code or omp); click
one to scroll the agent's terminal back to it. Toggle it with `⌘⇧H` or the
status bar's "Prompts".

![preview](preview.png)

See [RECIPE.md](RECIPE.md) for exactly what it does.

## Install

**With an agent:** in Herdr, ask your agent to "add the Herdr layout from
github.com/mazameli/herdr-metabase-dev".

**By hand:**

```sh
git clone https://github.com/mazameli/herdr-metabase-dev
cp herdr-metabase-dev/layouts/metabase-dev.json ~/.config/herdr-app/layouts/
cp -R herdr-metabase-dev/mods/metabase-{status,spaces,prompts} ~/.config/herdr-app/mods/
for m in status spaces prompts; do herdr-app check ~/.config/herdr-app/mods/metabase-$m; done
herdr-app do layout.switch '{"name":"metabase-dev"}'
```

`ctrl-shift-l` switches back to your previous layout.

For the `⌘⇧H` toggle, add `"cmd-shift-h": "layout.toggle:prompts"` to the
`global` section of `~/.config/herdr-app/keys.json` (see this repo's
`keys.json`). The agent install merges it for you.

## Prerequisites

- `python3`, for the Prompts panel. Jumping to a prompt needs terminal
  scrollback, which Claude Code's fullscreen mode (`"tui": "fullscreen"`)
  doesn't keep.

- [direnv](https://direnv.net), hooked into your shell.
- zsh, with the `ee` alias in `~/.zshrc`:
  ```sh
  alias ee='bun dev-ee'
  ```
- Per-worktree ports, so each worktree's Metabase can run side by side:
  1. Copy the port script onto your PATH:
     ```sh
     cp herdr-metabase-dev/bin/mb-ports ~/.local/bin/
     ```
  2. Add these lines to each worktree's `.envrc`, then run `direnv allow`:
     ```sh
     dotenv
     eval "$(~/.local/bin/mb-ports)"
     ```

  Your main checkout gets 3000/8080. Set `MB_MAIN_CHECKOUT` if it isn't at
  `~/workspace/metabase`. Every other worktree gets its own stable slot
  (3001/8081, 3002/8082, ...).

## Logs

`ee` runs in a background herdr-core terminal named `ee-<port>`. Read its
output with `hc read ee-3007`, or attach to it with `hc attach ee-3007`.
