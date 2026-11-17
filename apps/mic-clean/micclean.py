"""Виртуальный микрофон с очисткой голоса — программа в трее.

Настоящий микрофон (Behringer C-1U) → ffmpeg с цепочкой очистки (та же, что для озвучки в ReelsMaker: режекторы USB-гребёнки,
шумоподавление по образцу шума, гейт) → виртуальный кабель VB-Cable. В программах (Telegram, Windows, OBS…) микрофоном выбирают
«CABLE Output (VB-Audio Virtual Cable)». Цепочку строит TypeScript (apps/pc-agent/src/mic-clean.ts) — единый источник правды;
здесь только устройства, буфер и значок в трее.

Меню значка: очистка вкл/выкл (выкл — звук как есть, для звонков; микрофон в программах не пропадает), «Выучить шум»
(3 секунды тишины → образец шума), автозапуск, лог, выход.

Запуск: MicClean.bat (или pythonw apps/mic-clean/micclean.py). Отладка без устройств: --no-tray --null-sink файл.raw --seconds 8.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def data_dir() -> Path:
    """Папка данных ReelsMaker: переменная окружения RF_DATA_DIR, иначе RF_DATA_DIR из .env в корне проекта, иначе ~/ReelsMaker."""
    env = os.environ.get("RF_DATA_DIR", "").strip()
    if env:
        return Path(env)
    try:
        for line in (REPO / ".env").read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "RF_DATA_DIR" and value.strip():
                return Path(value.strip().strip("\"'"))
    except OSError:
        pass
    return Path.home() / "ReelsMaker"


DATA = data_dir()
CONFIG = DATA / "micclean.json"
LOG = DATA / "micclean.log"
FFLOG = DATA / "micclean-ffmpeg.log"
CLI = REPO / "apps" / "pc-agent" / "src" / "mic-clean-cli.ts"

RATE = 48000
BYTES_PER_MS = RATE * 2 // 1000  # моно s16
PRIME_MS = 40  # столько накопить, прежде чем начать играть
MAX_MS = 150  # больше — отстаём: роняем старое
KEEP_MS = 60  # до скольки роняем
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def log(msg: str) -> None:
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except OSError:
        pass


# ───────────────────────────── буфер между ffmpeg и звуковой картой ─────────────────────────────


class Ring:
    """Очередь байт моно s16 48 кГц. Часы микрофона и кабеля чуть расходятся: при отставании старое роняем, при нехватке — тишина."""

    def __init__(self) -> None:
        self.buf = bytearray()
        self.lock = threading.Lock()
        self.primed = False
        self.dropped = 0
        self.underruns = 0

    def push(self, data: bytes) -> None:
        with self.lock:
            self.buf += data
            if len(self.buf) > MAX_MS * BYTES_PER_MS:
                cut = len(self.buf) - KEEP_MS * BYTES_PER_MS
                cut -= cut % 2  # не рвём отсчёт пополам
                del self.buf[:cut]
                self.dropped += 1

    def pull(self, frames: int) -> bytes:
        """frames отсчётов; не хватает — тишина, а играть снова начнём, когда накопится PRIME_MS."""
        need = frames * 2
        with self.lock:
            if not self.primed and len(self.buf) >= PRIME_MS * BYTES_PER_MS:
                self.primed = True
            if self.primed and len(self.buf) >= need:
                out = bytes(self.buf[:need])
                del self.buf[:need]
                return out
            if self.primed:
                self.primed = False
                self.underruns += 1
            return b"\x00" * need

    def size_ms(self) -> float:
        with self.lock:
            return len(self.buf) / BYTES_PER_MS


# ───────────────────────────── устройства ─────────────────────────────


def find_output(name_part: str):
    """Индекс устройства воспроизведения с name_part в имени; WASAPI предпочтительнее."""
    import sounddevice as sd

    wasapi = next((i for i, h in enumerate(sd.query_hostapis()) if "WASAPI" in h["name"]), None)
    found = [(i, d) for i, d in enumerate(sd.query_devices()) if d["max_output_channels"] > 0 and name_part.lower() in d["name"].lower()]
    for i, d in found:
        if d["hostapi"] == wasapi:
            return i, d
    return found[0] if found else (None, None)


def node_exe() -> str:
    return shutil.which("node") or "node"


def run_cli(*args: str, timeout: int = 60) -> dict:
    r = subprocess.run(
        [node_exe(), "--import", "tsx", str(CLI), *args],
        cwd=str(REPO), capture_output=True, text=True, encoding="utf-8", timeout=timeout, creationflags=CREATE_NO_WINDOW,
    )
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout).strip() else "ошибка плана")
    return json.loads(r.stdout)


def read_config() -> dict:
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_config(patch: dict) -> None:
    cfg = read_config()
    cfg.update(patch)
    DATA.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# ───────────────────────────── движок ─────────────────────────────


class Engine:
    """ffmpeg (микрофон → очистка → PCM) → буфер → виртуальный кабель."""

    def __init__(self, on_change, null_sink: str | None = None) -> None:
        self.on_change = on_change
        self.null_sink = null_sink
        self.state = "off"  # off | starting | on | error
        self.mode = ""  # clean | passthrough
        self.message = ""
        self.ring = Ring()
        self.proc: subprocess.Popen | None = None
        self.stream = None
        self.stopping = False
        self.lock = threading.RLock()
        self.failures = 0
        self.started = 0.0
        self.sink_file = None

    def _set(self, state: str, message: str = "") -> None:
        self.state, self.message = state, message
        log(f"состояние: {state} {message}".strip())
        self.on_change()

    def start(self) -> None:
        with self.lock:
            self.stop(quiet=True)
            self.stopping = False
            self._set("starting")
            try:
                cfg = read_config()
                plan = run_cli("plan", "--config", str(CONFIG))
                self.mode = plan["mode"]
                if plan.get("note"):
                    log("внимание: " + plan["note"])
                ffmpeg = cfg.get("ffmpegPath") or shutil.which("ffmpeg") or "ffmpeg"
                self.ring = Ring()
                self._open_sink(cfg)
                FFLOG.parent.mkdir(parents=True, exist_ok=True)
                self.proc = subprocess.Popen(
                    [ffmpeg, *plan["args"]], stdout=subprocess.PIPE, stderr=FFLOG.open("ab"), stdin=subprocess.DEVNULL,
                    creationflags=CREATE_NO_WINDOW, bufsize=0,
                )
                self.started = time.time()
                threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()
                self._set("on", plan.get("note") or "")
            except Exception as e:  # noqa: BLE001 — любую причину показываем в меню
                self._close_sink()
                self._set("error", str(e))

    def stop(self, quiet: bool = False) -> None:
        with self.lock:
            self.stopping = True
            p, self.proc = self.proc, None
            if p and p.poll() is None:
                p.terminate()
                try:
                    p.wait(3)
                except subprocess.TimeoutExpired:
                    p.kill()
            self._close_sink()
            if not quiet:
                self._set("off")

    # — вывод звука —
    def _open_sink(self, cfg: dict) -> None:
        if self.null_sink:
            self.sink_file = open(self.null_sink, "wb")
            return
        import numpy as np
        import sounddevice as sd

        idx, dev = find_output(cfg.get("output", "CABLE Input"))
        if idx is None:
            raise RuntimeError("не найден виртуальный кабель (CABLE Input) — установите VB-Cable и перезагрузите компьютер")
        channels = 2 if dev["max_output_channels"] >= 2 else 1
        ring = self.ring

        def callback(outdata, frames, _time, _status):
            mono = np.frombuffer(ring.pull(frames), dtype=np.int16)
            if channels == 2:
                outdata[:, 0] = mono
                outdata[:, 1] = mono
            else:
                outdata[:, 0] = mono

        extra = sd.WasapiSettings(auto_convert=True) if "WASAPI" in sd.query_hostapis(dev["hostapi"])["name"] else None
        self.stream = sd.OutputStream(
            device=idx, samplerate=RATE, channels=channels, dtype="int16", blocksize=480, latency=0.06, callback=callback, extra_settings=extra,
        )
        self.stream.start()
        log(f"вывод: {dev['name']} ({channels} кан.)")

    def _close_sink(self) -> None:
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:  # noqa: BLE001
                pass
            self.stream = None
        if self.sink_file is not None:
            self.sink_file.close()
            self.sink_file = None

    def _reader(self, proc: subprocess.Popen) -> None:
        try:
            while True:
                chunk = proc.stdout.read(960)  # 10 мс
                if not chunk:
                    break
                if self.sink_file is not None:
                    self.sink_file.write(chunk)
                self.ring.push(chunk)
        except (OSError, ValueError):
            pass
        if self.stopping or self.proc is not proc:
            return
        # ffmpeg умер сам (отключили микрофон, ошибка устройства): перезапуск с паузой, не больше 5 раз подряд
        code = proc.poll()
        self.failures = 0 if time.time() - self.started > 30 else self.failures + 1
        if self.failures >= 5:
            self._set("error", f"ffmpeg остановился (код {code}), см. {FFLOG.name}")
            return
        self._set("starting", f"ffmpeg остановился (код {code}), перезапуск")
        time.sleep(3)
        if not self.stopping:
            self.start()

    def title(self) -> str:
        if self.state == "on":
            return "очистка голоса включена" if self.mode == "clean" else "звук без обработки"
        return {"off": "выключено", "starting": "запуск…"}.get(self.state, "ошибка: " + self.message)


# ───────────────────────────── выучить шум ─────────────────────────────


def learn_noise(engine: Engine, notify) -> None:
    """3 секунды тишины с микрофона по DirectShow → образец шума (тот же путь, что у рабочего потока)."""
    cfg = read_config()
    ffmpeg = cfg.get("ffmpegPath") or shutil.which("ffmpeg") or "ffmpeg"
    inp = cfg.get("input", "Микрофон (2- C-1U)")
    sample = Path(cfg.get("noiseSample") or DATA / "noise" / "live.wav")
    was_on = engine.state in ("on", "starting")
    engine.stop(quiet=True)
    sample.parent.mkdir(parents=True, exist_ok=True)
    tmp = sample.with_name("live.tmp.wav")
    notify("Помолчите 4 секунды — идёт замер шума микрофона")
    try:
        r = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "dshow", "-audio_buffer_size", "20", "-i", f"audio={inp}",
             "-ss", "0.7", "-t", "3", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s24le", str(tmp)],
            capture_output=True, text=True, encoding="utf-8", timeout=60, creationflags=CREATE_NO_WINDOW,
        )
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "ffmpeg не записал микрофон")
        info = run_cli("sample", str(tmp), "--ffmpeg", ffmpeg)
        if info["seconds"] < 2:
            raise RuntimeError("записалось меньше двух секунд")
        if info["spreadDb"] > 8:
            tmp.unlink(missing_ok=True)
            notify("В образец попал звук (разброс уровня %.0f дБ) — повторите и молчите все 4 секунды" % info["spreadDb"])
        else:
            os.replace(tmp, sample)
            write_config({"noiseSample": str(sample)})
            log(f"образец шума: {info}")
            notify("Шум микрофона выучен (%.1f с, уровень %.0f dBFS)" % (info["seconds"], info["floorDb"]))
    except Exception as e:  # noqa: BLE001
        log(f"выучить шум: {e}")
        notify("Не удалось выучить шум: " + str(e))
    finally:
        tmp.unlink(missing_ok=True)
        if was_on or True:
            engine.start()


# ───────────────────────────── автозапуск ─────────────────────────────

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_NAME = "ReelsMakerMicClean"


def autostart_enabled() -> bool:
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.QueryValueEx(k, RUN_NAME)
            return True
    except OSError:
        return False


def set_autostart(on: bool) -> None:
    import winreg

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        if on:
            pyw = Path(sys.executable).with_name("pythonw.exe")
            exe = pyw if pyw.exists() else Path(sys.executable)
            winreg.SetValueEx(k, RUN_NAME, 0, winreg.REG_SZ, f'"{exe}" "{Path(__file__).resolve()}"')
        else:
            try:
                winreg.DeleteValue(k, RUN_NAME)
            except FileNotFoundError:
                pass


# ───────────────────────────── значок в трее ─────────────────────────────


def make_icon(state: str, mode: str):
    from PIL import Image, ImageDraw

    color = {"on": (46, 160, 67) if mode == "clean" else (210, 153, 34), "starting": (210, 153, 34), "error": (218, 54, 51)}.get(state, (110, 118, 129))
    im = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((2, 2, 62, 62), fill=color)
    white = (255, 255, 255, 255)
    d.rounded_rectangle((25, 12, 39, 36), radius=7, fill=white)  # капсюль
    d.arc((19, 24, 45, 46), 0, 180, fill=white, width=3)  # дуга-подставка
    d.line((32, 46, 32, 53), fill=white, width=3)
    d.line((24, 53, 40, 53), fill=white, width=3)
    if state == "on" and mode != "clean":
        d.line((12, 52, 52, 12), fill=(218, 54, 51, 255), width=5)  # перечёркнут: без обработки
    return im


def single_instance() -> bool:
    """Второй экземпляр не запускаем (мьютекс Windows)."""
    h = ctypes.windll.kernel32.CreateMutexW(None, False, "Global\\ReelsMakerMicClean")
    return ctypes.windll.kernel32.GetLastError() != 183 and bool(h)


def run_tray(engine: Engine) -> None:
    import pystray

    icon_ref: dict = {}

    def refresh() -> None:
        ic = icon_ref.get("icon")
        if ic:
            ic.icon = make_icon(engine.state, engine.mode)
            ic.title = "ReelsMaker · микрофон: " + engine.title()
            ic.update_menu()

    engine.on_change = refresh

    def toggle_clean(_icon, _item) -> None:
        write_config({"processing": not read_config().get("processing", True)})
        threading.Thread(target=engine.start, daemon=True).start()

    def learn(icon, _item) -> None:
        threading.Thread(target=learn_noise, args=(engine, lambda m: icon.notify(m, "ReelsMaker · микрофон")), daemon=True).start()

    def autostart(_icon, _item) -> None:
        set_autostart(not autostart_enabled())

    def quit_app(icon, _item) -> None:
        engine.stop(quiet=True)
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem(lambda _i: "Состояние: " + engine.title(), None, enabled=False),
        pystray.MenuItem("Очистка голоса (выкл — для звонков)", toggle_clean, checked=lambda _i: read_config().get("processing", True)),
        pystray.MenuItem("Выучить шум микрофона (4 с тишины)", learn),
        pystray.MenuItem("Запускать вместе с Windows", autostart, checked=lambda _i: autostart_enabled()),
        pystray.MenuItem("Открыть лог", lambda _i, _m: os.startfile(LOG) if LOG.exists() else None),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Выход", quit_app),
    )
    icon = pystray.Icon("ReelsMakerMic", make_icon("off", ""), "ReelsMaker · микрофон", menu)
    icon_ref["icon"] = icon
    threading.Thread(target=engine.start, daemon=True).start()
    icon.run()


def main() -> int:
    ap = argparse.ArgumentParser(description="Виртуальный микрофон с очисткой голоса (трей)")
    ap.add_argument("--no-tray", action="store_true", help="без значка: запустить движок и работать, пока не нажмут Ctrl+C (или --seconds)")
    ap.add_argument("--null-sink", help="вместо кабеля писать PCM в файл (отладка без драйвера)")
    ap.add_argument("--seconds", type=float, default=0, help="с --no-tray: остановиться через N секунд")
    args = ap.parse_args()
    if not args.no_tray and not single_instance():
        return 0
    engine = Engine(lambda: None, null_sink=args.null_sink)
    if args.no_tray:
        engine.start()
        t0 = time.time()
        try:
            while not args.seconds or time.time() - t0 < args.seconds:
                time.sleep(0.2)
        except KeyboardInterrupt:
            pass
        engine.stop()
        print(f"состояние: {engine.state} {engine.message}; буфер: уронено {engine.ring.dropped}, нехваток {engine.ring.underruns}")
        return 0 if engine.state != "error" else 1
    run_tray(engine)
    return 0


if __name__ == "__main__":
    sys.exit(main())
