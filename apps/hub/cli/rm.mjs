#!/usr/bin/env node
// rm — команда агента-монтажёра (и владельца) к API ReelsMaker. Без зависимостей, обычный Node.
//   node apps/hub/cli/rm.mjs [--story <сюжет>] <команда> …
// Сюжет: --story, иначе RM_STORY (его ставит окно агента), иначе папка, из которой запущено (внутри папки входа).
// Адрес: RM_HUB или http://127.0.0.1:8787.

const HUB = (process.env.RM_HUB || "http://127.0.0.1:8787").replace(/\/+$/, "");
const argv = process.argv.slice(2);

function take(flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v ?? null;
}
const has = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};

async function api(path, body) {
  let res;
  try {
    res = await fetch(HUB + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    fail(`ReelsMaker не отвечает на ${HUB} — запущен ли интерфейс (ReelsMaker.bat)? ${e.message}`);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) fail(j.error || `${res.status} ${res.statusText}`);
  return j;
}

function fail(msg) {
  console.error("ошибка: " + msg);
  process.exit(1);
}

const STORY_FLAG = take("--story");

async function storyId() {
  const s = STORY_FLAG || process.env.RM_STORY;
  if (s) return s;
  const st = await api("/api/state");
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const inbox = norm(st.inboxDir);
  const cwd = process.cwd().replace(/\\/g, "/");
  if (norm(cwd).startsWith(inbox + "/")) return cwd.slice(inbox.length + 1).split("/")[0];
  fail("не знаю сюжет: укажите --story <имя папки сюжета> или запустите из папки сюжета");
}

const sec = (n) => (n == null ? "—" : Number(n).toFixed(2));
const enc = encodeURIComponent;

async function waitJob(id) {
  let shown = 0;
  for (;;) {
    const j = await api(`/api/jobs/${id}`);
    for (const line of j.log.slice(shown)) console.log("  " + line);
    shown = j.log.length;
    if (j.status === "done" || j.status === "failed") return j;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const HELP = `rm — API ReelsMaker
  brief                          исходники, роли, реплики, лист, проблемы
  replicas [с_сек] [по_сек]       реплики (все или в окне времени)
  words <с_сек> <по_сек> [файл]   слова источника звука со временем — резать внутри реплики (озвучек несколько — укажите файл)
  frames <роль|файл> <сек>…       кадры jpg → пути (смотрите Read)
  grid <роль|файл> [N=6]          N кадров равномерно по файлу
  roles talk=<файл> wide=<файл> screen=<файл> [screen=<файл>…] [voice=<файл>…|voice=]
  mute on|off                     звук видео не нужен (владелец запишет озвучку): без озвучки ролик без звука
  transcribe [--force]            расшифровать источники звука (все озвучки, без них основу)
  check                           проверить edit.json
  build [id,id…] [--cpu] [--par N] собрать варианты по edit.json и дождаться
  runs                            прошлые сборки
  --story <сюжет>                 явно указать сюжет`;

async function main() {
  const cmd = argv.shift();
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(HELP);
    return;
  }
  const id = await storyId();
  const base = `/api/stories/${enc(id)}`;

  if (cmd === "brief" || cmd === "replicas") {
    const m = await api(`${base}/montage`);
    if (cmd === "brief") {
      console.log(`Сюжет «${id}» · ${m.dir}`);
      console.log("Исходники:");
      for (const s of m.sources) {
        const p = s.probe;
        console.log(`  ${(s.role ?? "—").padEnd(6)} ${s.name}  ${p ? `${sec(p.duration)} с, ${p.width}×${p.height}, звук: ${p.hasAudio ? "есть" : "нет"}` : "не читается"}`);
      }
      if (m.screens.length > 1) console.log(`Скринкастов ${m.screens.length}: ${m.screens.join(", ")} — в сегменте со screen указывайте "screenFile"`);
      console.log(`Нужно вариантов: ${m.count ? `${m.count} (задал владелец)` : "не задано — по умолчанию 5"}`);
      if (m.problems.length) console.log("Проблемы:\n" + m.problems.map((x) => "  - " + x).join("\n"));
      if (m.voices.length) {
        console.log(`Озвучки (${m.voices.length}) — ЗВУК И СУБТИТРЫ ИДУТ С НИХ, видео (основа, дальний, скринкаст) даёт только картинку:`);
        for (const v of m.voices) console.log(`  ${v.letter}  ${v.name}  ${sec(v.duration)} с, реплик ${v.replicas}, расшифровка: ${v.transcribed ? (v.fresh ? "есть" : "устарела") : "нет"}, очистка: ${v.clean === "ready" ? "звук роликов из чистой копии" : v.clean === "stale" ? "будет сделана при сборке" : "выключена"}`);
        console.log(`Реплики озвучек имеют id по букве файла (a01, b01…). В сегменте пишите "voice": "b03" (не "replica"); крупный план — "at": <сек основы>.`);
        if (m.voices.length > 1) console.log("Это ДУБЛИ/ЧАСТИ озвучки: прочитай текст всех файлов, для каждой фразы выбери лучший дубль (без оговорок, чище, живее); разные варианты ролика могут брать разные дубли.");
      } else if (m.sound === "none") {
        console.log(`Звук роликов: БЕЗ ЗВУКА (${m.mute ? "владелец отключил звук видео" : "у основы нет звука"}) — собирай по start/end (секунды видео), субтитров не будет; озвучку владелец запишет потом.`);
      } else console.log(`Расшифровка основы: ${m.transcribed ? (m.transcriptFresh ? "есть" : "устарела") : "нет"}; звук роликов — с основы`);
    }
    const from = cmd === "replicas" && argv[0] ? Number(argv[0]) : -Infinity;
    const to = cmd === "replicas" && argv[1] ? Number(argv[1]) : Infinity;
    const reps = m.voices.length ? m.voiceReplicas : m.replicas;
    console.log(`Реплики ${m.voices.length ? "озвучек" : "основы"} (${reps.length}):`);
    let lastSource = null;
    for (const r of reps) {
      if (!(r.end >= from && r.start <= to)) continue;
      if (r.source && r.source !== lastSource && m.voices.length > 1) console.log(`  — ${r.source}:`);
      lastSource = r.source ?? null;
      console.log(`  ${r.id}  ${sec(r.start)}–${sec(r.end)}  (${(r.end - r.start).toFixed(1)} с)  ${r.text}`);
    }
    if (cmd === "brief") {
      if (m.editError) console.log(m.editError);
      else if (!m.edit) console.log("Монтажного листа edit.json ещё нет.");
      else {
        console.log(`Лист edit.json: ${m.edit.variants?.length ?? 0} вариантов${m.edit.notes ? ` — ${m.edit.notes}` : ""}`);
        const c = await api(`${base}/check`, {});
        for (const v of c.variants) console.log(`  ${v.id}: «${v.hook}» · ${v.preset} · ${v.label} · ${sec(v.duration)} с`);
        for (const e of c.errors) console.log("  ОШИБКА: " + e);
        for (const w of c.warnings) console.log("  внимание: " + w);
      }
    }
    return;
  }
  if (cmd === "words") {
    const [from, to] = argv.slice(0, 2).map(Number);
    if (!Number.isFinite(from) || !Number.isFinite(to)) fail("words: укажите окно секундами: words <с> <по> [файл озвучки]");
    const r = await api(`${base}/words?from=${from}&to=${to}${argv[2] ? `&file=${enc(argv[2])}` : ""}`);
    // строки по ~8 слов: «12.34 слово 12.71 слово …» — время начала каждого слова
    for (let i = 0; i < r.words.length; i += 8)
      console.log("  " + r.words.slice(i, i + 8).map((w) => `${w.start.toFixed(2)} ${w.text.trim()}`).join("  ") + `  |${r.words[Math.min(i + 7, r.words.length - 1)].end.toFixed(2)}`);
    if (!r.words.length) console.log("  слов в этом окне нет");
    return;
  }
  if (cmd === "frames" || cmd === "grid") {
    const source = argv.shift();
    if (!source) fail(`${cmd}: укажите роль (talk, wide, screen) или файл (у озвучки кадров нет)`);
    const body = cmd === "grid" ? { source, grid: Number(argv[0] || 6) } : { source, times: argv.map(Number) };
    if (cmd === "frames" && (!body.times.length || body.times.some((t) => !Number.isFinite(t)))) fail("frames: укажите секунды числами");
    const r = await api(`${base}/frames`, body);
    for (const f of r.frames) console.log(`${sec(f.t)} с  ${f.path}`);
    return;
  }
  if (cmd === "roles") {
    const body = {};
    for (const a of argv) {
      const m = /^(talk|wide|screen|voice)=(.*)$/.exec(a);
      if (!m) fail(`roles: «${a}» — ожидается talk=<файл>, wide=<файл>, screen=<файл> (screen= можно несколько раз), voice=<аудиофайл> (можно несколько раз; voice= без файла — озвучку снять)`);
      // скринкастов и озвучек можно несколько: ключ повторяют
      if ((m[1] === "screen" || m[1] === "voice") && body[m[1]]) body[m[1]] = [].concat(body[m[1]], m[2]);
      else body[m[1]] = m[2];
    }
    const r = await api(`${base}/roles`, body);
    console.log("Роли: " + Object.entries(r.roles).map(([k, v]) => `${k}=${v}`).join(", "));
    return;
  }
  if (cmd === "mute") {
    const v = argv[0];
    if (v !== "on" && v !== "off") fail("mute: укажите on (звук видео не нужен) или off");
    const r = await api(`${base}/settings`, { muteVideo: v === "on" });
    console.log(r.muteVideo ? "Звук видео отключён: без озвучки ролики собираются без звука." : "Звук видео включён: без озвучки звук идёт с основы.");
    return;
  }
  if (cmd === "transcribe") {
    const j = await api(`${base}/transcribe`, { force: has("--force") });
    const done = await waitJob(j.id);
    if (done.status !== "done") fail(done.error || "расшифровка не удалась");
    return;
  }
  if (cmd === "check") {
    const c = await api(`${base}/check`, {});
    for (const v of c.variants) console.log(`${v.id}: «${v.hook}» · ${v.preset} · ${v.label} · ${sec(v.duration)} с`);
    for (const w of c.warnings) console.log("внимание: " + w);
    if (c.errors.length) {
      for (const e of c.errors) console.log("ОШИБКА: " + e);
      process.exit(2);
    }
    console.log(`Лист в порядке: ${c.variants.length} вариантов.`);
    return;
  }
  if (cmd === "build") {
    const hw = has("--cpu") ? "cpu" : undefined;
    const par = take("--par");
    const ids = argv[0] ? argv[0].split(",").map((s) => s.trim()).filter(Boolean) : [];
    const j = await api(`${base}/build-edit`, { variants: ids, hw, concurrency: par ? Number(par) : undefined });
    const done = await waitJob(j.id);
    if (done.runId) {
      const runs = await api(`${base}/runs`);
      const run = runs.find((r) => r.id === done.runId);
      if (run) {
        console.log(`Прогон ${run.id}: ${run.variants.filter((v) => v.status === "ready").length}/${run.count} в ${run.dir}`);
        for (const v of run.variants) {
          console.log(`  ${v.name ?? v.index} [${v.status}] «${v.hook}» ${v.order}`);
          if (v.status === "ready") console.log(`    ролик ${run.dir}/${v.file}\n    лист  ${run.dir}/${v.dir}/sheet.jpg`);
          if (v.error) console.log(`    ошибка: ${v.error.slice(0, 400)}`);
        }
      }
    }
    if (done.status !== "done") fail(done.error || "сборка не удалась");
    return;
  }
  if (cmd === "runs") {
    const runs = await api(`${base}/runs`);
    if (!runs.length) console.log("Сборок ещё не было.");
    for (const r of runs) console.log(`${r.id}: ${r.variants.filter((v) => v.status === "ready").length}/${r.count} — ${r.dir}`);
    return;
  }
  fail(`неизвестная команда «${cmd}»\n${HELP}`);
}

main().catch((e) => fail(e.message));
