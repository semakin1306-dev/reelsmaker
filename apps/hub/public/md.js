// Безопасный мини-markdown для окна агента: сначала экранирование, потом разметка.
// Заголовки, **жирный**, *курсив*, `код`, блоки ```, списки, таблицы | a | b |, ссылки [текст](http…).
(function () {
  const escMd = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function inline(s) {
    const codes = [];
    let t = String(s).replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    t = escMd(t)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/__([^_]+)__/g, "<b>$1</b>")
      .replace(/(^|[\s(«"])\*([^*\s][^*]*?)\*(?=[\s).,:;!?»"]|$)/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + escMd(codes[Number(i)]) + "</code>");
  }

  const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const isList = (l) => /^\s*([-*•]|\d+[.)])\s+/.test(l);

  window.md = function md(src) {
    const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*```/.test(l)) {
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push("<pre><code>" + escMd(body.join("\n")) + "</code></pre>");
        continue;
      }
      if (/\|/.test(l) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(l);
        i += 2;
        const rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push(
          '<div class="md-tbl"><table><tr>' + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr>" +
            rows.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") + "</table></div>",
        );
        continue;
      }
      const h = /^\s*(#{1,6})\s+(.*)$/.exec(l);
      if (h) {
        out.push('<div class="md-h">' + inline(h[2]) + "</div>");
        i++;
        continue;
      }
      if (isList(l)) {
        const ordered = /^\s*\d+[.)]\s+/.test(l);
        const items = [];
        while (i < lines.length && isList(lines[i]) && /^\s*\d+[.)]\s+/.test(lines[i]) === ordered) {
          let item = lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, "");
          // продолжение пункта на следующей строке с отступом
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !isList(lines[i])) item += " " + lines[i++].trim();
          items.push("<li>" + inline(item) + "</li>");
        }
        out.push((ordered ? "<ol>" : "<ul>") + items.join("") + (ordered ? "</ol>" : "</ul>"));
        continue;
      }
      if (!l.trim()) {
        i++;
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^\s*#{1,6}\s/.test(lines[i]) && !isList(lines[i]) &&
        !(/\|/.test(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))) para.push(inline(lines[i++]));
      out.push("<p>" + para.join("<br>") + "</p>");
    }
    return out.join("");
  };
})();
