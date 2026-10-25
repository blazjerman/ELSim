import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "benchmark-firefox-memory.py"
SPEC = importlib.util.spec_from_file_location("benchmark_firefox_memory", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FirefoxProcessRoleTests(unittest.TestCase):
    def test_main_browser_process(self):
        self.assertEqual(MODULE.firefox_process_role("firefox", "/usr/lib/firefox/firefox -profile /tmp/profile", is_root=True), "browser-main")

    def test_content_process(self):
        self.assertEqual(MODULE.firefox_process_role("firefox", "/usr/lib/firefox/firefox -contentproc -childID 3"), "content")
        self.assertEqual(MODULE.firefox_process_role("Web Content", "/usr/lib/firefox/firefox"), "content")

    def test_auxiliary_processes(self):
        cases = [
            ("firefox", "-gpu", "gpu"),
            ("firefox", "-rdd", "remote-data-decoder"),
            ("firefox", "-socket", "socket"),
            ("firefox", "-utility", "utility"),
            ("WebExtensions", "/usr/lib/firefox/firefox", "extensions"),
            ("Socket Process", "/usr/lib/firefox/firefox", "socket"),
            ("RDD Process", "/usr/lib/firefox/firefox", "remote-data-decoder"),
            ("Utility Process", "/usr/lib/firefox/firefox", "utility"),
            ("GPU Process", "/usr/lib/firefox/firefox", "gpu"),
            ("forkserver", "python3", "playwright-helper"),
        ]
        for comm, arguments, expected in cases:
            with self.subTest(comm=comm, arguments=arguments):
                self.assertEqual(MODULE.firefox_process_role(comm, arguments), expected)

    def test_non_firefox_process_is_not_classified_as_browser(self):
        self.assertEqual(MODULE.firefox_process_role("python3", "python3 benchmark-firefox-memory.py"), "other")


if __name__ == "__main__":
    unittest.main()
