import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import urlopen

from fastapi import FastAPI

import desktop


class DesktopCloseProtocolTests(unittest.TestCase):
    def test_only_known_frontend_dispositions_are_accepted(self):
        self.assertEqual(desktop._normalize_close_disposition("saved"), desktop.CLOSE_SAVED)
        self.assertEqual(
            desktop._normalize_close_disposition("save-failed"),
            desktop.CLOSE_SAVE_FAILED,
        )
        self.assertEqual(
            desktop._normalize_close_disposition("cancelled"),
            desktop.CLOSE_CANCELLED,
        )

    def test_unknown_and_non_string_bridge_results_fail_closed(self):
        for result in (True, False, None, {}, [], "truthy-but-unknown"):
            with self.subTest(result=result):
                self.assertEqual(
                    desktop._normalize_close_disposition(result),
                    desktop.CLOSE_UNAVAILABLE,
                )

    def test_only_saved_or_already_cancelled_results_skip_native_confirmation(self):
        self.assertFalse(
            desktop._requires_close_without_save_confirmation(desktop.CLOSE_SAVED)
        )
        self.assertFalse(
            desktop._requires_close_without_save_confirmation(desktop.CLOSE_CANCELLED)
        )
        for disposition in (
            desktop.CLOSE_SAVE_FAILED,
            desktop.CLOSE_TIMED_OUT,
            desktop.CLOSE_UNAVAILABLE,
            "unknown",
        ):
            with self.subTest(disposition=disposition):
                self.assertTrue(
                    desktop._requires_close_without_save_confirmation(disposition)
                )


class DesktopShellTests(unittest.TestCase):
    def test_program_files_install_uses_local_app_data(self):
        with (
            patch.object(desktop.sys, "platform", "win32"),
            patch.object(desktop, "INSTALL_ROOT", Path("C:/Program Files/ScriptSurgeon")),
            patch.dict(
                desktop.os.environ,
                {
                    "ProgramFiles": "C:/Program Files",
                    "LOCALAPPDATA": "C:/Users/Test/AppData/Local",
                },
                clear=True,
            ),
        ):
            self.assertEqual(
                desktop._default_data_dir(),
                Path("C:/Users/Test/AppData/Local/ScriptSurgeon"),
            )

    def test_non_program_files_install_keeps_existing_data_location(self):
        with (
            patch.object(desktop.sys, "platform", "win32"),
            patch.object(desktop, "INSTALL_ROOT", Path("D:/Apps/ScriptSurgeon")),
            patch.dict(
                desktop.os.environ,
                {
                    "ProgramFiles": "C:/Program Files",
                    "LOCALAPPDATA": "C:/Users/Test/AppData/Local",
                },
                clear=True,
            ),
        ):
            self.assertEqual(
                desktop._default_data_dir(),
                Path("D:/Apps/ScriptSurgeon/Data"),
            )

    def test_microphone_guard_accepts_only_this_launch_exact_origin(self):
        port = 43123
        self.assertTrue(
            desktop._is_scriptcut_microphone_request(
                f"http://127.0.0.1:{port}/?token=private",
                port,
                True,
            )
        )
        for uri, initiated in (
            (f"http://127.0.0.1:{port}/", False),
            (f"http://localhost:{port}/", True),
            (f"https://127.0.0.1:{port}/", True),
            (f"http://127.0.0.1:{port + 1}/", True),
            ("not a URI", True),
        ):
            with self.subTest(uri=uri, initiated=initiated):
                self.assertFalse(
                    desktop._is_scriptcut_microphone_request(uri, port, initiated)
                )

    def test_local_server_starts_serves_and_stops_cleanly(self):
        app = FastAPI()

        @app.get("/health")
        def health():
            return {"ok": True}

        server = desktop.LocalServer(app)
        try:
            server.start(timeout=5)
            with urlopen(f"{server.url}/health", timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b'{"ok":true}')
        finally:
            server.stop()

        self.assertFalse(server._thread.is_alive())
        self.assertEqual(server._socket.fileno(), -1)
