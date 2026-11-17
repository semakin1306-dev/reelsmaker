// Страница интерфейса: один HTML с встроенным JS, без сборки и внешних файлов.
export const PAGE_HTML = /* html */ `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ReelsMaker</title>
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<style>
  :root { --bg:#14161a; --panel:#1d2026; --line:#2c3038; --text:#e7e9ee; --muted:#9097a3; --acc:#4f8cff; --ok:#3fb27f; --bad:#e5534b; --warn:#d6a03a; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 system-ui, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
  header { display:flex; align-items:center; gap:16px; padding:10px 18px; border-bottom:1px solid var(--line); }
  header h1 { font-size:17px; margin:0; }
  header .muted { font-size:12px; }
  main { display:grid; grid-template-columns: 240px 1fr 430px; height: calc(100vh - 49px); }
  main > section { overflow:auto; }
  aside { border-right:1px solid var(--line); padding:10px; overflow:auto; }
  section { padding:14px 18px; overflow:auto; }
  .muted { color:var(--muted); }
  .story { padding:8px 10px; border-radius:8px; cursor:pointer; margin-bottom:4px; }
  .story:hover { background:var(--panel); }
  .story.sel { background:#25324a; }
  .story b { display:block; }
  .story small { color:var(--muted); }
  h2 { font-size:18px; margin:0 0 4px; }
  h3 { font-size:14px; margin:18px 0 8px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  table { border-collapse:collapse; width:100%; }
  td, th { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  .tag { display:inline-block; padding:1px 7px; border-radius:10px; font-size:12px; background:var(--line); }
  .tag.hook { background:#5a3a14; } .tag.final { background:#203f5e; }
  .ok { color:var(--ok); } .bad { color:var(--bad); } .warn { color:var(--warn); }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin:10px 0; }
  .row { display:flex; flex-wrap:wrap; gap:14px; align-items:center; }
  button { background:var(--acc); color:#fff; border:0; border-radius:7px; padding:7px 14px; font:inherit; cursor:pointer; }
  button.sec { background:var(--line); color:var(--text); }
  button:disabled { opacity:.5; cursor:default; }
  input[type=number] { width:64px; }
  input, select { background:#111318; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:5px 7px; font:inherit; }
  label { user-select:none; }
  .presets label { margin-right:10px; white-space:nowrap; }
  .bar { height:8px; background:var(--line); border-radius:4px; overflow:hidden; margin:8px 0; }
  .bar > i { display:block; height:100%; background:var(--acc); transition:width .3s; }
  pre.log { max-height:200px; overflow:auto; background:#0f1115; padding:8px; border-radius:6px; font-size:12px; white-space:pre-wrap; margin:6px 0 0; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(190px, 1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .card .media { aspect-ratio:9/16; background:#000; display:flex; align-items:center; justify-content:center; cursor:pointer; position:relative; }
  .card .media img, .card .media video { width:100%; height:100%; object-fit:contain; }
  .card .media .play { position:absolute; font-size:42px; opacity:.8; text-shadow:0 0 12px #000; }
  .card .body { padding:8px 10px; font-size:13px; }
  .card .hook { font-weight:600; margin-bottom:4px; }
  .card .meta { color:var(--muted); font-size:12px; }
  .card a { color:var(--acc); text-decoration:none; margin-right:8px; font-size:12px; }
  .problems li { color:var(--warn); }
  .tr { color:var(--muted); font-size:13px; }
  #chat { border-left:1px solid var(--line); display:flex; flex-direction:column; min-height:0; }
  #chat .head { padding:8px 10px; border-bottom:1px solid var(--line); display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  #chat .head b { margin-right:auto; }
  #chat .msgs { flex:1; overflow:auto; padding:10px; display:flex; flex-direction:column; gap:6px; }
  #chat .in { border-top:1px solid var(--line); padding:8px; display:flex; gap:6px; }
  #chat textarea { flex:1; min-height:64px; max-height:200px; resize:vertical; background:#111318; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 8px; font:inherit; }
  .m-user { align-self:flex-end; background:#25324a; border-radius:10px 10px 2px 10px; padding:6px 10px; max-width:90%; white-space:pre-wrap; }
  .m-as { background:var(--panel); border-radius:10px 10px 10px 2px; padding:6px 10px; white-space:pre-wrap; max-width:96%; }
  .m-as.md { white-space:normal; font-size:13.5px; line-height:1.5; }
  .md p { margin:0 0 6px; } .md p:last-child { margin-bottom:0; }
  .md .md-h { font-weight:700; margin:8px 0 4px; }
  .md ul, .md ol { margin:2px 0 6px; padding-left:20px; } .md li { margin:1px 0; }
  .md code { background:#0f1115; border-radius:4px; padding:0 4px; font:12px Consolas, monospace; word-break:break-all; }
  .md pre { background:#0f1115; border-radius:6px; padding:6px 8px; overflow:auto; margin:4px 0 6px; }
  .md pre code { background:none; padding:0; word-break:normal; white-space:pre; }
  .md a { color:var(--acc); }
  .md .md-tbl { overflow-x:auto; margin:4px 0 8px; }
  .md table { border-collapse:collapse; width:auto; font-size:12.5px; }
  .md th, .md td { border:1px solid var(--line); padding:3px 6px; vertical-align:top; }
  .md th { background:#23262d; color:var(--text); font-weight:600; }
  .m-tool { font:12px/1.35 Consolas, monospace; color:var(--muted); padding:2px 6px; border-left:2px solid var(--line); cursor:pointer; white-space:pre-wrap; word-break:break-all; }
  .m-tool .r { display:none; color:#b9c0cc; margin-top:3px; max-height:220px; overflow:auto; }
  .m-tool.open .r { display:block; }
  .m-tool.err { border-left-color:var(--bad); }
  .m-perm { background:#3a2f17; border:1px solid var(--warn); border-radius:8px; padding:8px; font-size:13px; }
  .m-perm code { display:block; white-space:pre-wrap; word-break:break-all; margin:4px 0 6px; font-size:12px; }
  .m-st { color:var(--muted); font-size:12px; text-align:center; }
  .m-st.bad { color:var(--bad); }
  .frames { display:flex; gap:6px; overflow-x:auto; margin-top:6px; }
  .frames figure { margin:0; text-align:center; font-size:11px; color:var(--muted); }
  .frames img { height:150px; border-radius:4px; display:block; cursor:zoom-in; }
  .reps { max-height:320px; overflow:auto; }
  .reps td:first-child, .reps td:nth-child(2) { white-space:nowrap; color:var(--muted); font-size:12px; }
  table.plan td { font-size:12px; padding:3px 8px; }
  table.plan td:nth-child(3) { color:var(--acc); }
  .rec-dot { display:inline-block; width:11px; height:11px; border-radius:50%; background:var(--bad); animation:blink 1s infinite; }
  @keyframes blink { 50% { opacity:.25; } }
  .lv { display:inline-block; width:140px; height:8px; background:var(--line); border-radius:4px; overflow:hidden; }
  .lv > i { display:block; height:100%; width:0; background:var(--ok); transition:width .1s; }
  audio.voice { height:34px; max-width:100%; }
  .seg { display:inline-block; padding:1px 6px; margin:1px 2px; border-radius:6px; background:var(--line); font-size:12px; }
  #agentBar { display:none; position:sticky; top:-14px; z-index:5; margin:-14px -18px 12px; padding:10px 18px; background:#1a2233; border-bottom:1px solid #2f4268; }
  #agentBar.on { display:block; }
  #agentBar.fin { background:#17291f; border-bottom-color:#2d5a41; }
  #agentBar .now { color:#b9c0cc; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .spin { display:inline-block; width:12px; height:12px; border:2px solid var(--acc); border-right-color:transparent; border-radius:50%; animation:spin .8s linear infinite; vertical-align:-1px; margin-right:7px; }
  @keyframes spin { to { transform:rotate(360deg); } }
  @keyframes pulse { 50% { opacity:.55; } }
  .stages { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0 6px; }
  .stg { padding:2px 10px; border-radius:12px; font-size:12px; background:var(--line); color:var(--muted); }
  .stg.done { background:#1f3b2e; color:#8fd6b0; }
  .stg.cur { background:var(--acc); color:#fff; animation:pulse 1.4s ease-in-out infinite; }
  .stg .mini { display:inline-block; width:46px; height:5px; background:rgba(255,255,255,.25); border-radius:3px; margin-left:6px; vertical-align:1px; overflow:hidden; }
  .stg .mini i { display:block; height:100%; background:#fff; }
  .story .busy { display:block; color:#7fb0ff; font-size:12px; animation:pulse 1.4s ease-in-out infinite; }
  .dlg { position:fixed; inset:0; background:rgba(0,0,0,.8); display:none; align-items:center; justify-content:center; z-index:20; }
  .dlg.on { display:flex; }
  .dlg-box { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; max-width:96vw; max-height:96vh; display:flex; flex-direction:column; gap:10px; }
  #cropStage { position:relative; align-self:center; overflow:hidden; touch-action:none; user-select:none; line-height:0; background:#000; }
  #cropStage img { display:block; max-height:72vh; max-width:88vw; pointer-events:none; }
  #cropRect { position:absolute; border:2px solid #fff; box-shadow:0 0 0 9999px rgba(0,0,0,.6); cursor:move;
    background-image:linear-gradient(rgba(255,255,255,.25) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.25) 1px, transparent 1px);
    background-size:33.333% 33.333%; background-position:-1px -1px; }
  #cropRect i { position:absolute; width:16px; height:16px; background:var(--acc); border:2px solid #fff; border-radius:3px; }
  #cropRect i[data-h=nw] { left:-9px; top:-9px; cursor:nwse-resize; } #cropRect i[data-h=se] { right:-9px; bottom:-9px; cursor:nwse-resize; }
  #cropRect i[data-h=ne] { right:-9px; top:-9px; cursor:nesw-resize; } #cropRect i[data-h=sw] { left:-9px; bottom:-9px; cursor:nesw-resize; }
  .cropTag { font-size:12px; padding:1px 7px; border-radius:10px; background:#3a2f17; color:#f0c674; }
  .rebuild { background:#2a2414; border:1px solid var(--warn); border-radius:10px; padding:10px 14px; margin:10px 0; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .sform fieldset { border:1px solid var(--line); border-radius:10px; padding:8px 12px 10px; margin:0 0 10px; }
  .sform legend { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; padding:0 6px; }
  .sform .row { gap:10px; }
  .sform select { max-width:270px; }
  .sform input[type=color] { width:38px; height:30px; padding:2px; }
  .sprev { position:relative; width:270px; height:480px; flex:none; border-radius:10px; overflow:hidden; background:#3a4150 center/cover; }
  .sprev .safe { position:absolute; left:8.75px; top:55px; width:252.5px; height:312.5px; border:1px dashed rgba(120,255,140,.55); pointer-events:none; }
  .sprev .t { position:absolute; left:15px; right:15px; text-align:center; line-height:1.15; paint-order:stroke fill; white-space:nowrap; }
  label.upl { background:var(--line); border-radius:7px; padding:7px 14px; cursor:pointer; }
  label.upl input { display:none; }
  #sheet { position:fixed; inset:0; background:rgba(0,0,0,.85); display:none; align-items:center; justify-content:center; z-index:10; cursor:zoom-out; }
  #sheet img { max-width:95vw; max-height:95vh; }
</style>
</head>
<body>
<header>
  <h1>ReelsMaker</h1>
  <span class="muted" id="cfg"></span>
  <button class="sec" style="margin-left:auto" onclick="styleOpen()" title="Шрифты, размеры и цвета заголовка, субтитров и плашек">Оформление</button>
</header>
<main>
  <aside>
    <div class="row" style="justify-content:space-between;margin:0 4px 8px">
      <span class="muted">Сюжеты</span>
      <button class="sec" onclick="loadStories()" title="Перечитать папку входа">↻</button>
    </div>
    <div id="stories"></div>
  </aside>
  <section id="mid"><div id="agentBar"></div><div id="detail"><p class="muted">Выберите сюжет слева. Сюжет — папка в папке входа со сценками
    <code>NN_хук_слово.mp4</code>, <code>NN_слово.mp4</code>, <code>NNa/NNb</code> — дубли, <code>NN_финал.mp4</code>;
    тема (по желанию) — первая строка <code>тема.txt</code>.</p></div></section>
  <aside id="chat">
    <div class="head"><b>Монтажёр</b>
      <select id="chatModel" title="Модель"></select>
      <button class="sec" onclick="chatStop()" title="Остановить ход">■</button>
      <button class="sec" onclick="chatReset()" title="Новая беседа (забыть сессию)">новая</button>
    </div>
    <div class="m-st" id="chatState" style="padding:4px 10px">выберите сюжет</div>
    <div class="msgs" id="chatMsgs"></div>
    <div class="in"><textarea id="chatText" placeholder="Задание монтажёру… (Ctrl+Enter — отправить)"></textarea>
      <button onclick="chatSend()">➤</button></div>
  </aside>
</main>
<div id="sheet" onclick="this.style.display='none'"><img alt=""></div>
<div id="styleDlg" class="dlg"><div class="dlg-box" style="width:min(1000px,96vw)">
  <div class="row" style="justify-content:space-between"><b>Оформление — одно на все варианты и сюжеты</b><span class="muted" id="styleMsg"></span></div>
  <div style="display:flex;gap:18px;overflow:auto;align-items:flex-start">
    <div id="styleForm" class="sform" style="flex:1;min-width:420px"></div>
    <div><div id="stylePrev" class="sprev"></div><div class="muted" style="font-size:11px;margin-top:4px;width:270px">образец в масштабе кадра 1080×1920; пунктир — охранная зона Reels</div></div>
  </div>
  <div class="row">
    <label class="upl" title="Свой шрифт .ttf или .otf — сохранится в папке данных">Загрузить шрифт…<input type="file" accept=".ttf,.otf" onchange="fontUpload(this)"></label>
    <button onclick="styleSave()">Сохранить</button>
    <button class="sec" onclick="styleReset()">Встроенное оформление</button>
    <button class="sec" onclick="styleClose()">Закрыть</button>
  </div>
</div></div>
<div id="cropDlg" class="dlg"><div class="dlg-box">
  <div class="row" style="justify-content:space-between"><b id="cropTitle">Кроп</b><span class="muted" id="cropInfo"></span></div>
  <div class="row">
    <label>Кадр <input type="range" id="cropT" min="0" max="1" step="0.1" style="width:260px"></label><span class="muted" id="cropTv"></span>
    <label>Пропорции <select id="cropAsp">
      <option value="0.5625">9:16 — кадр ролика</option><option value="0">свободно</option>
      <option value="0.8">4:5</option><option value="1">1:1</option><option value="1.7778">16:9</option></select></label>
  </div>
  <div id="cropStage"><img id="cropImg" alt=""><div id="cropRect"><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i></div></div>
  <div class="muted" id="cropHint" style="font-size:12px">Тяните рамку или её углы. Всё вне рамки в ролик не попадёт.</div>
  <div class="row"><button onclick="cropSave()">Сохранить кроп</button><button class="sec" onclick="cropFull()">Весь кадр</button>
    <button class="sec" onclick="cropClose()">Отмена</button></div>
</div></div>
<script src="/md.js"></script>
<script>
let state = null, current = null, polling = null;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const enc = encodeURIComponent;
const sec = (n) => n == null ? "—" : n.toFixed(1) + " с";
const roleTag = { hook: '<span class="tag hook">хук</span>', final: '<span class="tag final">финал</span>', body: '<span class="tag">сцена</span>' };

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

async function init() {
  state = await api("/api/state");
  $("#cfg").textContent = "вход: " + state.inboxDir + " · вывод: " + state.outputDir + " · расшифровка: " + (state.stt ? "модель службы голосового ввода" : "не настроена");
  await loadStories();
  const want = decodeURIComponent(location.hash.slice(1));
  if (want) openStory(want);
}

async function loadStories() {
  const list = await api("/api/stories");
  $("#stories").innerHTML = list.length ? list.map((s) =>
    '<div class="story' + (s.id === current ? " sel" : "") + '" onclick="openStory(this.dataset.id)" data-id="' + esc(s.id) + '">' +
    "<b>" + esc(s.id) + "</b><small>сценок " + s.clips + ", расшифровок " + s.transcripts +
    (s.lastRun ? " · собрано " + s.lastRun.ready + "/" + s.lastRun.count : "") + "</small>" +
    (s.agentBusy ? '<span class="busy">● монтажёр работает</span>' : "") + "</div>").join("")
    : '<p class="muted">Папка входа пуста.<br>' + esc(state.inboxDir) + "</p>";
}

async function openStory(id, soft) {
  if (current !== id) { live.stamp = null; live.job = null; live.jobInfo = null; clearInterval(polling); }
  current = id;
  location.hash = enc(id);
  document.querySelectorAll(".story").forEach((e) => e.classList.toggle("sel", e.dataset.id === id));
  if (!soft) $("#detail").innerHTML = '<p class="muted">Читаю сюжет (ffprobe)…</p>';
  const mid = $("#mid"), top = mid.scrollTop, jobHtml = $("#job") ? $("#job").innerHTML : "";
  try {
    const d = await api("/api/stories/" + enc(id));
    if (current !== id) return;
    // мягкое обновление: блок роликов не пересоздаём (иначе обложки перезагружаются и мигают) — только правим изменившиеся карточки
    keepRunsEl = soft && $("#runs") && $("#runSel") ? $("#runs") : null;
    if (d.kind === "montage") renderMontage(d); else renderStory(d);
    keepRunsEl = null;
    if (soft) { mid.scrollTop = top; if (jobHtml && $("#job")) $("#job").innerHTML = jobHtml; }
    chatOpen(id);
    const active = d.jobs.find((j) => j.status === "running" || j.status === "queued");
    if (active && live.job !== active.id) watchJob(active.id);
  } catch (e) {
    $("#detail").innerHTML = '<p class="bad">' + esc(e.message) + "</p>";
  }
}

function renderStory(d) {
  const s = d.scan;
  const clips = s.clips.map((c) => {
    const p = c.parsed, pr = c.probe;
    const tr = c.transcript ? '<span class="tr">' + esc(c.transcript.text || "(тишина)") + "</span>" + (c.transcriptFresh ? "" : ' <span class="warn">устарела</span>')
      : (pr && !pr.hasAudio ? '<span class="muted">нет звука</span>' : '<span class="warn">нет</span>');
    return "<tr><td>" + esc(c.name) + "</td><td>" + (p ? String(p.scene).padStart(2, "0") + esc(p.take) : '<span class="bad">?</span>') +
      "</td><td>" + (p ? roleTag[p.role] : "") + "</td><td>" + (pr ? sec(pr.duration) : '<span class="bad">битый</span>') +
      "</td><td>" + tr + "</td></tr>";
  }).join("");
  const presets = state.presets.map((p) => '<label><input type="checkbox" name="preset" value="' + esc(p.id) + '" checked> ' + esc(p.title) + "</label>").join("");
  $("#detail").innerHTML =
    "<h2>" + esc(s.id) + "</h2>" +
    '<div class="muted">' + (s.theme ? "тема: " + esc(s.theme) + " · " : "") + esc(s.dir) +
    ' · <a href="#" onclick="openFolder(\\'inbox\\');return false" style="color:var(--acc)">открыть папку</a></div>' +
    (s.problems.length ? '<ul class="problems">' + s.problems.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "") +
    "<h3>Сценки</h3><table><tr><th>файл</th><th>сцена</th><th>роль</th><th>длит.</th><th>расшифровка</th></tr>" + clips + "</table>" +
    '<div class="panel"><div class="row">' +
      '<button id="btnTr" onclick="transcribe(false)"' + (state.stt ? "" : " disabled") + ">Расшифровать</button>" +
      '<button class="sec" onclick="transcribe(true)"' + (state.stt ? "" : " disabled") + ">Расшифровать заново</button>" +
      '<span class="muted">сборка сама дорасшифрует то, чего нет</span></div></div>' +
    '<div class="panel"><div class="row">' +
      '<label>Вариантов <input type="number" id="count" min="1" max="30" value="10"></label>' +
      '<label>Кодировщик <select id="hw"><option value="nvenc">видеокарта (NVENC)</option><option value="cpu">процессор (libx264)</option></select></label>' +
      '<label>Параллельно <input type="number" id="conc" min="1" max="8" value="' + state.concurrency + '"></label>' +
      '<button id="btnBuild" onclick="build()">Собрать</button></div>' +
      '<div class="presets" style="margin-top:8px"><span class="muted">' + (state.presets.length > 1 ? 'Пресеты: ' : 'Оформление (одно на все варианты): ') + '</span>' + presets + "</div></div>" +
    '<div id="job"></div>' +
    '<div id="runs"></div>';
  $("#hw").value = state.hw;
  renderRuns(d.runs);
}

// Ролики: список прогонов и карточки вариантов. Карточка перерисовывается только когда меняется состояние её
// варианта (в очереди → собирается → готово) — иначе обложки перезагружаются и экран мигает чёрным.
let shownRuns = [], keepRunsEl = null;
const runLabel = (r) => esc(r.id) + " — " + r.variants.filter((v) => v.status === "ready").length + "/" + r.count;

function renderRuns(runs) {
  if (keepRunsEl && runs.length) { $("#runs").replaceWith(keepRunsEl); syncRuns(runs); return; }
  shownRuns = runs;
  if (!runs.length) { $("#runs").innerHTML = '<h3>Ролики</h3><p class="muted">Ещё не собирали.</p>'; return; }
  const opts = runs.map((r, i) => '<option value="' + i + '">' + runLabel(r) + "</option>").join("");
  $("#runs").innerHTML = '<h3>Ролики</h3><div class="row"><select id="runSel">' + opts + '</select>' +
    '<button class="sec" onclick="openFolder(\\'out\\')">Открыть папку прогона</button></div><div id="runBody"></div>';
  $("#runSel").onchange = () => showRun(shownRuns[Number($("#runSel").value)]);
  showRun(runs[0]);
}

/** Обновить показанные ролики на месте: новые прогоны — полная перерисовка, иначе — только изменившиеся карточки. */
function syncRuns(runs) {
  const sel = $("#runSel");
  if (!sel || runs.length !== shownRuns.length || runs.some((r, i) => r.id !== shownRuns[i].id)) { keepRunsEl = null; renderRuns(runs); return; }
  shownRuns = runs;
  runs.forEach((r, i) => { const o = sel.options[i]; const t = runLabel(r).replace(/&amp;/g, "&"); if (o && o.textContent !== t) o.textContent = t; });
  const r = runs.find((x) => x.id === window.currentRun);
  if (!r) return;
  for (const v of r.variants) {
    const el = document.getElementById("card-" + v.dir);
    if (!el) { showRun(r); return; }
    if (el.dataset.st !== v.status) el.outerHTML = cardHtml(r, v);
  }
}

function cardHtml(r, v) {
  const base = "/out/" + enc(r.story) + "/" + enc(r.id) + "/";
  const vb = base + v.dir + "/";
  const media = v.status === "ready"
    ? '<div class="media" onclick="play(this, \\'' + vb + 'video.mp4\\', \\'' + vb + 'cover.jpg\\')"><img src="' + vb + 'cover.jpg" alt=""><span class="play">▶</span></div>'
    : '<div class="media"><span class="' + (v.status === "failed" ? "bad" : "muted") + '">' + ({ pending: "в очереди", rendering: "собирается…", failed: "ошибка" }[v.status] || v.status) + "</span></div>";
  return '<div class="card" id="card-' + esc(v.dir) + '" data-st="' + esc(v.status) + '">' + media +
    '<div class="body"><div class="hook"><span class="muted">' + esc(v.name ? v.name + " · " + v.dir : v.dir) + "</span> " + esc(v.hook) + "</div>" +
    '<div class="meta">' + esc(v.preset) + " · " + esc(v.order) + (v.duration ? " · " + sec(v.duration) : "") + "</div>" +
    (v.error ? '<div class="bad" style="font-size:12px">' + esc(v.error).slice(0, 300) + "</div>" : "") +
    '<div style="margin-top:5px">' + (v.status === "ready"
      ? '<a href="#" onclick="sheet(\\'' + vb + 'sheet.jpg\\');return false">контактный лист</a><a href="' + base + enc(v.file) + '" download>скачать</a>' : "") +
    '<a href="' + vb + 'ffmpeg.log" target="_blank">журнал</a></div></div></div>';
}

function showRun(r) {
  window.currentRun = r.id;
  const warn = r.warnings.length ? '<ul class="problems">' + r.warnings.map((w) => "<li>" + esc(w) + "</li>").join("") + "</ul>" : "";
  $("#runBody").innerHTML = warn + '<div class="grid" style="margin-top:10px">' + r.variants.map((v) => cardHtml(r, v)).join("") + "</div>";
}

function play(el, src, poster) {
  el.onclick = null;
  el.innerHTML = '<video src="' + src + '" poster="' + poster + '" controls autoplay playsinline></video>';
}
function sheet(src) { const s = $("#sheet"); s.querySelector("img").src = src; s.style.display = "flex"; }

async function openFolder(where) {
  try { await api("/api/open", { story: current, run: where === "out" ? window.currentRun : "", where }); } catch (e) { alert(e.message); }
}

async function transcribe(force) {
  try { const j = await api("/api/stories/" + enc(current) + "/transcribe", { force }); watchJob(j.id); } catch (e) { alert(e.message); }
}

async function build() {
  const presets = [...document.querySelectorAll('input[name=preset]:checked')].map((x) => x.value);
  if (!presets.length) { alert("Выберите хотя бы один пресет"); return; }
  try {
    const j = await api("/api/stories/" + enc(current) + "/build", { count: Number($("#count").value), hw: $("#hw").value, concurrency: Number($("#conc").value), presets });
    watchJob(j.id);
  } catch (e) { alert(e.message); }
}

function watchJob(id) {
  clearInterval(polling);
  live.job = id;
  const story = current;
  const tick = async () => {
    if (current !== story) { clearInterval(polling); return; }
    let j;
    try { j = await api("/api/jobs/" + id); } catch { return; }
    const busy = j.status === "queued" || j.status === "running";
    document.querySelectorAll("#btnBuild, #btnTr").forEach((b) => b.disabled = busy || (b.id === "btnTr" && !state.stt));
    live.jobInfo = { kind: j.kind, busy, progress: j.progress };
    renderAgentBar();
    const pct = j.progress && j.progress.total ? Math.round(100 * j.progress.done / j.progress.total) : (busy ? 5 : 100);
    const title = (j.kind === "build" ? "Сборка" : "Расшифровка") + ": " + ({ queued: "в очереди", running: "идёт", done: "готово", failed: "ошибка" }[j.status]) +
      (j.progress ? " (" + j.progress.done + "/" + j.progress.total + ")" : "");
    $("#job").innerHTML = '<div class="panel"><b class="' + (j.status === "failed" ? "bad" : j.status === "done" ? "ok" : "") + '">' + esc(title) + "</b>" +
      '<div class="bar"><i style="width:' + pct + '%"></i></div><pre class="log">' + esc(j.log.join("\\n")) + "</pre></div>";
    const log = $("#job pre"); if (log) log.scrollTop = log.scrollHeight;
    if (j.kind === "build" && j.runId && busy) refreshRuns(story);
    if (!busy) { clearInterval(polling); live.job = null; loadStories(); await openStory(story, true); }
  };
  tick();
  polling = setInterval(tick, 1500);
}

// ── живое обновление: страница сама подхватывает то, что сделал монтажёр (лист, кадры, сборку) ──
const live = { stamp: null, job: null, jobInfo: null };
async function liveTick() {
  const id = current;
  if (!id || document.hidden) return;
  let st;
  try { st = await api("/api/stories/" + enc(id) + "/stamp"); } catch { return; }
  if (current !== id) return;
  // сборку или расшифровку запустил монтажёр — показать её прогресс
  if (st.jobs.length && !st.jobs.includes(live.job)) { watchJob(st.jobs[0]); return; }
  if (live.stamp === null) { live.stamp = st.stamp; return; }
  if (st.stamp === live.stamp || live.job) return;
  const v = document.querySelector("#runBody video");
  if (v && !v.paused) return; // не перебивать просмотр ролика — обновимся после
  live.stamp = st.stamp;
  openStory(id, true);
}
setInterval(liveTick, 2000);
setInterval(() => { if (!document.hidden) loadStories().catch(() => {}); }, 4000);

let refreshing = false;
async function refreshRuns(story) {
  if (refreshing) return; refreshing = true;
  try {
    const runs = await api("/api/stories/" + enc(story) + "/runs");
    if (current === story) syncRuns(runs);

  } finally { refreshing = false; }
}

// ── сюжет из исходников: роли, кадры, реплики, монтажный лист ──
const ROLES = { talk: "основа (картинка и звук)", wide: "дальний план", screen: "скринкаст", voice: "озвучка (звук отдельным файлом, дублей может быть несколько)" };
const isAudioName = (n) => /\\.(wav|mp3|m4a|aac|ogg|oga|opus|flac|wma)$/i.test(n);

function renderMontage(d) {
  const m = d.montage;
  window.curMontage = m;
  const opt = (sel) => '<option value="">—</option>' + Object.entries(ROLES).map(([k, t]) => '<option value="' + k + '"' + (sel === k ? " selected" : "") + ">" + t + "</option>").join("");
  const src = m.sources.map((s, i) => {
    const p = s.probe;
    return "<tr><td>" + esc(s.name) + '</td><td><select class="roleSel" data-name="' + esc(s.name) + '">' + opt(s.role) + "</select></td><td>" +
      (p ? sec(p.duration) + (p.width ? " · " + p.width + "×" + p.height : " · аудио") + " · " + (p.hasAudio ? "звук" : "без звука") : '<span class="bad">не читается</span>') +
      (s.crop ? ' <span class="cropTag" title="кроп">кроп ' + Math.round(s.crop.w * 100) + "×" + Math.round(s.crop.h * 100) + "%</span>" : "") +
      '</td><td>' + (isAudioName(s.name) ? "" : '<a href="#" onclick="showGrid(' + i + ');return false" style="color:var(--acc)">кадры</a> · ' +
      '<a href="#" onclick="cropOpen(' + i + ');return false" style="color:var(--acc)">кроп</a>') + "</td></tr>" +
      '<tr><td colspan="4" style="border:0;padding:0 8px"><div class="frames" id="fr' + i + '"></div></td></tr>';
  }).join("");
  // звук — с озвучек, если они есть, иначе с основы (или никакого, если звук видео отключён)
  const hasVoice = m.voices.length > 0;
  const list = hasVoice ? m.voiceReplicas : m.replicas;
  const trDone = hasVoice ? m.voices.every((v) => v.transcribed) : m.transcribed;
  const trFresh = hasVoice ? m.voices.every((v) => v.fresh) : m.transcriptFresh;
  const silent = m.sound === "none";
  const what = hasVoice ? "озвучки" : "основу";
  let lastSrc = null;
  const reps = list.map((r) => {
    const head = hasVoice && m.voices.length > 1 && r.source !== lastSrc ? '<tr><td colspan="3" style="color:var(--acc);padding-top:10px">' + esc(r.source) + "</td></tr>" : "";
    lastSrc = r.source;
    return head + "<tr><td>" + r.id + "</td><td>" + r.start.toFixed(1) + "–" + r.end.toFixed(1) + " с</td><td>" + esc(r.text) + "</td></tr>";
  }).join("");
  const dis = state.stt && !silent ? "" : " disabled";
  $("#detail").innerHTML =
    "<h2>" + esc(current) + ' <span class="tag">из исходников</span></h2>' +
    '<div class="muted">' + esc(m.dir) + ' · <a href="#" onclick="openFolder(&quot;inbox&quot;);return false" style="color:var(--acc)">открыть папку</a></div>' +
    (m.problems.length ? '<ul class="problems">' + m.problems.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "") +
    "<h3>Исходники</h3><table>" + src + "</table>" +
    '<div style="margin-top:6px"><button class="sec" onclick="saveRoles()">Сохранить роли</button></div>' +
    "<h3>Озвучка</h3>" +
    '<div class="panel" id="micBox"></div>' +
    "<h3>Реплики " + (hasVoice ? "озвучек" : "основы") + " (" + list.length + ")</h3>" +
    (reps ? '<div class="reps"><table>' + reps + "</table></div>"
      : '<p class="muted">' + (silent ? "Звук видео не используется — расшифровывать нечего. Запишите озвучку микрофоном (кнопка выше) или положите аудиофайл в папку сюжета." : (hasVoice ? "Озвучки" : "Основа") + " ещё не расшифрован" + (hasVoice ? "ы" : "а") + ".") + "</p>") +
    '<div class="panel"><div class="row"><button id="btnTr" onclick="transcribe(false)"' + dis + ">Расшифровать " + what + "</button>" +
    '<button class="sec" onclick="transcribe(true)"' + dis + ">заново</button>" +
    '<span class="muted">' + (silent ? "расшифровывать нечего" : trDone ? (trFresh ? "расшифровка есть" : "расшифровка устарела") : "нет расшифровки") + "</span></div></div>" +
    "<h3>Монтажный лист</h3>" +
    '<div id="editBox">' + (m.editError ? '<p class="bad">' + esc(m.editError) + "</p>"
      : m.edit ? '<p class="muted">проверяю…</p>'
      : '<p class="muted">Листа ещё нет. Дайте задание монтажёру справа, например: «посмотри исходники и собери 5 разных вариантов».</p>') + "</div>" +
    (needRebuild[current] && d.runs.length && m.edit
      ? '<div class="rebuild"><span class="warn">Кроп или оформление изменены — готовые ролики собраны по-старому.</span>' +

        '<button onclick="buildEdit(true)">Пересобрать все варианты</button></div>' : "") +
    '<div class="panel"><div class="row">' +
    '<label>Вариантов в итоге <input type="number" id="vcount" min="1" max="30" value="' + (m.count || (m.edit && m.edit.variants ? m.edit.variants.length : 5)) + '"></label>' +
    '<button class="sec" onclick="saveCount(false)">Сохранить</button>' +
    '<button onclick="saveCount(true)" title="Сохранить число и попросить монтажёра дописать или сократить лист">Поручить монтажёру</button>' +
    '<span class="muted">' + (m.edit && m.edit.variants ? "в листе сейчас " + m.edit.variants.length : "листа ещё нет") +
    (m.count ? " · задано " + m.count : " · не задано (монтажёр делает 5)") + "</span></div>" +
    (m.screens && m.screens.length > 1 ? '<div class="muted" style="margin-top:6px">Скринкастов ' + m.screens.length + ": " + m.screens.map(esc).join(", ") +
      " — монтажёр выбирает нужный по подписи (имени файла)</div>" : "") + "</div>" +
    '<div class="panel"><div class="row">' +
    '<label>Кодировщик <select id="hw"><option value="nvenc">видеокарта (NVENC)</option><option value="cpu">процессор (libx264)</option></select></label>' +
    '<label>Параллельно <input type="number" id="conc" min="1" max="8" value="' + state.concurrency + '"></label>' +
    '<button id="btnBuild" onclick="buildEdit()"' + (m.edit ? "" : " disabled") + ">" + (d.runs.length ? "Пересобрать все варианты" : "Собрать по листу") + "</button>" +
    '<span class="muted" style="font-size:12px">какие собирать — галочки в таблице листа</span>' +
    '<button class="sec" onclick="checkEdit()"' + (m.edit ? "" : " disabled") + ">Проверить лист</button></div></div>" +
    '<div id="job"></div><div id="runs"></div>';
  $("#hw").value = state.hw;
  micRender();
  renderRuns(d.runs);
  if (m.edit && !m.editError) checkEdit();
}

async function checkEdit() {
  const box = $("#editBox");
  try {
    const c = await api("/api/stories/" + enc(current) + "/check", {});
    const notes = window.curMontage && window.curMontage.edit && window.curMontage.edit.notes;
    box.innerHTML = (notes ? '<p class="muted">' + esc(notes) + "</p>" : "") +
      '<table><tr><th><input type="checkbox" checked title="все" onchange="document.querySelectorAll(&quot;.vsel&quot;).forEach((b) => b.checked = this.checked);updBuildBtn()"></th>' +
      "<th>вариант</th><th>хук</th><th>реплики и план</th><th>оформление</th><th>длит.</th></tr>" +
      c.variants.map((v) => '<tr><td><input type="checkbox" class="vsel" value="' + esc(v.id) + '" checked onchange="updBuildBtn()"></td><td>' + esc(v.id) + "</td><td>" + esc(v.hook) + "</td><td>" +
        v.label.split(" → ").map((x) => '<span class="seg">' + esc(x) + "</span>").join("") +
        planHtml(v) +
        "</td><td>" + esc(v.preset) + "</td><td>" + sec(v.duration) + "</td></tr>").join("") + "</table>" +
      (c.errors.length ? '<ul class="problems">' + c.errors.map((x) => '<li class="bad">' + esc(x) + "</li>").join("") + "</ul>" : "") +
      (c.warnings.length ? '<ul class="problems">' + c.warnings.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "");
    const b = $("#btnBuild"); if (b) b.disabled = c.errors.length > 0;
    updBuildBtn();
  } catch (e) {
    box.innerHTML = '<p class="bad">' + esc(e.message) + "</p>";
  }
}

/** План варианта по сценам: время в ролике, реплика, что на экране, подпись монтажёра (или текст реплики). */
function planHtml(v) {
  if (!v.scenes || !v.scenes.length) return "";
  const rows = v.scenes.map((s) =>
    '<tr><td style="white-space:nowrap">' + s.from.toFixed(1) + "–" + s.to.toFixed(1) + " с</td><td><b>" + esc(s.id) + "</b></td><td>" + esc(s.visual) + "</td><td>" +
    esc(s.note || s.text) + "</td></tr>").join("");
  return '<details style="margin-top:6px"><summary class="muted" style="cursor:pointer">план по сценам (' + v.scenes.length + ')</summary>' +
    '<table class="plan" style="margin-top:4px">' + rows + "</table></details>";
}

async function saveRoles() {
  // основа и дальний — по одному файлу; скринкастов может быть несколько
  const body = { talk: "", wide: "", screen: [] };
  const voices = [];
  for (const s of document.querySelectorAll(".roleSel")) {
    if (!s.value) continue;
    if (s.value === "screen") { body.screen.push(s.dataset.name); continue; }
    if (s.value === "voice") { voices.push(s.dataset.name); continue; }
    if (body[s.value]) { alert("Роль «" + ROLES[s.value] + "» назначена двум файлам"); return; }
    body[s.value] = s.dataset.name;
  }
  // озвучки: все отмеченные; сняли со всех («—») — явный отказ; а если озвучек не было, ключ не шлём (иначе новые аудиофайлы не подберутся сами)
  if (voices.length) body.voice = voices;
  else if (window.curMontage.voices.length) body.voice = "";
  try { await api("/api/stories/" + enc(current) + "/roles", body); await openStory(current); } catch (e) { alert(e.message); }
}

// ── озвучка с микрофона: запись без потерь (PCM 24 бит) в этом окне → POST на сервер (wav 48 кГц в папку сюжета).
// Каждая запись — новый файл и новая озвучка сюжета; монтажёр видит все и берёт лучшие дубли. ──
const mic = { st: "idle", story: null, mode: "pcm", stream: null, ctx: null, node: null, an: null, buf: null, rec: null, chunks: [], rate: 48000, t0: 0, timer: null, ext: "wav", label: "" };
const MIC_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z"/></svg>';
// процессор записи: копит отсчёты по 4096 и отдаёт основному потоку (Float32Array); "flush" — отдать остаток
const MIC_WORKLET = 'class RmRec extends AudioWorkletProcessor {' +
  ' constructor() { super(); this.b = new Float32Array(4096); this.n = 0; this.port.onmessage = () => { this.out(); this.port.postMessage("done"); }; }' +
  ' out() { if (this.n) { this.port.postMessage(this.b.slice(0, this.n)); this.n = 0; } }' +
  ' process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) { for (let i = 0; i < c.length; i++) { this.b[this.n++] = c[i]; if (this.n === 4096) this.out(); } } return true; }' +
  '} registerProcessor("rm-rec", RmRec);';

/** Отсчёты (Float32, моно) → WAV PCM 24 бит. */
function micWav(chunks, rate) {
  let n = 0; for (const c of chunks) n += c.length;
  const buf = new ArrayBuffer(44 + n * 3), v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 3, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 3, true);
  v.setUint16(32, 3, true); v.setUint16(34, 24, true); str(36, "data"); v.setUint32(40, n * 3, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++) {
    const x = Math.round(Math.max(-1, Math.min(1, c[i])) * 8388607);
    v.setUint8(o++, x & 255); v.setUint8(o++, (x >> 8) & 255); v.setUint8(o++, (x >> 16) & 255);
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function voiceDel(i) {
  const m = window.curMontage, v = m && m.voices[i]; if (!v) return;
  // где озвучка уже стоит в листе: реплики с её буквой (b03…) и отрезки с voiceFile
  const used = [];
  if (m.edit && m.edit.variants) for (const vr of m.edit.variants) {
    const hit = (vr.segments || []).some((sg) => (typeof sg.voice === "string" && sg.voice.charAt(0) === v.letter) ||
      (sg.voiceFile && v.name.toLowerCase().indexOf(String(sg.voiceFile).toLowerCase()) === 0));
    if (hit) used.push(vr.id);
  }
  const msg = "Убрать озвучку «" + v.name + "» (" + v.letter + ")?\\n\\nФайл не стирается — он уйдёт в папку .rm/trash внутри сюжета, монтажёр его больше не увидит." +
    (used.length ? "\\n\\nВНИМАНИЕ: она используется в вариантах " + used.join(", ") + " — пока монтажёр не поправит лист, проверка покажет там ошибки." : "");
  if (!confirm(msg)) return;
  try { await api("/api/stories/" + enc(current) + "/voice/delete", { name: v.name }); await openStory(current, true); } catch (e) { alert(e.message); }
}

async function setClean(on) {
  try {
    await api("/api/stories/" + enc(current) + "/settings", { voiceClean: on });
    if (on && window.curMontage && window.curMontage.voices.length) {
      const box = $("#micBox"); if (box) box.innerHTML = '<span class="muted">Очищаю озвучки…</span>';
      const r = await api("/api/stories/" + enc(current) + "/voice/clean", {});
      if (r.failed.length) alert("Очистить не удалось: " + r.failed.map((f) => f.name + " — " + f.error).join("\\n"));
    }
    await openStory(current, true);
  } catch (e) { alert(e.message); await openStory(current, true); }
}

async function recleanVoices() {
  try {
    const box = $("#micBox"); if (box) box.innerHTML = '<span class="muted">Пересчитываю очистку…</span>';
    const r = await api("/api/stories/" + enc(current) + "/voice/clean", { force: true });
    if (r.failed.length) alert("Очистить не удалось: " + r.failed.map((f) => f.name + " — " + f.error).join("\\n"));
    await openStory(current, true);
  } catch (e) { alert(e.message); await openStory(current, true); }
}

async function setMute(on) {
  try { await api("/api/stories/" + enc(current) + "/settings", { muteVideo: on }); await openStory(current, true); } catch (e) { alert(e.message); }
}

async function micFillDevices(unlock) {
  const sel = $("#micDev"); if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  if (unlock) {
    // названия микрофонов браузер выдаёт только после разрешения: берём доступ на мгновение
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); }
    catch (e) { alert("Нет доступа к микрофону: " + e.message); }
  }
  const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  const list = all.filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
  const saved = localStorage.getItem("rm.mic") || "";
  sel.innerHTML = '<option value="">Микрофон по умолчанию</option>' +
    list.map((d, i) => '<option value="' + esc(d.deviceId) + '">' + esc(d.label || "Микрофон " + (i + 1)) + "</option>").join("");
  if (list.some((d) => d.deviceId === saved)) sel.value = saved;
  const hint = $("#micDevHint"); if (hint) hint.style.display = all.some((d) => d.label) ? "none" : "";
}

function micRender() {
  const box = $("#micBox"); if (!box) return;
  const m = window.curMontage || { voices: [], sources: [], sound: "talk", mute: false };
  if (mic.st === "rec" || mic.st === "send") {
    if (mic.story !== current) { box.innerHTML = '<span class="muted">Идёт запись в сюжете «' + esc(mic.story) + "» — вернитесь к нему, чтобы остановить.</span>"; return; }
    box.innerHTML = mic.st === "send" ? '<span class="muted">Сохраняю запись…</span>'
      : '<div class="row"><span class="rec-dot"></span><b id="micT">0:00</b><span class="lv"><i id="micLv"></i></span><b id="micHint" style="font-size:18px"></b>' +
        '<button onclick="micStop()">Остановить и сохранить</button><button class="sec" onclick="micCancel()">Отмена</button>' +
        '<span class="muted">' + (mic.mode === "pcm" ? "запись без потерь" : "запись со сжатием") + " · новая озвучка добавится к прежним</span></div>";
    micTick();
    return;
  }
  const player = (label, src) => '<div style="display:flex;gap:6px;align-items:center"><span class="muted" style="width:62px;font-size:12px">' + label + '</span><audio class="voice" controls preload="none" src="' + src + "?" + Date.now() + '"></audio></div>';
  const takes = m.voices.map((v, i) => {
    const base = v.name.slice(0, v.name.lastIndexOf(".")) + ".wav";
    const audio = isAudioName(v.name);
    const cleanTxt = v.clean === "ready" ? '<span class="ok">чистая ✓</span>' : v.clean === "stale" ? '<span class="warn">очистка не готова</span>' : '<span class="muted">очистка выкл.</span>';
    return '<tr><td><span class="tag">' + esc(v.letter) + "</span></td><td>" + esc(v.name) + "</td><td>" + (v.duration == null ? "—" : sec(v.duration)) + "</td><td>" +
      (v.transcribed ? (v.fresh ? '<span class="ok">расшифрована</span>' : '<span class="warn">расшифровка устарела</span>') : '<span class="muted">не расшифрована</span>') + "<br>" + cleanTxt + "</td><td>" +
      (audio ? player("оригинал", "/in/" + enc(current) + "/" + enc(v.name)) + (v.clean === "ready" ? player("чистая", "/in/" + enc(current) + "/.rm/clean/" + enc(base)) : "") : "") + "</td><td>" +
      (audio ? '<button class="sec" onclick="voiceDel(' + i + ')" title="Убрать эту запись: монтажёр её больше не увидит">Удалить</button>' : "") + "</td></tr>";
  }).join("");
  const sound = m.sound === "voice" ? "звук роликов — только озвучки (" + m.voices.length + "), монтажёр сам выберет лучший дубль каждой фразы"
    : m.sound === "none" ? "звук роликов: без звука, пока нет озвучки" : "звук роликов — с основы";
  box.innerHTML = '<div class="row"><button onclick="micStart()" title="Записать озвучку с микрофона">' + MIC_SVG + " Записать озвучку</button>" +
    '<label>Микрофон <select id="micDev" onchange="localStorage.setItem(&quot;rm.mic&quot;, this.value)" style="max-width:260px"><option value="">Микрофон по умолчанию</option></select></label>' +
    '<a href="#" id="micDevHint" onclick="micFillDevices(true);return false" style="color:var(--acc);font-size:12px">показать названия</a>' +
    '<label title="Обработка браузера убирает фоновый шум, но может «булькать» голос; для лучшего качества — выкл."><input type="checkbox" id="micNs"' + (localStorage.getItem("rm.micNs") === "1" ? " checked" : "") +
    ' onchange="localStorage.setItem(&quot;rm.micNs&quot;, this.checked ? &quot;1&quot; : &quot;0&quot;)"> шумоподавление</label></div>' +
    '<div class="row" style="margin-top:8px"><label><input type="checkbox" id="muteChk"' + (m.mute ? " checked" : "") + ' onchange="setMute(this.checked)"> Звук видео не использовать</label>' +
    '<span class="muted">' + sound + ". Каждая запись — новый файл, прежние не затираются.</span></div>" +
    '<div class="row" style="margin-top:8px"><label><input type="checkbox" id="cleanChk"' + (m.voiceClean ? " checked" : "") + ' onchange="setClean(this.checked)"> Очищать озвучку</label>' +
    '<span class="muted">убирает писк USB-микрофона (гребёнка помех), шумоподавление по тишине в начале записи, гейт; оригинал не меняется — в роликах звук из чистой копии</span>' +
    (m.voiceClean && m.voices.length ? ' <a href="#" onclick="recleanVoices();return false" style="color:var(--acc);font-size:12px">пересчитать</a>' : "") + "</div>" +
    (takes ? '<table style="margin-top:8px"><tr><th></th><th>озвучка</th><th>длит.</th><th>расшифровка</th><th></th><th></th></tr>' + takes + "</table>" : "");
  micFillDevices(false).catch(() => {});
}
if (navigator.mediaDevices) navigator.mediaDevices.ondevicechange = () => { if (mic.st === "idle") micFillDevices(false).catch(() => {}); };

function micTick() {
  const t = $("#micT"); if (!t || mic.st !== "rec") return;
  const sec = Math.floor((Date.now() - mic.t0) / 1000);
  t.textContent = Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  // первые 1,5 с — тишина: по ней очистка настраивается на шум именно этой записи
  const hint = $("#micHint");
  if (hint) {
    const quiet = Date.now() - mic.t0 < 1500;
    hint.textContent = quiet ? "● ЗАМЕР ШУМА — МОЛЧИТЕ…" : "● ГОВОРИТЕ";
    hint.style.color = quiet ? "var(--warn)" : "var(--ok)";
  }
  const lv = $("#micLv");
  if (lv && mic.an) {
    mic.an.getByteTimeDomainData(mic.buf);
    let sum = 0; for (const b of mic.buf) sum += ((b - 128) / 128) ** 2;
    lv.style.width = Math.min(100, Math.sqrt(sum / mic.buf.length) * 400) + "%";
  }
}

function micRelease() {
  clearInterval(mic.timer); mic.timer = null;
  if (mic.node) { try { mic.node.disconnect(); } catch {} }
  if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop());
  if (mic.ctx) mic.ctx.close().catch(() => {});
  mic.stream = null; mic.ctx = null; mic.node = null; mic.an = null;
  window.onbeforeunload = null;
}

async function micStart() {
  if (mic.st !== "idle") return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alert("Это окно не умеет записывать звук"); return; }
  const dev = $("#micDev") ? $("#micDev").value : "";
  const audio = { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: $("#micNs") ? $("#micNs").checked : false, autoGainControl: false };
  try {
    try {
      mic.stream = await navigator.mediaDevices.getUserMedia({ audio: dev ? { ...audio, deviceId: { exact: dev } } : audio });
    } catch (e) {
      if (!dev || e.name !== "OverconstrainedError") throw e;
      // выбранный микрофон отключили — пишем с микрофона по умолчанию
      localStorage.removeItem("rm.mic");
      mic.stream = await navigator.mediaDevices.getUserMedia({ audio });
    }
  } catch (e) {
    alert("Нет доступа к микрофону: " + e.message + ". Разрешите микрофон для этого окна (значок слева от адреса) и повторите.");
    return;
  }
  mic.chunks = []; mic.mode = "pcm"; mic.ext = "wav";
  // название микрофона: по нему сервер хранит образец шума этого микрофона (запасной для записей без тишины)
  mic.label = (mic.stream.getAudioTracks()[0] || {}).label || "";
  try {
    // без потерь: отсчёты прямо с входа, сжатия нет
    try { mic.ctx = new AudioContext({ sampleRate: 48000 }); } catch { mic.ctx = new AudioContext(); }
    mic.rate = mic.ctx.sampleRate;
    const src = mic.ctx.createMediaStreamSource(mic.stream);
    mic.an = mic.ctx.createAnalyser(); mic.an.fftSize = 1024; mic.buf = new Uint8Array(mic.an.fftSize);
    src.connect(mic.an);
    const url = URL.createObjectURL(new Blob([MIC_WORKLET], { type: "text/javascript" }));
    await mic.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    mic.node = new AudioWorkletNode(mic.ctx, "rm-rec", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
    mic.node.port.onmessage = (e) => { if (e.data !== "done") mic.chunks.push(e.data); };
    // выход глушим: узел должен быть подключён к выходу, иначе браузер его не вызывает
    const mute = mic.ctx.createGain(); mute.gain.value = 0;
    src.connect(mic.node); mic.node.connect(mute); mute.connect(mic.ctx.destination);
  } catch (e) {
    // нет AudioWorklet — запасной путь: сжатая запись браузера с максимальным битрейтом
    if (mic.ctx) mic.ctx.close().catch(() => {});
    mic.ctx = null; mic.node = null; mic.an = null; mic.mode = "mr";
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((x) => MediaRecorder.isTypeSupported(x)) || "";
    mic.rec = new MediaRecorder(mic.stream, mime ? { mimeType: mime, audioBitsPerSecond: 256000 } : { audioBitsPerSecond: 256000 });
    mic.ext = /ogg/.test(mic.rec.mimeType) ? "ogg" : /mp4/.test(mic.rec.mimeType) ? "mp4" : "webm";
    mic.rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) mic.chunks.push(ev.data); };
    mic.rec.start(1000);
  }
  mic.story = current; mic.st = "rec"; mic.t0 = Date.now();
  mic.timer = setInterval(micTick, 150);
  window.onbeforeunload = () => "Идёт запись озвучки";
  micRender();
}

function micCancel() {
  if (mic.st !== "rec") return;
  if (mic.rec) { mic.rec.onstop = null; mic.rec.ondataavailable = null; try { mic.rec.stop(); } catch {} mic.rec = null; }
  micRelease(); mic.chunks = []; mic.st = "idle"; micRender();
}

async function micStop() {
  if (mic.st !== "rec") return;
  const story = mic.story;
  let blob;
  if (mic.mode === "pcm") {
    // дослать остаток буфера процессора, потом собрать wav
    await new Promise((ok) => { const t = setTimeout(ok, 500); mic.node.port.onmessage = (e) => { if (e.data === "done") { clearTimeout(t); ok(); } else mic.chunks.push(e.data); }; mic.node.port.postMessage("flush"); });
    blob = micWav(mic.chunks, mic.rate);
  } else {
    const rec = mic.rec; mic.rec = null;
    const stopped = new Promise((ok) => { rec.onstop = ok; });
    rec.stop();
    await stopped;
    blob = new Blob(mic.chunks, { type: rec.mimeType || "audio/webm" });
  }
  micRelease();
  mic.chunks = []; mic.st = "send"; micRender();
  try {
    if (blob.size < 4096) throw new Error("запись пустая — проверьте микрофон");
    const r = await fetch("/api/stories/" + enc(story) + "/voice?ext=" + mic.ext + (mic.label ? "&mic=" + enc(mic.label) : ""), { method: "POST", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    mic.st = "idle";
    if (j.cleanMode === "track") alert("Очистка сработала в слабом режиме: в начале записи не нашлось тишины, а образца этого микрофона ещё нет.\\nВ следующий раз после нажатия «Записать» помолчите 1,5 секунды — по этой тишине очистка настраивается.");
    if (j.cleanError) alert("Запись сохранена, но очистить её не удалось — в роликах будет оригинал:\\n" + j.cleanError);
    if (current !== story) return;
    // новая озвучка нужна с текстом: расшифровка стартует сама; без неё просто обновить страницу
    if (state.stt) await transcribe(false); else await openStory(story, true);
  } catch (e) {
    mic.st = "idle"; micRender(); alert(e.message);
  }
}

async function showGrid(i) {
  const m = window.curMontage, s = m && m.sources[i]; if (!s) return;
  const box = $("#fr" + i); box.innerHTML = '<span class="muted">снимаю кадры…</span>';
  try {
    const r = await api("/api/stories/" + enc(current) + "/frames", { source: s.name, grid: 8, width: 240 });
    box.innerHTML = r.frames.map((f) => '<figure><img src="' + f.url + "?" + Date.now() + '" onclick="sheet(this.src)" alt=""><figcaption>' + f.t.toFixed(1) + " с</figcaption></figure>").join("");
  } catch (e) { box.innerHTML = '<span class="bad">' + esc(e.message) + "</span>"; }
}

/** Собрать по листу: отмеченные в таблице варианты (all — все, например после смены кропа). */
async function buildEdit(all) {
  needRebuild[current] = false;
  const nb = document.querySelector(".rebuild"); if (nb) nb.remove();
  const boxes = [...document.querySelectorAll(".vsel")];
  const picked = boxes.filter((b) => b.checked).map((b) => b.value);
  if (!all && boxes.length && !picked.length) { alert("Отметьте хотя бы один вариант"); return; }
  const variants = all || picked.length === boxes.length ? [] : picked;
  try {
    const j = await api("/api/stories/" + enc(current) + "/build-edit", { hw: $("#hw").value, concurrency: Number($("#conc").value), variants });
    watchJob(j.id);
  } catch (e) { alert(e.message); }
}

// ── кроп исходника: рамка в долях кадра, хранится в story.json, применяется ко всем вариантам при сборке ──
const needRebuild = {};
const crop = { src: null, r: { x: 0, y: 0, w: 1, h: 1 }, A: 1, R: 0, drag: null };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function cropOpen(i) {
  const s = window.curMontage && window.curMontage.sources[i]; if (!s || !s.probe) return;
  crop.src = s;
  crop.r = s.crop ? { ...s.crop } : { x: 0, y: 0, w: 1, h: 1 };
  $("#cropTitle").textContent = "Кроп: " + s.name + (s.role ? " — " + ROLES[s.role] : "");
  const dur = s.probe.duration;
  const t = $("#cropT"); t.max = String(Math.max(0, dur - 0.1)); t.value = String(Math.round(dur * 0.3 * 10) / 10);
  t.onchange = () => cropFrame(Number(t.value));
  t.oninput = () => { $("#cropTv").textContent = Number(t.value).toFixed(1) + " с"; };
  t.oninput();
  // пропорции: основа и дальний заполняют кадр 9:16, экран вписывается в рамку — свободно
  const asp = $("#cropAsp");
  asp.value = s.role === "screen" || s.crop ? "0" : "0.5625";
  asp.onchange = () => cropAspect(Number(asp.value));
  crop.R = Number(asp.value);
  $("#cropDlg").classList.add("on");
  cropFrame(Number(t.value));
}

async function cropFrame(t) {
  const img = $("#cropImg");
  try {
    const r = await api("/api/stories/" + enc(current) + "/frames", { source: crop.src.name, times: [t], width: 720, full: true });
    img.onload = () => { crop.A = img.naturalWidth / img.naturalHeight; cropDraw(); };
    img.src = r.frames[0].url + "?" + Date.now();
  } catch (e) { alert(e.message); }
}

function cropAspect(R) {
  crop.R = R;
  if (!R) { cropDraw(); return; }
  // самая большая рамка нужных пропорций вокруг текущего центра
  const c = crop.r, cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  let w = 1, h = crop.A / R;
  if (h > 1) { h = 1; w = R / crop.A; }
  crop.r = { w, h, x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h) };
  cropDraw();
}

function cropDraw() {
  const c = crop.r, el = $("#cropRect");
  el.style.left = c.x * 100 + "%"; el.style.top = c.y * 100 + "%"; el.style.width = c.w * 100 + "%"; el.style.height = c.h * 100 + "%";
  const p = crop.src.probe;
  const pw = Math.round(c.w * (p.width || 0)), ph = Math.round(c.h * (p.height || 0));
  const ratio = (c.w * crop.A) / c.h;
  $("#cropInfo").textContent = (pw && ph ? pw + "×" + ph + " px · " : "") + Math.round(c.w * 100) + "×" + Math.round(c.h * 100) + "% кадра";
  $("#cropHint").textContent = crop.src.role !== "screen" && Math.abs(ratio - 0.5625) > 0.02
    ? "Рамка не 9:16 — в ролике кадр дообрежется до 9:16 по центру рамки."
    : "Тяните рамку или её углы. Всё вне рамки в ролик не попадёт.";
}

$("#cropStage").addEventListener("pointerdown", (e) => {
  const st = $("#cropStage").getBoundingClientRect();
  const h = e.target.dataset && e.target.dataset.h;
  if (!h && e.target.id !== "cropRect") return;
  e.preventDefault();
  $("#cropStage").setPointerCapture(e.pointerId);
  crop.drag = { h, st, x0: (e.clientX - st.left) / st.width, y0: (e.clientY - st.top) / st.height, r0: { ...crop.r } };
});
$("#cropStage").addEventListener("pointermove", (e) => {
  const d = crop.drag; if (!d) return;
  const px = clamp((e.clientX - d.st.left) / d.st.width, 0, 1), py = clamp((e.clientY - d.st.top) / d.st.height, 0, 1);
  const r0 = d.r0;
  if (!d.h) {
    crop.r = { ...r0, x: clamp(r0.x + px - d.x0, 0, 1 - r0.w), y: clamp(r0.y + py - d.y0, 0, 1 - r0.h) };
  } else {
    // угол тянется, противоположный стоит на месте
    const sx = d.h.includes("e") ? 1 : -1, sy = d.h.includes("s") ? 1 : -1;
    const fx = sx > 0 ? r0.x : r0.x + r0.w, fy = sy > 0 ? r0.y : r0.y + r0.h;
    const maxW = sx > 0 ? 1 - fx : fx, maxH = sy > 0 ? 1 - fy : fy;
    let w = Math.max(0.05, sx * (px - fx)), h = Math.max(0.05, sy * (py - fy));
    if (crop.R) {
      w = Math.max(w, (h * crop.R) / crop.A);
      w = Math.min(w, maxW, (maxH * crop.R) / crop.A);
      h = (w * crop.A) / crop.R;
    } else { w = Math.min(w, maxW); h = Math.min(h, maxH); }
    crop.r = { w, h, x: sx > 0 ? fx : fx - w, y: sy > 0 ? fy : fy - h };
  }
  cropDraw();
});
$("#cropStage").addEventListener("pointerup", () => { crop.drag = null; });

function cropClose() { $("#cropDlg").classList.remove("on"); crop.drag = null; }
async function cropPost(c) {
  try {
    await api("/api/stories/" + enc(current) + "/crop", { source: crop.src.name, crop: c });
    needRebuild[current] = true;
    cropClose();
    await openStory(current, true);
  } catch (e) { alert(e.message); }
}
function cropSave() { const c = crop.r; cropPost({ x: c.x, y: c.y, w: c.w, h: c.h }); }
function cropFull() { cropPost(null); }

/** Подпись кнопки сборки по отметкам: все — «Пересобрать все», часть — «Собрать отмеченные (N)». */
function updBuildBtn() {
  const b = $("#btnBuild"); if (!b) return;
  const boxes = [...document.querySelectorAll(".vsel")];
  if (!boxes.length) return;
  const n = boxes.filter((x) => x.checked).length;
  b.textContent = n === boxes.length ? (shownRuns.length ? "Пересобрать все варианты" : "Собрать по листу") : "Собрать отмеченные (" + n + ")";
}

/** Сколько вариантов нужно в итоге — в story.json; ask — ещё и поручить монтажёру дописать/сократить лист. */
async function saveCount(ask) {
  const n = Number($("#vcount").value);
  if (!Number.isInteger(n) || n < 1 || n > 30) { alert("Число вариантов — от 1 до 30"); return; }
  try {
    await api("/api/stories/" + enc(current) + "/settings", { count: n });
    if (ask) {
      const have = window.curMontage && window.curMontage.edit && window.curMontage.edit.variants ? window.curMontage.edit.variants.length : 0;
      const text = have
        ? "Нужно " + n + " вариантов в итоге (в листе сейчас " + have + "). " + (n > have ? "Допиши " + (n - have) + " новых, разных с остальными по хуку и первым секундам" : n < have ? "Оставь " + n + " лучших, слабые убери" : "Проверь, что все " + n + " действительно разные") + ". Потом check и собери изменённые или новые варианты."
        : "Посмотри исходники и собери " + n + " разных вариантов.";
      await api("/api/stories/" + enc(current) + "/agent/send", { text, model: $("#chatModel").value });
      chatPoll();
    }
    await openStory(current, true);
  } catch (e) { alert(e.message); }
}

// ── оформление: шрифт, размер и цвета заголовка, субтитров и плашек (одно на все варианты) ──
const STYLE_LAYERS = [["hook", "Заголовок-хук", "Я был мясным прокси"], ["block", "Плашки", "Шаг 1: тесты"], ["caption", "Субтитры", "субтитры вот так"]];
let styleData = null;

async function styleOpen() {
  $("#styleMsg").textContent = "";
  try { styleData = await api("/api/style"); } catch (e) { alert(e.message); return; }
  if (!styleData.enabled) $("#styleMsg").textContent = "папка данных не задана — сохранить нельзя";
  styleFonts();
  styleForm(styleData.layers);
  $("#styleDlg").classList.add("on");
}
function styleClose() { $("#styleDlg").classList.remove("on"); }

/** Шрифты для образца — через @font-face с сервера. */
function styleFonts() {
  let el = document.getElementById("styleFontFaces");
  if (!el) { el = document.createElement("style"); el.id = "styleFontFaces"; document.head.appendChild(el); }
  el.textContent = styleData.fonts.map((f, i) => '@font-face{font-family:"rmf' + i + '";src:url("' + f.url + '")}').join("");
}
const fontAlias = (file) => { const i = styleData.fonts.findIndex((f) => f.file === file); return i >= 0 ? "rmf" + i + ", sans-serif" : "sans-serif"; };

function styleForm(layers) {
  $("#styleForm").innerHTML = STYLE_LAYERS.map(([k, title]) => {
    const l = layers[k];
    const opts = styleData.fonts.map((f) => '<option value="' + esc(f.file) + '"' + (f.file === l.fontFile ? " selected" : "") + ">" +
      esc(f.family) + " — " + esc(f.file) + (f.source === "user" ? " (свой)" : "") + "</option>").join("");
    return '<fieldset data-l="' + k + '"><legend>' + title + "</legend>" +
      '<div class="row"><label>Шрифт <select data-k="fontFile">' + opts + "</select></label>" +
      '<label>Размер <input type="number" data-k="size" min="20" max="200" value="' + l.size + '"></label></div>' +
      '<div class="row" style="margin-top:6px"><label>Цвет <input type="color" data-k="color" value="' + l.color + '"></label>' +
      '<label>Обводка <input type="color" data-k="outlineColor" value="' + l.outlineColor + '"></label>' +
      '<label>толщина <input type="number" data-k="outline" min="0" max="20" value="' + l.outline + '"></label></div></fieldset>';
  }).join("");
  $("#styleForm").oninput = stylePreview;
  $("#styleForm").onchange = stylePreview;
  stylePreview();
}

function styleValues() {
  const out = {};
  for (const fs of document.querySelectorAll("#styleForm fieldset")) {
    const o = {};
    for (const el of fs.querySelectorAll("[data-k]")) o[el.dataset.k] = el.type === "number" ? Number(el.value) : el.value;
    out[fs.dataset.l] = o;
  }
  return out;
}

function stylePreview() {
  const v = styleValues(), k = 0.25; // 1080 → 270
  const bg = document.querySelector("#runBody .card img");
  const box = $("#stylePrev");
  box.style.backgroundImage = bg ? 'url("' + bg.src + '")' : "linear-gradient(160deg,#5b6577,#2b303a)";
  box.innerHTML = '<div class="safe"></div>' + STYLE_LAYERS.map(([key, , sample]) => {
    const s = v[key], lay = styleData.layers[key];
    const pos = lay.alignment >= 7 ? "top:" + lay.marginV * k + "px" : "bottom:" + lay.marginV * k + "px";
    return '<div class="t" style="' + pos + ";font-family:" + fontAlias(s.fontFile) + ";font-size:" + s.size * k + "px;color:" + s.color +
      ";-webkit-text-stroke:" + (2 * s.outline * k) + "px " + s.outlineColor + '">' + esc(sample) + "</div>";
  }).join("");
}

async function styleSave() {
  try {
    styleData = await api("/api/style", styleValues());
    if (current) needRebuild[current] = true;
    $("#styleMsg").textContent = "сохранено — новые сборки с этим оформлением; готовые ролики пересоберите";
    if (current) openStory(current, true);
  } catch (e) { alert(e.message); }
}
async function styleReset() {
  if (!confirm("Вернуть встроенное оформление (свои шрифты останутся в списке)?")) return;
  try { styleData = await api("/api/style", { reset: true }); styleFonts(); styleForm(styleData.layers); $("#styleMsg").textContent = "встроенное оформление"; }
  catch (e) { alert(e.message); }
}
async function fontUpload(input) {
  const file = input.files && input.files[0]; input.value = "";
  if (!file) return;
  const keep = styleValues();
  try {
    const r = await fetch("/api/fonts?name=" + enc(file.name), { method: "POST", body: file });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    styleData = await api("/api/style");
    styleFonts();
    styleForm({ hook: { ...styleData.layers.hook, ...keep.hook }, caption: { ...styleData.layers.caption, ...keep.caption }, block: { ...styleData.layers.block, ...keep.block } });
    $("#styleMsg").textContent = "шрифт «" + j.family + "» загружен — выберите его в списке";
  } catch (e) { alert(e.message); }
}

// ── окно агента-монтажёра (Claude Code сюжета) ──


const chat = { story: null, rev: 0, timer: null, busy: false, since: null, items: new Map(), finished: null };
const STAGES = ["изучает исходники", "пишет лист", "проверяет", "собирает", "смотрит результат"];

/** Этап по вызову инструмента: команды rm, запись edit.json, просмотр листов сборки. */
function stageOf(it) {
  if (it.t !== "tool" || it.name === "TodoWrite") return -1;
  const l = " " + (it.line || "") + " ";
  if (it.name === "Read" && /sheet\\.jpg|cover\\.jpg|[\\\\/]out[\\\\/]/.test(l)) return 4;
  if (/\\sbuild[\\s"']/.test(l)) return 3;
  if (/\\scheck[\\s"']/.test(l)) return 2;
  if (/^(Write|Edit|MultiEdit)$/.test(it.name) && /edit\\.json/.test(l)) return 1;
  return 0;
}

function clock(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
}

/** Полоса над сюжетом: идёт ли ход, сколько длится, какие этапы пройдены, что сейчас. */
function renderAgentBar() {
  const bar = $("#agentBar");
  if (!bar) return;
  if (!chat.story || chat.story !== current || (!chat.busy && !chat.finished)) { bar.className = ""; return; }
  // ход — всё после последнего сообщения владельца
  const all = [...chat.items.values()];
  let from = 0;
  all.forEach((it, i) => { if (it.t === "user") from = i + 1; });
  const turn = all.slice(from);
  let reached = -1, cur = -1, now;
  for (const it of turn) {
    const st = stageOf(it);
    if (st >= 0) { reached = Math.max(reached, st); cur = st; }
  }
  const last = turn[turn.length - 1];
  const running = [...turn].reverse().find((it) => it.t === "tool" && it.status === "run");
  const waiting = turn.find((it) => it.t === "perm" && it.status === "wait");
  if (waiting) now = "ждёт вашего разрешения справа: " + (waiting.line || waiting.name);
  else if (running) now = running.desc || running.line || running.name;
  else if (last && last.t === "assistant" && last.text) now = last.text.split("\\n").find((x) => x.trim()) || "";
  else now = "думает…";
  const job = live.jobInfo;
  const chips = STAGES.map((title, i) => {
    const cls = !chat.busy ? (i <= reached ? "done" : "") : i === cur ? "cur" : i <= reached ? "done" : "";
    let extra = "";
    if (i === 3 && job && job.kind === "build" && job.progress && job.progress.total)
      extra = " " + job.progress.done + "/" + job.progress.total + '<span class="mini"><i style="width:' + Math.round(100 * job.progress.done / job.progress.total) + '%"></i></span>';
    return '<span class="stg ' + cls + '">' + (cls === "done" ? "✓ " : "") + title + extra + "</span>";
  }).join("");
  if (chat.busy) {
    bar.className = "on";
    bar.innerHTML = '<div class="row" style="justify-content:space-between"><b><span class="spin"></span>Монтажёр работает' +
      (chat.since ? " · " + clock(Date.now() - chat.since) : "") + '</b><button class="sec" onclick="chatStop()" title="Остановить ход">■ стоп</button></div>' +
      '<div class="stages">' + chips + '</div><div class="now">сейчас: ' + esc(now) + "</div>";
  } else {
    bar.className = "on fin";
    bar.innerHTML = '<div class="row" style="justify-content:space-between"><b class="ok">✓ Монтажёр закончил' +
      (chat.finished.ms ? " за " + clock(chat.finished.ms) : "") + ' — ответ справа</b><button class="sec" onclick="chat.finished=null;renderAgentBar()">скрыть</button></div>' +
      '<div class="stages">' + chips + "</div>";
  }
}
setInterval(() => { if (chat.busy) renderAgentBar(); }, 1000);

function chatOpen(id) {
  if (chat.story === id) return;
  chat.story = id; chat.rev = 0; chat.busy = false; chat.since = null; chat.items = new Map(); chat.finished = null;
  renderAgentBar();
  $("#chatMsgs").innerHTML = "";
  const sel = $("#chatModel");
  if (!sel.options.length) sel.innerHTML = (state.models || []).map((m) => "<option>" + esc(m) + "</option>").join("");
  $("#chatText").onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); chatSend(); } };
  clearInterval(chat.timer);
  chatPoll();
  chat.timer = setInterval(chatPoll, 1200);
}

function chatItem(it) {
  const id = ' id="ci-' + esc(it.id) + '"';
  if (it.t === "user") return '<div class="m-user"' + id + ">" + esc(it.text) + "</div>";
  if (it.t === "assistant") return it.text ? '<div class="m-as md"' + id + ">" + (window.md ? md(it.text) : esc(it.text)) + "</div>" : '<div class="m-st"' + id + ">…</div>";
  if (it.t === "tool") {
    const icon = { run: "…", ok: "✓", err: "✗" }[it.status] || "·";
    return '<div class="m-tool' + (it.status === "err" ? " err" : "") + '"' + id + ' onclick="this.classList.toggle(&quot;open&quot;)">' +
      icon + " " + esc(it.name) + ": " + esc(it.desc || it.line) +
      '<div class="r">' + esc(it.line) + (it.result ? "<br>→ " + esc(it.result) : "") + "</div></div>";
  }
  if (it.t === "perm") {
    const q = "&quot;" + esc(it.reqId) + "&quot;";
    return '<div class="m-perm"' + id + "><b>Разрешить?</b> " + esc(it.name) + "<code>" + esc(it.line) + "</code>" +
      (it.status === "wait"
        ? '<button onclick="chatPerm(' + q + ',true)">Разрешить</button> <button class="sec" onclick="chatPerm(' + q + ',false)">Запретить</button>'
        : '<span class="muted">' + (it.status === "allowed" ? "разрешено" : "запрещено") + "</span>") + "</div>";
  }
  if (it.t === "result") return '<div class="m-st' + (it.ok ? "" : " bad") + '"' + id + ">" + (it.ok ? "ход закончен · " : "ход прерван: ") + esc(it.text) + "</div>";
  return '<div class="m-st' + (it.bad ? " bad" : "") + '"' + id + ">" + esc(it.text) + "</div>";
}

async function chatPoll() {
  const id = chat.story; if (!id) return;
  let v;
  try { v = await api("/api/stories/" + enc(id) + "/agent?since=" + chat.rev); } catch { return; }
  if (chat.story !== id) return;
  $("#chatState").textContent = v.alive
    ? (v.busy ? "работает…" : "ждёт задания") + " · " + v.model + (v.viaProxy ? " · через туннель" : "")
    : v.sessionId ? "остановлен — следующее сообщение продолжит сессию" : "не запущен — напишите задание";
  if (v.model) $("#chatModel").value = v.model;
  const wasBusy = chat.busy; chat.busy = v.busy;
  if (v.busy) { chat.since = v.busySince || chat.since; chat.finished = null; }
  else if (wasBusy) chat.finished = { ms: chat.since ? Date.now() - chat.since : 0 };
  for (const it of v.items) chat.items.set(it.id, it);
  if (v.items.length) {
    const box = $("#chatMsgs");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    for (const it of v.items) {
      chat.rev = Math.max(chat.rev, it.rev);
      const html = chatItem(it);
      const el = document.getElementById("ci-" + it.id);
      if (el) { const open = el.classList.contains("open"); el.outerHTML = html; if (open) document.getElementById("ci-" + it.id).classList.add("open"); }
      else box.insertAdjacentHTML("beforeend", html);
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  // ход закончился — лист и сборки могли измениться: обновить сюжет (если не идёт задача)
  if (wasBusy && !v.busy && current === id) openStory(id, true);
  renderAgentBar();
}

async function chatSend() {
  const t = $("#chatText"); const text = t.value.trim(); if (!text || !chat.story) return;
  t.value = "";
  try { await api("/api/stories/" + enc(chat.story) + "/agent/send", { text, model: $("#chatModel").value }); chatPoll(); }
  catch (e) { t.value = text; alert(e.message); }
}
async function chatPerm(reqId, allow) {
  try { await api("/api/stories/" + enc(chat.story) + "/agent/perm", { reqId, allow }); chatPoll(); } catch (e) { alert(e.message); }
}
async function chatStop() { if (chat.story) await api("/api/stories/" + enc(chat.story) + "/agent/stop", {}).catch(() => {}); }
async function chatReset() {
  if (!chat.story || !confirm("Начать новую беседу? Прежняя сессия монтажёра будет забыта.")) return;
  await api("/api/stories/" + enc(chat.story) + "/agent/reset", {}).catch((e) => alert(e.message));
  const s = chat.story; chat.story = null; chatOpen(s);
}

init().catch((e) => { document.body.innerHTML = '<p class="bad" style="padding:20px">' + esc(e.message) + "</p>"; });
</script>
</body>
</html>
`;
