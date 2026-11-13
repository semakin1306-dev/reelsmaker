import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderWorker, defaultConcurrency, STORY_STATUS, VARIANT_STATUS, type RenderStore, type VariantPatch } from "./queue.ts";
import type { Preset, TextStyle } from "./presets.ts";
import { RenderError } from "./ffmpeg/render.ts";
import { fakeStory } from "./testing/fixtures.ts";
import type { StoryInput, VariantPlan } from "./types.ts";

const style: TextStyle = {
  font: "F", fontFile: "f.ttf", size: 80, bold: false, italic: false, color: "#FFFFFF", outlineColor: "#000000",
  outline: 4, shadow: 0, borderStyle: 1, alignment: 2, marginV: 300, marginH: 60, uppercase: false, spacing: 0,
};
const presets: Preset[] = ["p1", "p2", "p3"].map((id) => ({
  id, title: id, grade: {}, hook: style, caption: { ...style, maxWords: 3, maxChars: 0, karaoke: false, highlight: "#FFFFFF" }, block: style,
}));

class MemStore implements RenderStore {
  queue: StoryInput[];
  variants = new Map<string, { storyId: string; index: number; plan: VariantPlan; patches: VariantPatch[] }>();
  stories = new Map<string, { status: string; note?: string }>();
  constructor(stories: StoryInput[]) {
    this.queue = stories.slice();
  }
  async claimStory() {
    const s = this.queue.shift() ?? null;
    if (s) this.stories.set(s.id, { status: STORY_STATUS.claimed });
    return s;
  }
  async createVariant(storyId: string, index: number, plan: VariantPlan) {
    const id = `${storyId}#${index}`;
    this.variants.set(id, { storyId, index, plan, patches: [{ status: VARIANT_STATUS.planned }] });
    return id;
  }
  async updateVariant(id: string, patch: VariantPatch) {
    this.variants.get(id)!.patches.push(patch);
  }
  async finishStory(storyId: string, status: string, note?: string) {
    this.stories.set(storyId, { status, note });
  }
}

const last = (s: MemStore, id: string) => s.variants.get(id)!.patches.at(-1)!;

test("воркер: сюжет → 10 вариантов в базе, каждый ready, сюжет «rendered»; файлы в <out>/<сюжет>/vNN", async () => {
  const store = new MemStore([fakeStory()]);
  const outDirs: string[] = [];
  const worker = createRenderWorker(
    {
      store,
      renderVariant: async (p) => {
        outDirs.push(p.outDir.replace(/\\/g, "/"));
        return { video: `${p.outDir}/video.mp4`, cover: `${p.outDir}/cover.jpg`, sheet: `${p.outDir}/sheet.jpg`, log: `${p.outDir}/ffmpeg.log`, duration: 10, expectedDuration: 10 };
      },
    },
    { presets, outRoot: "/data/variants", concurrency: 3 },
  );
  const res = await worker.processNext();
  assert.equal(res?.ready, 10);
  assert.equal(res?.failed, 0);
  assert.equal(store.variants.size, 10);
  for (const [id, v] of store.variants) {
    assert.equal(last(store, id).status, VARIANT_STATUS.ready);
    assert.ok(v.patches.some((p) => p.status === VARIANT_STATUS.rendering), "прошёл статус «собирается»");
    assert.ok(last(store, id).video?.endsWith("video.mp4"));
  }
  assert.equal(store.stories.get("fixture-story")?.status, STORY_STATUS.done);
  assert.ok(outDirs.includes("/data/variants/fixture-story/v00") && outDirs.includes("/data/variants/fixture-story/v09"));
  assert.equal(await worker.processNext(), null, "очередь пуста");
});

test("воркер: упавший вариант не валит сюжет; журнал ffmpeg указан у упавшего", async () => {
  const store = new MemStore([fakeStory()]);
  const worker = createRenderWorker(
    {
      store,
      renderVariant: async (p) => {
        if (p.plan.index === 3) throw new RenderError("ffmpeg завершился с кодом 1", `${p.outDir}/ffmpeg.log`);
        return { video: "v", cover: "c", sheet: "s", log: "l", duration: 1, expectedDuration: 1 };
      },
    },
    { presets, outRoot: "/o", count: 5, concurrency: 2 },
  );
  const res = await worker.processNext();
  assert.deepEqual([res?.ready, res?.failed], [4, 1]);
  const failed = last(store, "fixture-story#3");
  assert.equal(failed.status, VARIANT_STATUS.failed);
  assert.match(failed.error ?? "", /кодом 1/);
  assert.ok(failed.log?.endsWith("v03/ffmpeg.log") || failed.log?.endsWith("v03\\ffmpeg.log"));
  const st = store.stories.get("fixture-story")!;
  assert.equal(st.status, STORY_STATUS.done);
  assert.match(st.note ?? "", /не собрано 1/);
});

test("воркер: все варианты упали — сюжет «render_failed»", async () => {
  const store = new MemStore([fakeStory()]);
  const worker = createRenderWorker(
    { store, renderVariant: async () => { throw new Error("нет ffmpeg"); } },
    { presets, outRoot: "/o", count: 3, concurrency: 1 },
  );
  await worker.processNext();
  assert.equal(store.stories.get("fixture-story")?.status, STORY_STATUS.failed);
});

test("воркер: сюжет без сцен — «render_failed» с причиной планировщика", async () => {
  const store = new MemStore([{ id: "empty", clips: [] }]);
  const worker = createRenderWorker({ store, renderVariant: async () => { throw new Error("не должен вызываться"); } }, { presets, outRoot: "/o" });
  await worker.processNext();
  const st = store.stories.get("empty")!;
  assert.equal(st.status, STORY_STATUS.failed);
  assert.match(st.note ?? "", /планировщик/);
});

test("воркер: одновременных рендеров не больше concurrency", async () => {
  const store = new MemStore([fakeStory()]);
  let active = 0;
  let peak = 0;
  const worker = createRenderWorker(
    {
      store,
      renderVariant: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return { video: "v", cover: "c", sheet: "s", log: "l", duration: 1, expectedDuration: 1 };
      },
    },
    { presets, outRoot: "/o", count: 8, concurrency: 3 },
  );
  await worker.processNext();
  assert.equal(peak, 3);
});

test("воркер: drain обрабатывает очередь до конца по одному сюжету", async () => {
  const a = fakeStory();
  a.id = "a";
  const b = fakeStory();
  b.id = "b";
  const store = new MemStore([a, b]);
  const worker = createRenderWorker(
    { store, renderVariant: async () => ({ video: "v", cover: "c", sheet: "s", log: "l", duration: 1, expectedDuration: 1 }) },
    { presets, outRoot: "/o", count: 2, concurrency: 1 },
  );
  const done = await worker.drain();
  assert.deepEqual(done.map((d) => d.storyId), ["a", "b"]);
});

test("по умолчанию рендеров ядер/2, не меньше одного", () => {
  assert.ok(defaultConcurrency() >= 1);
});
