import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import { agents, focused, theme, run, exec, appHome, notify } from "herdr";

// Every prompt you typed to the current agent, oldest first, latest at the bottom.
// Click one to scroll that agent's terminal to where you sent it.
// prompts.py (next to this file) finds the agent's transcript (Claude Code or omp)
// and the prompt's line in the terminal's scrollback.
const SCRIPT = () => `${appHome()}/mods/metabase-prompts/prompts.py`;

export default class Prompts extends View {
  init(_props, cx) {
    this.addr = null;      // the agent shown
    this.data = {};        // address -> { key, prompts, error, agent }
    this.loading = null;   // address being read
    this.picked = null;    // index last clicked
    this.scroll = ScrollHandle.new();
    cx.timer.every(3000, (cx) => this.load(cx));
  }

  // The focused agent; else an agent in the focused tab; else the last one shown.
  current() {
    const f = focused();
    const list = agents();
    const a = list.find((x) => x.address === f?.terminal)
      ?? list.find((x) => x.address === f?.agent)
      ?? list.find((x) => x.tab === f?.tab);
    if (a) this.addr = a.address;
    return list.find((x) => x.address === this.addr) ?? null;
  }

  load(cx) {
    const addr = this.addr;
    if (!addr || addr.includes("/") || this.loading === addr) return;
    this.loading = addr;
    const had = this.data[addr];
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [SCRIPT(), "list", addr, had?.key ?? ""]);
        const d = JSON.parse(r.stdout || "{}");
        if (!d.unchanged) {
          const before = had?.prompts?.length ?? -1;
          this.data[addr] = { key: d.size, prompts: d.prompts ?? [], error: d.error, agent: d.agent };
          const n = this.data[addr].prompts.length;
          if (n !== before && n > 0 && addr === this.addr) this.scroll.scroll_to_item(n - 1);
          cx.notify();
        }
      } catch (e) {
        this.data[addr] = { prompts: [], error: String(e) };
        cx.notify();
      } finally {
        this.loading = null;
      }
    });
  }

  jump(cx, index) {
    const addr = this.addr;
    this.picked = index;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("python3", [SCRIPT(), "locate", addr, String(index)]).catch((e) => ({ stdout: JSON.stringify({ error: String(e) }) }));
      let d;
      try { d = JSON.parse(r.stdout); } catch { d = { error: "Couldn't find it" }; }
      if (d.error) {
        notify({ title: "Can't jump to that prompt", body: d.error, level: "warning", timeout: 4000 });
        return;
      }
      run("terminal.scroll", { terminal: addr, to: "bottom" });
      if (d.lines_up > 0) run("terminal.scroll", { terminal: addr, lines: -d.lines_up });
    });
  }

  render(cx) {
    const t = theme();
    const agent = this.current();
    const addr = this.addr;
    const d = addr ? this.data[addr] : null;
    if (addr && !d && this.loading !== addr) this.load(cx);
    const prompts = d?.prompts ?? [];
    const time = (ts) => {
      const dt = ts ? new Date(ts) : null;
      return dt && !isNaN(dt) ? dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    };

    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Prompts"))
      .when(prompts.length > 0, (el) => el.child(div().text_color(t.dim).text_size(11.5).child(String(prompts.length))))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(11.5).text_color(t.dim)
        .child(agent ? `${agent.space_name} / ${agent.tab_name || agent.tab_index}` : ""))
      .child(div().id("prompts-hide").size(24).flex_none().flex().items_center().justify_center().rounded(6)
        .cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("layout.hide", { id: "prompts" }))
        .child("✕"));

    const note = (text) => div().p(14).text_size(12).text_color(t.dim).child(text);
    let body;
    if (!addr) body = note("Focus an agent to see your prompts to it.");
    else if (addr.includes("/")) body = note("Agents on other machines aren't supported yet.");
    else if (!d) body = note("Reading…");
    else if (d.error && !prompts.length) body = note(d.error);
    else if (!prompts.length) body = note("No prompts yet.");
    else body = v_flex().id("prompt-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).p(8).gap(6)
      .children(prompts.map((p, i) => v_flex().id(`prompt-${i}`).flex_none().gap(4).px(10).py(8).rounded(8)
        .bg(this.picked === i ? t.selected : t.surface).border_1().border_color(this.picked === i ? t.accent : t.border)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.jump(cx, i))
        .child(h_flex().text_size(10.5).text_color(t.dim).child(`#${i + 1}`).child(div().flex_1()).child(time(p.ts)))
        .child(div().max_h(96).overflow_hidden().text_size(12.5).text_color(t.foreground).child(p.text))));

    return v_flex().id("prompts").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(header)
      .child(body);
  }
}
