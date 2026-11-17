"""Тесты буфера Ring (python -m unittest apps/mic-clean/test_micclean.py); устройства и ffmpeg не нужны."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from micclean import BYTES_PER_MS, KEEP_MS, MAX_MS, PRIME_MS, Ring  # noqa: E402


def ms(n: int) -> bytes:
    return bytes([1, 0]) * (n * BYTES_PER_MS // 2)


class RingTest(unittest.TestCase):
    def test_silence_until_primed_then_data(self):
        r = Ring()
        r.push(ms(10))
        self.assertEqual(r.pull(480), b"\x00" * 960, "накоплено меньше PRIME_MS — играем тишину")
        r.push(ms(PRIME_MS))
        out = r.pull(480)  # 10 мс
        self.assertEqual(out, bytes([1, 0]) * 480, "накопилось — пошли данные")

    def test_underrun_goes_back_to_priming(self):
        r = Ring()
        r.push(ms(PRIME_MS + 5))
        r.pull(480)
        r.pull(r.size_ms().__int__() * 48 + 480)  # просим больше, чем есть
        self.assertEqual(r.underruns, 1)
        r.push(ms(3))  # было 35 мс + 3 = 38 < PRIME_MS
        self.assertEqual(r.pull(480), b"\x00" * 960, "после нехватки ждём PRIME_MS заново")
        r.push(ms(5))  # 43 мс
        self.assertEqual(r.pull(480), bytes([1, 0]) * 480, "накопилось — снова играем")

    def test_overflow_drops_oldest_and_keeps_samples_whole(self):
        r = Ring()
        r.push(ms(MAX_MS + 20))
        self.assertEqual(r.dropped, 1)
        self.assertAlmostEqual(r.size_ms(), KEEP_MS, delta=1)
        self.assertEqual(len(r.buf) % 2, 0, "отсчёт не разорван")


if __name__ == "__main__":
    unittest.main()
