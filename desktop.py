"""Native desktop launcher for ScriptSurgeon.

The packaged application owns a loopback-only Uvicorn server and displays it
in a native pywebview window. Windows uses Edge WebView2 (with a conservative
Edge app-mode fallback); macOS uses Cocoa/WebKit. Both shells retain the same
local-server lifecycle and keep project data outside their shipped payload.
"""

from __future__ import annotations

import atexit
import ctypes
import json
import logging
import math
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import wave
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import urlopen

APP_NAME = "ScriptSurgeon"
LOOPBACK = "127.0.0.1"
ALREADY_EXISTS = 183

# Native-close protocol returned by the frontend bridge.  Keep these as exact
# strings rather than booleans: truthiness must never turn an unknown or failed
# save into permission to destroy the window.
CLOSE_SAVED = "saved"
CLOSE_SAVE_FAILED = "save-failed"
CLOSE_CANCELLED = "cancelled"
CLOSE_UNAVAILABLE = "unavailable"
CLOSE_TIMED_OUT = "timed-out"
CLOSE_FLUSH_TIMEOUT_SECONDS = 15.0


def _normalize_close_disposition(result: object) -> str:
    """Return a recognized frontend close result, failing closed otherwise."""
    if isinstance(result, str) and result in {
        CLOSE_SAVED,
        CLOSE_SAVE_FAILED,
        CLOSE_CANCELLED,
    }:
        return result
    return CLOSE_UNAVAILABLE


def _requires_close_without_save_confirmation(disposition: str) -> bool:
    """Only a successful save or an already-cancelled dialog skips the prompt."""
    return disposition not in {CLOSE_SAVED, CLOSE_CANCELLED}


def _confirm_close_without_saving(disposition: str, window: object | None = None) -> bool:
    """Require an intentional native acknowledgement before discarding edits."""
    detail = {
        CLOSE_SAVE_FAILED: "ScriptSurgeon could not save the most recent edit.",
        CLOSE_TIMED_OUT: (
            "ScriptSurgeon could not confirm the final save within "
            f"{int(CLOSE_FLUSH_TIMEOUT_SECONDS)} seconds."
        ),
        CLOSE_UNAVAILABLE: "ScriptSurgeon could not verify the final save.",
    }.get(disposition, "ScriptSurgeon could not complete the final save.")
    message = (
        f"{detail}\n\n"
        "The last saved project version and the original audio are unchanged.\n\n"
        "Close without saving?\n\n"
        "OK: Close without saving the unsaved edits.\n"
        "Cancel: Continue editing."
    )
    if sys.platform != "win32":
        if sys.platform == "darwin" and window is not None:
            try:
                confirm = getattr(window, "create_confirmation_dialog", None)
                if callable(confirm):
                    return bool(confirm(APP_NAME, message))
            except Exception:
                logging.exception("Could not show the macOS close-without-saving confirmation")
        logging.warning("Refusing an unconfirmed native close on this platform")
        return False
    try:
        # Make the safe option the default: Enter/Escape continue editing.
        message_box_flags = 0x00000001 | 0x00000030 | 0x00000100  # OK/Cancel, warning, default Cancel
        return ctypes.windll.user32.MessageBoxW(None, message, APP_NAME, message_box_flags) == 1
    except Exception:
        logging.exception("Could not show the close-without-saving confirmation")
        return False


def _is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def _resource_root() -> Path:
    if _is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)).resolve()
    return Path(__file__).resolve().parent


def _install_root() -> Path:
    if _is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


RESOURCE_ROOT = _resource_root()
INSTALL_ROOT = _install_root()


def _is_windows_program_files_install(path: Path) -> bool:
    """Return whether a Windows installation resides below a Program Files root."""
    if sys.platform != "win32":
        return False
    try:
        resolved_path = path.resolve()
    except OSError:
        resolved_path = path.absolute()
    for variable in ("ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"):
        root = os.environ.get(variable)
        if not root:
            continue
        try:
            resolved_root = Path(root).expanduser().resolve()
            resolved_path.relative_to(resolved_root)
        except (OSError, ValueError):
            continue
        return True
    return False


def _default_data_dir() -> Path:
    """Choose a writable data location without relocating existing D: installs."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    # A normal Windows installer targets Program Files, which is not writable
    # by standard users. Keep manual/D: installs compatible while giving those
    # installed copies an account-local, writable project location.
    if _is_windows_program_files_install(INSTALL_ROOT):
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return Path(local_app_data).expanduser() / APP_NAME
    return INSTALL_ROOT / "Data"


DATA_DIR = Path(
    os.environ.get("SCRIPTCUT_DATA_DIR", str(_default_data_dir()))
).expanduser().resolve()
LOG_DIR = DATA_DIR / "logs"


class SingleInstance:
    """A per-user lock protecting the shared project data directory."""

    def __init__(self) -> None:
        self.handle = None
        self._posix_lock = None
        if sys.platform == "win32":
            kernel32 = ctypes.windll.kernel32
            kernel32.CreateMutexW.argtypes = (ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p)
            kernel32.CreateMutexW.restype = ctypes.c_void_p
            kernel32.SetLastError(0)
            handle = kernel32.CreateMutexW(None, False, "Local\\ScriptCutDesktop")
            if not handle:
                raise OSError(ctypes.get_last_error(), "Could not create the ScriptSurgeon instance lock")
            if kernel32.GetLastError() == ALREADY_EXISTS:
                kernel32.CloseHandle(handle)
                raise RuntimeError("ScriptSurgeon is already open.")
            self.handle = handle
            return
        if sys.platform != "darwin":
            return
        try:
            import fcntl

            lock_path = DATA_DIR / ".desktop.lock"
            lock_file = lock_path.open("a+", encoding="utf-8")
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                lock_file.close()
                raise RuntimeError("ScriptSurgeon is already open.") from None
            lock_file.seek(0)
            lock_file.truncate()
            lock_file.write(str(os.getpid()))
            lock_file.flush()
            self._posix_lock = lock_file
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError("Could not create the ScriptSurgeon instance lock") from exc

    def close(self) -> None:
        if self.handle and sys.platform == "win32":
            ctypes.windll.kernel32.CloseHandle(self.handle)
            self.handle = None
        if self._posix_lock is not None:
            try:
                import fcntl

                fcntl.flock(self._posix_lock.fileno(), fcntl.LOCK_UN)
            except Exception:
                logging.exception("Could not release the ScriptSurgeon instance lock")
            finally:
                self._posix_lock.close()
                self._posix_lock = None


def _configure_environment() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    model_cache = DATA_DIR / "models-cache"
    os.environ["SCRIPTCUT_DATA_DIR"] = str(DATA_DIR)
    os.environ["SCRIPTCUT_RESOURCE_DIR"] = str(RESOURCE_ROOT)
    os.environ["SCRIPTCUT_DESKTOP"] = "1"
    os.environ["SCRIPTCUT_MODEL_CACHE"] = str(model_cache)
    os.environ["SCRIPTCUT_SESSION_TOKEN"] = secrets.token_urlsafe(32)
    os.environ.setdefault("HF_HOME", str(model_cache))
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    model_path = RESOURCE_ROOT / "models" / "faster-whisper-base"
    if model_path.is_dir():
        os.environ.setdefault("SCRIPTCUT_MODEL_PATH", str(model_path))

    ffmpeg_name = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
    ffmpeg_path = RESOURCE_ROOT / "bin" / ffmpeg_name
    if ffmpeg_path.is_file():
        os.environ.setdefault("SCRIPTCUT_FFMPEG", str(ffmpeg_path))
        os.environ["PATH"] = (
            str(ffmpeg_path.parent) + os.pathsep + os.environ.get("PATH", "")
        )

def _configure_logging() -> None:
    log_path = LOG_DIR / "scriptcut.log"
    handler = RotatingFileHandler(
        log_path,
        maxBytes=2 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    )
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()
    root.addHandler(handler)


def _show_error(message: str) -> None:
    logging.error(message)
    if sys.platform == "win32":
        try:
            ctypes.windll.user32.MessageBoxW(None, message, APP_NAME, 0x10)
            return
        except Exception:
            logging.exception("Could not show the Windows error dialog")
    elif sys.platform == "darwin":
        try:
            from AppKit import NSAlert, NSAlertStyleCritical, NSApplication

            NSApplication.sharedApplication()
            alert = NSAlert.alloc().init()
            alert.setMessageText_(APP_NAME)
            alert.setInformativeText_(message)
            alert.setAlertStyle_(NSAlertStyleCritical)
            alert.addButtonWithTitle_("OK")
            alert.runModal()
            return
        except Exception:
            logging.exception("Could not show the macOS error dialog")


class LocalServer:
    """Own a pre-bound loopback socket and a Uvicorn server thread."""

    def __init__(self, app: object) -> None:
        import uvicorn

        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._socket.bind((LOOPBACK, 0))
        self._socket.listen(2048)
        self.port = int(self._socket.getsockname()[1])
        self.url = f"http://{LOOPBACK}:{self.port}"
        self._server = uvicorn.Server(
            uvicorn.Config(
                app,
                host=LOOPBACK,
                port=self.port,
                loop="asyncio",
                http="h11",
                ws="none",
                lifespan="on",
                log_config=None,
                access_log=False,
            )
        )
        self._thread = threading.Thread(
            target=self._run,
            name="scriptcut-local-server",
            daemon=True,
        )
        self._stop_lock = threading.Lock()
        self._stopped = False

    def _run(self) -> None:
        try:
            self._server.run(sockets=[self._socket])
        except Exception:
            logging.exception("The local server stopped unexpectedly")

    def start(self, timeout: float = 20.0) -> None:
        self._thread.start()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._server.started:
                logging.info("Local server listening at %s", self.url)
                return
            if not self._thread.is_alive():
                raise RuntimeError("The local server exited during startup")
            time.sleep(0.05)
        raise TimeoutError("Timed out while starting the local server")

    def request_stop(self, *_args: object) -> None:
        self._server.should_exit = True

    def stop(self) -> None:
        with self._stop_lock:
            if self._stopped:
                return
            self._stopped = True
            self._server.should_exit = True

        if self._thread.is_alive() and threading.current_thread() is not self._thread:
            self._thread.join(timeout=8.0)
            if self._thread.is_alive():
                logging.warning("Forcing the local server to exit")
                self._server.force_exit = True
                self._thread.join(timeout=2.0)

        try:
            self._socket.close()
        except OSError:
            pass


def _edge_from_registry() -> Path | None:
    if sys.platform != "win32":
        return None
    try:
        import winreg

        key_path = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(hive, key_path) as key:
                    value, _ = winreg.QueryValueEx(key, None)
                    candidate = Path(value)
                    if candidate.is_file():
                        return candidate
            except OSError:
                continue
    except Exception:
        logging.exception("Could not inspect the Microsoft Edge registry entry")
    return None


def _find_edge() -> Path | None:
    registered = _edge_from_registry()
    if registered:
        return registered

    on_path = shutil.which("msedge")
    if on_path:
        return Path(on_path)

    candidates = []
    for variable in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
        base = os.environ.get(variable)
        if base:
            candidates.append(Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
    return next((path for path in candidates if path.is_file()), None)


def _run_edge_fallback(url: str) -> bool:
    edge = _find_edge()
    if not edge:
        logging.error("Microsoft Edge was not found for the fallback window")
        return False

    profile = DATA_DIR / "EdgeFallbackProfile"
    profile.mkdir(parents=True, exist_ok=True)
    command = [
        str(edge),
        f"--app={url}",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--disable-background-mode",
    ]
    logging.info("Starting Microsoft Edge app-mode fallback")
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    process = subprocess.Popen(command, creationflags=creationflags)
    process.wait()
    return True


def _permission_origin(uri: object) -> tuple[str, str, int | None, str]:
    """Return a parsed origin and a query-free value that is safe to log."""
    try:
        parsed = urlsplit(str(uri))
        scheme = parsed.scheme.lower()
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except (TypeError, ValueError):
        return "", "", None, "<invalid origin>"

    if not scheme or not host:
        return scheme, host, port, "<invalid origin>"
    origin = f"{scheme}://{host}"
    if port is not None:
        origin += f":{port}"
    return scheme, host, port, origin


def _is_scriptcut_microphone_request(
    uri: object,
    server_port: int,
    user_initiated: bool | None,
) -> bool:
    """Allow only a user-initiated request from this launch's exact origin."""
    scheme, host, port, _origin = _permission_origin(uri)
    exact_origin = scheme == "http" and host == LOOPBACK and port == server_port
    return exact_origin and user_initiated is not False


def _read_dotnet_property(instance: object, name: str) -> object:
    """Read a Python.NET property across both property and get_* projections."""
    try:
        return getattr(instance, name)
    except AttributeError:
        getter = getattr(instance, f"get_{name}")
        return getter()


def _set_dotnet_property(instance: object, name: str, value: object) -> None:
    """Set a Python.NET property across both property and set_* projections."""
    try:
        setattr(instance, name, value)
    except AttributeError:
        setter = getattr(instance, f"set_{name}")
        setter(value)


def _install_webview2_microphone_guard(window: object, server_port: int) -> None:
    """Bind a retained WebView2 permission handler after the page has loaded."""
    binding: dict[str, object | None] = {"core": None, "handler": None}

    def attach_on_ui_thread() -> None:
        native = getattr(window, "native", None)
        browser = getattr(native, "browser", None)
        webview_control = getattr(browser, "webview", None)
        core = getattr(webview_control, "CoreWebView2", None)
        if core is None:
            raise RuntimeError("The WebView2 core is not initialized")
        attached_core = binding["core"]
        if attached_core is core:
            return
        if attached_core is not None:
            try:
                # Python.NET may return a fresh wrapper for the same managed
                # CoreWebView2 object after a navigation.
                if attached_core == core:
                    return
            except Exception:
                pass

        from Microsoft.Web.WebView2.Core import (  # type: ignore[import-not-found]
            CoreWebView2PermissionKind,
            CoreWebView2PermissionState,
        )

        def on_permission_requested(_sender: object, args: object) -> None:
            permission_kind = None
            try:
                permission_kind = _read_dotnet_property(args, "PermissionKind")
                if permission_kind != CoreWebView2PermissionKind.Microphone:
                    # Camera, location, notifications, and every other permission
                    # retain WebView2's default behavior.
                    return

                uri = _read_dotnet_property(args, "Uri")
                try:
                    initiated_value = _read_dotnet_property(args, "IsUserInitiated")
                    user_initiated: bool | None = bool(initiated_value)
                except AttributeError:
                    # Older WebView2 SDK projections did not expose this value.
                    user_initiated = None

                allowed = _is_scriptcut_microphone_request(
                    uri,
                    server_port,
                    user_initiated,
                )
                state = (
                    CoreWebView2PermissionState.Allow
                    if allowed
                    else CoreWebView2PermissionState.Deny
                )
                _set_dotnet_property(args, "State", state)
                try:
                    # The launch uses an ephemeral port, so retaining decisions in
                    # the WebView profile would only accumulate stale origins.
                    _set_dotnet_property(args, "SavesInProfile", False)
                except AttributeError:
                    pass

                _scheme, _host, _port, origin = _permission_origin(uri)
                initiated_label = (
                    "unknown" if user_initiated is None else str(user_initiated).lower()
                )
                if allowed:
                    logging.info(
                        "Allowed WebView2 microphone permission for %s "
                        "(user initiated: %s)",
                        origin,
                        initiated_label,
                    )
                else:
                    reason = (
                        "not user-initiated"
                        if user_initiated is False
                        else "origin mismatch"
                    )
                    logging.warning(
                        "Denied WebView2 microphone permission for %s (%s)",
                        origin,
                        reason,
                    )
            except Exception:
                # Once the request is known to be for the microphone, fail closed.
                if permission_kind == CoreWebView2PermissionKind.Microphone:
                    try:
                        _set_dotnet_property(
                            args,
                            "State",
                            CoreWebView2PermissionState.Deny,
                        )
                    except Exception:
                        logging.exception(
                            "Could not deny a malformed WebView2 microphone request"
                        )
                        return
                logging.exception("Could not evaluate a WebView2 permission request")

        core.PermissionRequested += on_permission_requested
        binding["core"] = core
        binding["handler"] = on_permission_requested
        logging.info(
            "WebView2 microphone permission guard active for http://%s:%d",
            LOOPBACK,
            server_port,
        )

    def on_loaded() -> None:
        try:
            native = getattr(window, "native", None)
            if native is None:
                raise RuntimeError("The native WebView2 window is unavailable")
            if bool(getattr(native, "InvokeRequired", False)):
                from System import Action  # type: ignore[import-not-found]

                native.Invoke(Action(attach_on_ui_thread))
            else:
                attach_on_ui_thread()
        except Exception:
            logging.exception("Could not install the WebView2 microphone permission guard")

    window.events.loaded += on_loaded
    # Python.NET event subscriptions require the callable to remain strongly
    # referenced for the lifetime of the native control.
    window._scriptcut_microphone_guard = binding, on_loaded


def _run_native_window(server: LocalServer, ui_url: str) -> bool:
    try:
        import webview
    except Exception:
        logging.exception("pywebview could not be imported")
        return False

    try:
        webview.settings["ALLOW_DOWNLOADS"] = True
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
        window = webview.create_window(
            APP_NAME,
            ui_url,
            width=1440,
            height=900,
            min_size=(1000, 700),
            resizable=True,
            background_color="#202325",
        )

        native_gui = (
            "edgechromium"
            if sys.platform == "win32"
            else "cocoa"
            if sys.platform == "darwin"
            else None
        )
        profile_name = "WebView2Profile" if sys.platform == "win32" else "WebKitProfile"
        icon_name = "scriptcut.ico" if sys.platform == "win32" else "scriptcut.icns"

        close_lock = threading.Lock()
        close_state = {"allowed": False, "started": False}

        def flush_then_close() -> None:
            completed = threading.Event()
            close_result = {"disposition": CLOSE_UNAVAILABLE}
            can_close = False

            def after_flush(result: object) -> None:
                close_result["disposition"] = _normalize_close_disposition(result)
                completed.set()

            try:
                window.evaluate_js(
                    "window.__scriptcutFlushForClose "
                    "? window.__scriptcutFlushForClose() "
                    ": Promise.resolve('unavailable')",
                    callback=after_flush,
                )
            except Exception:
                logging.exception("Could not request the final frontend save before close")
                disposition = CLOSE_UNAVAILABLE
            else:
                if completed.wait(CLOSE_FLUSH_TIMEOUT_SECONDS):
                    disposition = close_result["disposition"]
                else:
                    disposition = CLOSE_TIMED_OUT
                    logging.warning(
                        "Timed out waiting %.0f seconds for the final frontend save before close",
                        CLOSE_FLUSH_TIMEOUT_SECONDS,
                    )

            if disposition == CLOSE_SAVED:
                can_close = True
            elif disposition == CLOSE_CANCELLED:
                # The recording dialog already received an explicit "continue
                # editing" decision. Do not stack a second native prompt.
                logging.info("The frontend cancelled the native close request")
            elif _requires_close_without_save_confirmation(disposition):
                if _confirm_close_without_saving(disposition, window):
                    can_close = True
                    logging.warning(
                        "User explicitly chose to close without a confirmed final save (%s)",
                        disposition,
                    )
                else:
                    logging.info("User chose to continue editing after final-save problem (%s)", disposition)

            if not can_close:
                with close_lock:
                    close_state["started"] = False
                return

            with close_lock:
                close_state["allowed"] = True
            try:
                window.destroy()
            except Exception:
                with close_lock:
                    close_state["allowed"] = False
                    close_state["started"] = False
                logging.exception("Could not finish closing the native window")

        def on_closing() -> bool:
            with close_lock:
                if close_state["allowed"]:
                    return True
                if not close_state["started"]:
                    close_state["started"] = True
                    threading.Thread(
                        target=flush_then_close,
                        name="ScriptCut-final-save",
                        daemon=True,
                    ).start()
            # pywebview cancels a close when a synchronous closing listener
            # returns False. The worker closes it again after save/timeout.
            return False

        window.events.closing += on_closing
        window.events.closed += server.request_stop
        if sys.platform == "win32":
            _install_webview2_microphone_guard(window, server.port)

        icon_path = RESOURCE_ROOT / "assets" / icon_name
        start_options: dict[str, object] = {
            "debug": False,
            "private_mode": False,
            "storage_path": str(DATA_DIR / profile_name),
            "icon": str(icon_path) if icon_path.is_file() else None,
        }
        if native_gui is not None:
            start_options["gui"] = native_gui
        webview.start(**start_options)
        return True
    except Exception:
        logging.exception("The native desktop window could not be started")
        return False


def _run_packaged_smoke(server: LocalServer, ui_url: str) -> None:
    """Exercise bundled model/media dependencies without opening a window."""
    smoke_dir = DATA_DIR / ".runtime-smoke"
    shutil.rmtree(smoke_dir, ignore_errors=True)
    smoke_dir.mkdir(parents=True)
    try:
        with urlopen(f"{server.url}/api/health", timeout=10) as response:
            health = json.loads(response.read().decode("utf-8"))
        if not health.get("ok"):
            raise RuntimeError("The packaged health endpoint did not report ready")
        with urlopen(ui_url, timeout=10) as response:
            if b'id="root"' not in response.read():
                raise RuntimeError("The packaged frontend was not served")

        source = smoke_dir / "tone.wav"
        rate = 16_000
        with wave.open(str(source), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            frames = bytearray()
            for index in range(rate):
                sample = round(9_000 * math.sin(2 * math.pi * 220 * index / rate))
                frames.extend(int(sample).to_bytes(2, "little", signed=True))
            output.writeframes(frames)

        from backend.render import render_edited, wav_duration
        from backend.transcribe import transcribe_words

        rendered = render_edited(str(source), [], [], True, str(smoke_dir))
        duration = wav_duration(rendered)
        if duration is None or not 0.9 <= duration <= 1.1:
            raise RuntimeError(f"Bundled FFmpeg render duration was invalid: {duration}")
        words, transcribed_duration, _ = transcribe_words(str(source))
        logging.info(
            "Packaged smoke passed (render=%.3fs, transcription=%.3fs, words=%d)",
            duration,
            transcribed_duration,
            len(words),
        )
    finally:
        shutil.rmtree(smoke_dir, ignore_errors=True)


def main() -> int:
    instance = None
    try:
        _configure_environment()
        _configure_logging()
        instance = SingleInstance()

        from backend.main import app

        server = LocalServer(app)
        ui_url = server.url + "/?" + urlencode(
            {"token": os.environ["SCRIPTCUT_SESSION_TOKEN"]}
        )
        atexit.register(server.stop)
        try:
            server.start()
            if "--smoke-test" in sys.argv:
                _run_packaged_smoke(server, ui_url)
                return 0
            if not _run_native_window(server, ui_url):
                if sys.platform == "win32" and _run_edge_fallback(ui_url):
                    return 0
                else:
                    raise RuntimeError(
                        "ScriptSurgeon could not open its desktop window. "
                        f"Details were written to {LOG_DIR / 'scriptcut.log'}."
                    )
            return 0
        finally:
            server.stop()
            atexit.unregister(server.stop)
    except Exception as exc:
        logging.exception("ScriptSurgeon failed to start")
        _show_error(
            "ScriptSurgeon could not start.\n\n"
            f"{exc}\n\n"
            f"Log: {LOG_DIR / 'scriptcut.log'}"
        )
        return 1
    finally:
        if instance is not None:
            instance.close()


if __name__ == "__main__":
    raise SystemExit(main())
