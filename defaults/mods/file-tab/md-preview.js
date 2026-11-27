// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: Markdown preview with pictures. 2026.
// TextView.markdown shows image syntax as plain text, so the preview draws text pieces with
// TextView.markdown and pictures with image(). src may be relative to the file, absolute, ~/...,
// file:// or https:// (downloaded once into data/md-preview). A video shows a still frame
// (its poster, or the first seconds read by ffmpeg when installed). macOS only.
import { div, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, appHome, theme } from "finch";
import { fontSize, radius } from "./appearance.js";
import { parseBlocks } from "./md-blocks.js";

const OK_EXT = /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;
const MAX_W = 820;

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, "0"); }
const extOf = (s) => (s.split(/[?#]/)[0].match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();

export class MdPreview {
  constructor(dir, remote) { this.dir = dir; this.remote = Boolean(remote); this.cache = new Map(); }

  cacheDir() { return `${appHome()}/data/md-preview`; }

  // Starts loading what is missing; each result redraws the view with the task's own context
  // (the render-time one is no longer valid once the load finishes).
  ensure(src, videoFrame, cx) {
    if (!src || this.remote) return;
    const key = (videoFrame ? "v:" : "i:") + src;
    if (this.cache.has(key)) return;
    this.cache.set(key, { state: "loading" });
    cx.spawn(async (task) => {
      let res;
      try { res = await this.localize(src, videoFrame); } catch (e) { res = { error: String(e?.message ?? e) }; }
      this.cache.set(key, res.error ? { state: "error", error: res.error } : { state: "ready", ...res });
      task.notify();
    });
  }

  get(src, videoFrame) { return this.cache.get((videoFrame ? "v:" : "i:") + src); }

  async localize(src, videoFrame) {
    const cache = this.cacheDir();
    await exec("mkdir", ["-p", cache]);
    const home = (await exec("printenv", ["HOME"])).stdout.trim();
    let abs = null;
    const remote = /^https?:\/\//i.test(src);
    if (/^file:\/\//i.test(src)) abs = decodeURIComponent(src.replace(/^file:\/\//i, ""));
    else if (src.startsWith("~/")) abs = home + src.slice(1);
    else if (src.startsWith("/")) abs = decodeURI(src);
    else if (!remote) abs = `${this.dir}/${decodeURI(src.split(/[?#]/)[0])}`;
    if (remote) {
      const e = extOf(src);
      if (VIDEO_EXT.test(e)) throw new Error("удалённое видео без постера");
      const dest = `${cache}/${hash(src)}${OK_EXT.test(e) ? e : ".img"}`;
      if ((await exec("test", ["-s", dest])).code !== 0) {
        const r = await exec("curl", ["-fsSL", "--max-time", "40", "-o", dest, src]);
        if (r.code !== 0) { await exec("rm", ["-f", dest]); throw new Error("не скачалось: " + (r.stderr || r.code)); }
      }
      return this.finish(dest);
    }
    abs = abs.replace(/\/\.\//g, "/");
    if ((await exec("test", ["-f", abs])).code !== 0) throw new Error("нет файла: " + abs);
    const e = extOf(abs);
    if (VIDEO_EXT.test(e)) {
      if (!videoFrame) throw new Error("видео");
      const dest = `${cache}/${hash(abs)}-frame.jpg`;
      if ((await exec("test", ["-s", dest])).code !== 0) {
        const r = await exec("ffmpeg", ["-v", "error", "-y", "-ss", "1", "-i", abs, "-frames:v", "1", "-vf", "scale=1280:-1", "-q:v", "3", dest], { timeout: 60000 });
        if (r.code !== 0) throw new Error("кадр видео не снят (нужен ffmpeg)");
      }
      return this.finish(dest);
    }
    if (!OK_EXT.test(e)) throw new Error("формат " + e + " не показывается");
    const dest = `${cache}/${hash(abs)}${e}`;
    await exec("ln", ["-sf", abs, dest]);
    return this.finish(dest);
  }

  async finish(dest) {
    let w = 16, h = 9;
    const r = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", dest]);
    const mw = r.stdout.match(/pixelWidth:\s*(\d+)/), mh = r.stdout.match(/pixelHeight:\s*(\d+)/);
    if (mw && mh) { w = +mw[1]; h = +mh[1]; }
    return { rel: "data/md-preview/" + dest.split("/").pop(), w, h };
  }

  picture(entry) {
    const w = Math.min(entry.w, MAX_W), h = Math.round(w * entry.h / entry.w);
    return image(entry.rel).w_full().max_w(w).h(h).flex_none().rounded(radius(8));
  }

  // A column of text and picture blocks.
  render(text, cx) {
    const t = theme();
    const col = v_flex().gap(14).w_full();
    parseBlocks(text).forEach((b, i) => {
      if (b.type === "text") { col.child(TextView.markdown(`ft-md-${i}`, b.value)); return; }
      const isVideo = b.kind === "video";
      const source = isVideo ? (b.poster || b.src) : b.src;
      const frame = isVideo && !b.poster;
      this.ensure(source, frame, cx);
      const st = this.get(source, frame);
      let el;
      if (st?.state === "ready") {
        el = this.picture(st);
        if (isVideo) el = div().relative().w_full().child(el)
          .child(h_flex().absolute().top(0).left(0).w_full().h_full().items_center().justify_center()
            .child(div().px(16).py(8).rounded(radius(20)).bg("#000000a0").text_color("#ffffff").child("▶  видео")));
      } else {
        const msg = this.remote ? "файлы на другой машине не показываются" : !st || st.state === "loading" ? "загружаю…" : st.error;
        el = div().px(12).py(10).rounded(radius(8)).bg(t.hover).text_size(fontSize("fileTab.meta")).text_color(t.dim)
          .child(`${isVideo ? "▶ видео" : "картинка"}: ${b.alt || b.src} (${msg})`);
      }
      const box = v_flex().gap(6).w_full().child(el);
      if (b.caption) box.child(div().text_size(fontSize("fileTab.meta")).text_color(t.dim).child(TextView.markdown(`ft-md-cap-${i}`, b.caption)));
      col.child(box);
    });
    return col;
  }
}
