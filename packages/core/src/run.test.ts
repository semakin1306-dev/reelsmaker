import { test } from "node:test";
import assert from "node:assert/strict";
import { run, RunError } from "./run.ts";

const node = process.execPath;

test("run: stdout, stderr и код возврата", async () => {
  const r = await run(node, ["-e", "console.log('ok'); console.error('warn'); process.exit(3)"], { timeout: 10_000 });
  assert.equal(r.code, 3);
  assert.equal(r.ok, false);
  assert.equal(r.stdout.trim(), "ok");
  assert.equal(r.stderr.trim(), "warn");
  assert.equal(r.timedOut, false);
});

test("run: аргументы — массивом, без оболочки (метасимволы не исполняются)", async () => {
  const evil = "a b; echo INJECTED && echo $HOME | cat";
  const r = await run(node, ["-e", "process.stdout.write(process.argv[1])", evil], { timeout: 10_000 });
  assert.equal(r.ok, true);
  assert.equal(r.stdout, evil);
});

test("run: по таймауту процесс убивается, результат помечен timedOut", async () => {
  const t0 = Date.now();
  const r = await run(node, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 10_000);
});

test("run: несуществующая программа — RunError с именем программы", async () => {
  await assert.rejects(run("нет-такой-программы-rf", [], { timeout: 5_000 }), (e: unknown) => {
    assert.ok(e instanceof RunError);
    assert.match(e.message, /нет-такой-программы-rf/);
    return true;
  });
});

test("run: check=true превращает ненулевой код и таймаут в RunError с хвостом stderr", async () => {
  await assert.rejects(
    run(node, ["-e", "console.error('сломалось'); process.exit(2)"], { timeout: 10_000, check: true }),
    (e: unknown) => {
      assert.ok(e instanceof RunError);
      assert.match(e.message, /сломалось/);
      assert.equal(e.result?.code, 2);
      return true;
    },
  );
  await assert.rejects(
    run(node, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 200, check: true }),
    /таймаут/,
  );
});

test("run: stdin, cwd и env передаются", async () => {
  const script =
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s+process.env.RF_X+process.cwd().length))";
  const r = await run(node, ["-e", script], {
    timeout: 10_000,
    input: "вход-",
    env: { RF_X: "!" },
    cwd: process.cwd(),
  });
  assert.equal(r.stdout, `вход-!${process.cwd().length}`);
});

test("run: вывод сверх лимита обрезается, процесс не падает", async () => {
  const r = await run(node, ["-e", "process.stdout.write('x'.repeat(100000))"], { timeout: 10_000, maxOutput: 1000 });
  assert.equal(r.stdout.length, 1000);
  assert.equal(r.truncated, true);
});
