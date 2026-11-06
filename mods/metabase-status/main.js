import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, focused, hc, notify } from "herdr";

export default class MetabaseStatus extends View {
  // MB_JETTY_PORT as direnv would set it in the shown space's folder
  // (per-worktree ports come from .envrc -> ~/.local/bin/mb-ports).
  init(_props, cx) {
    this.ports = {}; // folder -> port string, or "" when unset
    this.folder = null;
    cx.timer.every(15000, (cx) => this.refresh(cx, true));
    // `ee` (bun dev-ee) per worktree: folder -> "stopped" | "starting" | "running" | "stopping"
    this.dev = {};
    this.stopping = {}; // folder -> true after a kill, until it's really down
    this.ticks = 0;
    cx.timer.every(2000, (cx) => {
      // Every 2 s while starting/stopping, every 6 s otherwise.
      const w = this.where();
      const st = w && this.dev[w.folder];
      if (st === "starting" || st === "stopping" || this.ticks++ % 3 === 0) this.poll(cx);
    });
  }

  // Each worktree's `ee` runs in a background herdr-core terminal with this label.
  label(folder) { return `mbdev=${folder}`; }

  async devTerminal(folder) {
    try {
      const r = await hc(["ls", "--json", "--label", this.label(folder)]);
      return JSON.parse(r.stdout).terminals?.[0]?.address ?? null;
    } catch (_e) { return null; }
  }

  async answers(url) {
    try {
      const r = await exec("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2", url]);
      return r.stdout.trim();
    } catch (_e) { return ""; }
  }

  poll(cx) {
    const w = this.where();
    if (!w || w.machine) return;
    const ports = this.ports[`:${w.folder}`];
    if (!ports) return;
    const [port, fe] = ports.split(" ");
    cx.spawn(async (cx) => {
      const term = await this.devTerminal(w.folder);
      const health = await this.answers(`http://localhost:${port}/api/health`);
      const feUp = (await this.answers(`http://localhost:${fe || 8080}/`)) !== "000";
      const backendUp = health === "200";
      const anyUp = Boolean(term) || (health !== "" && health !== "000");
      let st;
      if (this.stopping[w.folder]) {
        if (anyUp) st = "stopping"; else { delete this.stopping[w.folder]; st = "stopped"; }
      } else if (backendUp && (feUp || !term)) st = "running";
      else if (anyUp) st = "starting";
      else st = "stopped";
      this.term = this.term || {};
      this.term[w.folder] = term;
      if (this.dev[w.folder] !== st) { this.dev[w.folder] = st; cx.notify(); }
    });
  }

  toggle(cx, w, port) {
    const st = this.dev[w.folder] ?? "stopped";
    if (st === "stopping") return;
    if (st === "stopped") {
      this.dev[w.folder] = "starting";
      cx.spawn(async (cx) => {
        // A login+interactive zsh gets `ee` and PATH; direnv/mise give this worktree's ports and tools.
        const script = 'eval "$(direnv export zsh)"; (( $+commands[mise] )) && eval "$(mise hook-env -s zsh)"; ee';
        const r = await hc(["run", "--bg", "--json", "--no-parent", "--rm", "--name", `ee-${port}`,
          "--cwd", w.folder, "--label", this.label(w.folder), "--", "zsh", "-lic", script]);
        if (r.code !== 0) {
          this.dev[w.folder] = "stopped";
          notify({ title: "Couldn't start ee", body: (r.stderr || r.stdout).trim(), level: "error" });
        }
        this.poll(cx);
        cx.notify();
      });
    } else {
      this.dev[w.folder] = "stopping";
      this.stopping[w.folder] = true;
      cx.spawn(async (cx) => {
        const term = await this.devTerminal(w.folder);
        if (term) await hc(["kill", term]);
        else {
          // Started outside Herdr (e.g. `ee` in a shell): stop whatever is listening on the backend port.
          const r = await exec("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]).catch(() => null);
          const pids = (r?.stdout ?? "").split(/\s+/).filter(Boolean);
          if (pids.length) await exec("kill", pids).catch(() => {});
        }
        this.poll(cx);
      });
    }
    cx.notify();
  }

  devControl(t, cx, w, port) {
    const st = this.dev[w.folder] ?? "stopped";
    const look = {
      stopped: { text: "Not running", color: t.ansi1 },
      starting: { text: "Starting…", color: t.ansi3 },
      running: { text: "Running", color: t.ansi2 },
      stopping: { text: "Stopping…", color: t.ansi3 },
    }[st];
    const light = div().size(7).rounded(4).bg(look.color)
      .when(st === "starting" || st === "stopping", el => el.loop("opacity", { from: 0.35, to: 1, period: 1000 }));
    return h_flex().id("ee-control").gap(6).items_center().px(6).py(1).rounded(4)
      .when(st !== "stopping", el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => this.toggle(cx, w, port))
      .child(light).child(look.text);
  }

  where() {
    const space = spaces().find(s => s.active);
    if (!space) return null;
    const f = focused();
    const folder = (f?.space === space.id && f?.cwd) || space.folder;
    return folder ? { folder, machine: space.machine } : null;
  }

  refresh(cx, force) {
    const w = this.where();
    if (!w) return;
    const key = `${w.machine ?? ""}:${w.folder}`;
    if (!force && key in this.ports) return;
    if (!(key in this.ports)) this.ports[key] = "";
    cx.spawn(async (cx) => {
      let port = "";
      for (const bin of ["direnv", "/opt/homebrew/bin/direnv"]) {
        try {
          const r = await exec(bin, ["exec", w.folder, "sh", "-c", '[ -n "$MB_JETTY_PORT" ] && echo "$MB_JETTY_PORT ${MB_FRONTEND_DEV_PORT:-8080}"'], { cwd: w.folder, on: w.machine });
          port = r.code === 0 ? r.stdout.trim() : "";
          break;
        } catch (_e) { /* not found under this name; try the next */ }
      }
      if (this.ports[key] !== port) { this.ports[key] = port; cx.notify(); this.poll(cx); }
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render(cx) {
    const t = theme();
    const w = this.where();
    const key = w ? `${w.machine ?? ""}:${w.folder}` : null;
    if (key && !(key in this.ports)) this.refresh(cx, false);
    const port = key ? (this.ports[key] ?? "").split(" ")[0] : "";
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .when(Boolean(port), el => el.child(div().id("jetty-port").cursor_pointer().hover(s => s.text_color(t.foreground))
        .on_click(() => { exec("open", [`http://localhost:${port}/`]).catch(() => {}); })
        .child(`Port ${port}`)))
      .when(Boolean(port) && !w.machine, el => el.child(this.devControl(t, cx, w, port)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
