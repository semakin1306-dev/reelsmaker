// Локальный интерфейс ReelsMaker: сюжеты из папки входа, расшифровка, сборка вариантов, просмотр роликов.
import { CORE_VERSION } from "@reels-factory/core";

export const PACKAGE_NAME = "@reels-factory/hub";
export const BUILT_ON_CORE = CORE_VERSION;

export { createHub, safeJoin, type HubOptions } from "./server.ts";
export { buildStory, listRuns, runIdFor, orderLabel, type RunSummary, type VariantSummary, type BuildOptions, type BuildEnv } from "./build.ts";
export { createJobQueue, type Job, type JobQueue } from "./jobs.ts";
