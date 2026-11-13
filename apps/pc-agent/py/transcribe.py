"""Расшифровка видео ReelsMaker моделью faster-whisper.

Запускается интерпретатором окружения с faster-whisper (RF_STT_PYTHON), модель — локальный каталог (RF_STT_MODEL),
сеть не нужна: HF_HUB_OFFLINE=1 ставит вызывающая сторона. Модель поднимается на один прогон
(все файлы сюжета) и выгружается вместе с процессом.

  python transcribe.py --model <каталог модели> [--language ru] [--device cuda] [--compute int8_float16] файл...

stdout — по строке JSON на файл, в порядке аргументов:
  {"file": "...", "ok": true, "transcript": {"text": "...", "language": "ru", "words": [{"text", "start", "end"}]}}
  {"file": "...", "ok": false, "error": "..."}
Время слов — секунды от начала файла. Код выхода 2 — модель не загрузилась (строк по файлам нет).
"""

import argparse
import json
import os
import sys


def load_cuda_dlls():
    # DLL CUDA лежат в пакетах nvidia-* окружения, без CUDA Toolkit
    base = os.path.abspath(os.path.join(os.path.dirname(sys.executable), "..", "Lib", "site-packages", "nvidia"))
    for sub in ("cublas", "cudnn", "cuda_nvrtc"):
        d = os.path.join(base, sub, "bin")
        if os.path.isdir(d):
            os.add_dll_directory(d)
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--language", default="ru")
    ap.add_argument("--device", default="cuda")
    # НЕ float16: на GTX 16xx (TU116) он не работает как надо — тот же выбор, что у службы
    ap.add_argument("--compute", default="int8_float16")
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()

    if args.device == "cuda":
        load_cuda_dlls()
    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(args.model, device=args.device, compute_type=args.compute)
    except Exception as e:  # noqa: BLE001 — причину отдаём вызывающему целиком
        sys.stderr.write("модель не загрузилась: %s\n" % e)
        sys.exit(2)

    for f in args.files:
        try:
            segments, info = model.transcribe(
                f,
                language=args.language,
                beam_size=5,
                word_timestamps=True,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            words = []
            parts = []
            for seg in segments:
                parts.append(seg.text.strip())
                for w in seg.words or []:
                    text = w.word.strip()
                    if text:
                        words.append({"text": text, "start": round(w.start, 3), "end": round(w.end, 3)})
            emit({
                "file": f,
                "ok": True,
                "transcript": {"text": " ".join(p for p in parts if p), "language": info.language, "words": words},
            })
        except Exception as e:  # noqa: BLE001
            emit({"file": f, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
