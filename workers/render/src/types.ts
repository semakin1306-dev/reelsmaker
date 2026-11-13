// Типы сборщика (RF2). Только erasable-синтаксис: файлы грузятся и через tsx, и через родной strip-types Node.

export type Role = "hook" | "final" | "body";

export interface Word {
  text: string;
  /** секунды от начала сценки */
  start: number;
  end: number;
}

/** Формат transcript.json сценки (слова с таймкодами). Договорённость с RF1: секунды, относительно начала файла. */
export interface Transcript {
  text: string;
  words: Word[];
  language?: string;
}

export interface ClipInput {
  id: string;
  /** путь к файлу сценки; роль, номер и дубль берутся из имени файла */
  file: string;
  duration: number;
  /** нет данных — считаем, что звук есть */
  hasAudio?: boolean;
  transcript?: Transcript;
}

export interface StoryInput {
  id: string;
  title?: string;
  /** тема из сюжет.md: подставляется в шаблоны хуков */
  theme?: string;
  clips: ClipInput[];
}

export interface ParsedName {
  /** номер сцены (NN) */
  scene: number;
  /** дубль: "" (один) или буква a/b/… */
  take: string;
  role: Role;
  /** слово из имени (для подписи блока), может быть пустым */
  word: string;
}

export interface SceneTake {
  clip: ClipInput;
  take: string;
  word: string;
}

export interface Scene {
  number: number;
  role: Role;
  takes: SceneTake[];
}

export interface Trim {
  start: number;
  end: number;
}

export interface PlanScene {
  clipId: string;
  file: string;
  scene: number;
  take: string;
  role: Role;
  duration: number;
  hasAudio: boolean;
  trim: Trim;
  /** лёгкий зум и «дрейф» кадра внутри сцены */
  zoom: { factor: number; drift: number };
  /**
   * Перебивка: картинка из другого файла (дальний план) на ту же длину, начиная с секунды `start` этого файла.
   * Звук и субтитры по-прежнему из `file`/`clipId` на отрезке `trim`.
   */
  picture?: { file: string; start: number; crop?: Crop };
  /** Вставка (скринкаст) в рамку готового кадра, с секунды `start` файла вставки; без звука. */
  inset?: { file: string; start: number; box: Box; crop?: Crop };
  /** Кроп картинки основного файла (если нет перебивки) — до масштабирования в кадр. */
  crop?: Crop;
}

/**
 * Кроп исходника в долях кадра (0…1) — как кадр выглядит при показе (с учётом поворота телефона).
 * Не зависит от разрешения: тот же кроп годится и для превью, и для сборки.
 */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Прямоугольник в пикселях готового кадра (1080×1920). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlanBlock {
  text: string;
  /** индекс сцены в plan.scenes */
  sceneIndex: number;
  /** секунды от начала сцены (до ускорения) */
  offset: number;
  duration: number;
}

export interface OutputFormat {
  width: number;
  height: number;
  fps: number;
}

/** Схема монтажа — содержимое variant.plan (JSON). */
export interface VariantPlan {
  version: 1;
  index: number;
  seed: number;
  preset: string;
  hook: { text: string; duration: number };
  scenes: PlanScene[];
  blocks: PlanBlock[];
  /** 0.95–1.05; тембр сохраняет atempo */
  speed: number;
  /** сдвиг высоты звука, 0.98–1.02 (1 = без сдвига) */
  pitch: number;
  captions: boolean;
  output: OutputFormat;
}

export interface PlanResult {
  plans: VariantPlan[];
  warnings: string[];
}

/** Минимальный интерфейс текстовой модели; реализует packages/core/src/llm/claude.ts. */
export interface TextLlm {
  complete(req: { system: string; prompt: string; maxTokens?: number }): Promise<string>;
}

export const DEFAULT_OUTPUT: OutputFormat = { width: 1080, height: 1920, fps: 30 };

/**
 * Охранная зона Reels для кадра 1080×1920 (схема владельца, IG Sizing Guide 2023): сверху 220, снизу 450, по бокам 35 px —
 * там интерфейс площадки (ник, подпись, кнопки). Весь текст и рамка экрана держатся внутри прямоугольника 1010×1250.
 */
export const SAFE_AREA = { top: 220, bottom: 450, side: 35 } as const;
export const SAFE_BOX: Box = {
  x: SAFE_AREA.side,
  y: SAFE_AREA.top,
  w: DEFAULT_OUTPUT.width - 2 * SAFE_AREA.side,
  h: DEFAULT_OUTPUT.height - SAFE_AREA.top - SAFE_AREA.bottom,
};
