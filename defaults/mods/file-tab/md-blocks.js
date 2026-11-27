// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: Markdown preview with pictures. 2026.
// Splits a Markdown document into text pieces and media blocks. No Finch imports: it is also
// run by tests. Understands ![alt](src), <img>, <video poster> and <figure> with <figcaption>.
const unesc = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")); return m ? unesc(m[1] ?? m[2]) : ""; };
const captionMd = (html) => html.replace(/<a\s+[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

export function parseBlocks(src) {
  const blocks = [];
  const pieces = src.replace(/\r\n/g, "\n").split(/(^```[^\n]*\n[\s\S]*?^```[^\n]*$)/m);
  const token = /<figure\b[\s\S]*?<\/figure>|<video\b[\s\S]*?<\/video>|<img\b[^>]*>|!\[[^\]]*\]\(\s*[^)\n]*\)/gi;
  const pushText = (t) => { if (t.trim()) blocks.push({ type: "text", value: t }); };
  pieces.forEach((piece, i) => {
    if (i % 2 === 1) { pushText(piece); return; } // fenced code stays text
    let last = 0, m;
    token.lastIndex = 0;
    while ((m = token.exec(piece))) {
      pushText(piece.slice(last, m.index)); last = m.index + m[0].length;
      const raw = m[0];
      if (/^<figure/i.test(raw)) {
        const video = raw.match(/<video\b[^>]*>/i)?.[0], img = raw.match(/<img\b[^>]*>/i)?.[0];
        const cap = raw.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1];
        const b = video ? { type: "media", kind: "video", src: attr(video, "src"), poster: attr(video, "poster"), alt: attr(video, "aria-label") }
          : { type: "media", kind: "image", src: img ? attr(img, "src") : "", alt: img ? attr(img, "alt") : "" };
        if (cap) b.caption = captionMd(cap);
        blocks.push(b);
      } else if (/^<video/i.test(raw)) {
        blocks.push({ type: "media", kind: "video", src: attr(raw, "src"), poster: attr(raw, "poster"), alt: attr(raw, "aria-label") });
      } else if (/^<img/i.test(raw)) {
        blocks.push({ type: "media", kind: "image", src: attr(raw, "src"), alt: attr(raw, "alt") });
      } else {
        const mm = raw.match(/^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)$/);
        if (mm) blocks.push({ type: "media", kind: "image", src: mm[2], alt: mm[1] });
        else pushText(raw);
      }
    }
    pushText(piece.slice(last));
  });
  return blocks;
}
