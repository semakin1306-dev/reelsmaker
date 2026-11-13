// Публичный вход сборщика RF2. После влива RF0 в `workers/render/src/index.ts` добавляется `export * from "./public.ts";`
// (index.ts заготовки принадлежит RF0, здесь его не трогаем, чтобы не плодить конфликт слияния).
export * from "./types.ts";
export * from "./names.ts";
export * from "./presets.ts";
export * from "./ass.ts";
export * from "./planner/index.ts";
export { buildFfmpegJob, cropFilter, type FfmpegJob, type RenderOptions, type HwMode } from "./ffmpeg/graph.ts";
export { renderVariant, probeDuration, RenderError, type RenderDeps, type RenderVariantParams, type RenderVariantResult } from "./ffmpeg/render.ts";
export { makePreviews, buildCoverArgs, buildSheetArgs } from "./ffmpeg/preview.ts";
export { defaultRun, type RunFn, type RunResult } from "./ffmpeg/runner.ts";
export * from "./queue.ts";
export * from "./montage.ts";
export * from "./fonts.ts";
