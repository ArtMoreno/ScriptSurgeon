import io
import shutil
import tempfile
import threading
import unittest
import wave
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import main


def tiny_wav() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16_000)
        handle.writeframes(b"\0\0" * 1_600)
    return output.getvalue()


class ProjectCreationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original_root = main.PROJECTS_DIR
        main.PROJECTS_DIR = Path(self.temp.name) / "projects"
        main.PROJECTS_DIR.mkdir()
        self.saved_statuses = dict(main.statuses)
        self.saved_queued_ids = set(main.queued_ids)
        self.saved_cancel_events = dict(main.cancel_events)
        self.saved_project_locks = dict(main.project_locks)
        self.saved_creating_ids = set(main.creating_project_ids)
        main.statuses.clear()
        main.queued_ids.clear()
        main.cancel_events.clear()
        main.project_locks.clear()
        main.creating_project_ids.clear()
        self.environment = patch.dict(main.os.environ, {"SCRIPTCUT_SESSION_TOKEN": ""})
        self.environment.start()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        self.environment.stop()
        main.statuses.clear()
        main.statuses.update(self.saved_statuses)
        main.queued_ids.clear()
        main.queued_ids.update(self.saved_queued_ids)
        main.cancel_events.clear()
        main.cancel_events.update(self.saved_cancel_events)
        main.project_locks.clear()
        main.project_locks.update(self.saved_project_locks)
        main.creating_project_ids.clear()
        main.creating_project_ids.update(self.saved_creating_ids)
        main.PROJECTS_DIR = self.original_root
        self.temp.cleanup()

    def project_directories(self) -> list[Path]:
        return [
            item for item in main.PROJECTS_DIR.iterdir()
            if main.PROJECT_ID_RE.fullmatch(item.name)
        ]

    def test_named_webm_is_published_as_the_immutable_original(self):
        enqueued: list[tuple[str, Path]] = []
        with patch.object(main, "validate_media", return_value=(1.25, 48_000, 1)):
            with patch.object(main, "enqueue_transcription", side_effect=lambda pid, path: enqueued.append((pid, path))):
                response = self.client.post(
                    "/api/projects",
                    data={"name": "  Field notes  "},
                    files={"file": ("capture.webm", b"validated-webm", "audio/webm;codecs=opus")},
                )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["name"], "Field notes")
        self.assertRegex(payload["id"], r"^[0-9a-f]{12}$")
        project = main.PROJECTS_DIR / payload["id"]
        original = project / "original.webm"
        self.assertEqual(original.read_bytes(), b"validated-webm")
        self.assertEqual(enqueued, [(payload["id"], original)])
        metadata = main.read_json(main.meta_path(project))
        self.assertEqual(metadata["name"], "Field notes")
        self.assertEqual(metadata["channels"], 1)
        self.assertEqual(main.read_json(main.status_path(project))["status"], "queued")
        self.assertEqual(list(main.creation_root().iterdir()), [])

    def test_allowlisted_mime_replaces_an_untrusted_suffix_and_filename_fallback_remains(self):
        with patch.object(main, "validate_media", return_value=(0.5, 48_000, 1)):
            with patch.object(main, "enqueue_transcription"):
                mime_response = self.client.post(
                    "/api/projects",
                    data={"name": "MIME source"},
                    files={"file": ("capture.bin", b"validated-webm", "audio/webm")},
                )
                fallback_response = self.client.post(
                    "/api/projects",
                    files={"file": ("meeting.wav", tiny_wav(), "application/octet-stream")},
                )

        self.assertEqual(mime_response.status_code, 200, mime_response.text)
        mime_project = main.PROJECTS_DIR / mime_response.json()["id"]
        self.assertTrue((mime_project / "original.webm").is_file())
        self.assertFalse((mime_project / "original.bin").exists())
        self.assertEqual(fallback_response.status_code, 200, fallback_response.text)
        self.assertEqual(fallback_response.json()["name"], "meeting")

    def test_empty_invalid_names_zero_bytes_and_unsupported_media_leave_no_project(self):
        invalid_requests = (
            ({"name": "   "}, ("take.wav", tiny_wav(), "audio/wav"), "must not be empty"),
            ({"name": "bad\nname"}, ("take.wav", tiny_wav(), "audio/wav"), "control characters"),
            ({"name": "x" * 161}, ("take.wav", tiny_wav(), "audio/wav"), "160 characters"),
            ({"name": "Bad type"}, ("take.exe", b"payload", "application/octet-stream"), "unsupported file type"),
        )
        with patch.object(main, "validate_media") as validate:
            for data, media, detail in invalid_requests:
                with self.subTest(detail=detail):
                    response = self.client.post("/api/projects", data=data, files={"file": media})
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertIn(detail, response.text)
            empty = self.client.post(
                "/api/projects",
                data={"name": "Empty source"},
                files={"file": ("empty.wav", b"", "audio/wav")},
            )

        self.assertEqual(empty.status_code, 400, empty.text)
        self.assertIn("media file is empty", empty.text)
        validate.assert_not_called()
        self.assertEqual(self.project_directories(), [])
        self.assertEqual(list(main.creation_root().iterdir()), [])
        self.assertEqual(main.creating_project_ids, set())

    def test_project_is_invisible_until_validation_and_atomic_publish_complete(self):
        entered = threading.Event()
        release = threading.Event()

        def validate(path: Path):
            self.assertEqual(path.parent.parent.name, ".creating")
            entered.set()
            if not release.wait(5):
                raise RuntimeError("test validation wait timed out")
            return 0.5, 48_000, 1

        with patch.object(main, "validate_media", side_effect=validate):
            with patch.object(main, "enqueue_transcription"):
                with ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(
                        self.client.post,
                        "/api/projects",
                        data={"name": "Atomic source"},
                        files={"file": ("take.wav", tiny_wav(), "audio/wav")},
                    )
                    self.assertTrue(entered.wait(5), "upload never reached validation")
                    self.assertEqual(main.list_projects(), [])
                    self.assertEqual(len(list(main.creation_root().iterdir())), 1)
                    release.set()
                    response = future.result(timeout=5)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([item["id"] for item in main.list_projects()], [response.json()["id"]])
        self.assertEqual(list(main.creation_root().iterdir()), [])

    def test_validation_failure_and_all_abandoned_crash_stages_are_cleaned_safely(self):
        with patch.object(main, "validate_media", side_effect=ValueError("not decodable")):
            response = self.client.post(
                "/api/projects",
                data={"name": "Broken source"},
                files={"file": ("take.wav", b"broken", "audio/wav")},
            )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(self.project_directories(), [])
        self.assertEqual(list(main.creation_root().iterdir()), [])

        root = main.creation_root()
        old = root / ("a" * 32)
        recent = root / ("b" * 32)
        unrelated = root / "keep-me"
        for directory in (old, recent, unrelated):
            directory.mkdir()

        main.cleanup_creation_stages()

        self.assertFalse(old.exists())
        self.assertFalse(recent.exists())
        self.assertTrue(unrelated.is_dir())

    def test_list_skips_a_project_deleted_after_it_was_sorted(self):
        project = main.PROJECTS_DIR / "0123456789ab"
        project.mkdir()
        main.atomic_json(main.meta_path(project), {"id": project.name, "name": "Racing"})
        real_read_json = main.read_json

        def disappear(path: Path):
            if path == main.meta_path(project):
                shutil.rmtree(project)
                raise FileNotFoundError(path)
            return real_read_json(path)

        with patch.object(main, "read_json", side_effect=disappear):
            self.assertEqual(main.list_projects(), [])

    def test_startup_reconciles_a_committed_state_with_stale_status(self):
        pid = "0123456789ab"
        project = main.PROJECTS_DIR / pid
        project.mkdir()
        main.atomic_json(main.meta_path(project), {
            "id": pid,
            "name": "Recovered",
            "duration": 0.1,
            "sampleRate": 16_000,
        })
        (project / "original.wav").write_bytes(tiny_wav())
        main.atomic_json(main.state_path(project), {
            "words": [],
            "shortenedGapIds": [],
            "studioSound": False,
            "collapsedRetakes": [],
            "cleanupKeepWordIds": [],
            "cleanupKeepGapIds": [],
            "insertClips": [],
            "revision": 1,
        })
        stale = {
            "status": "transcribing",
            "stage": "transcribing",
            "message": "Transcribing on this computer",
            "progress": 0.75,
            "error": None,
        }
        main.atomic_json(main.status_path(project), stale)
        main.statuses[pid] = dict(stale)

        with patch.object(main, "enqueue_transcription") as enqueue:
            main.resume_incomplete_projects()

        enqueue.assert_not_called()
        self.assertEqual(main.get_status(pid)["status"], "ready")
        persisted = main.read_json(main.status_path(project))
        self.assertEqual(persisted["status"], "ready")
        self.assertEqual(persisted["progress"], 1.0)
        self.assertIsNone(persisted["error"])

    def test_startup_skips_project_entries_that_fail_strict_path_resolution(self):
        project = main.PROJECTS_DIR / "0123456789ab"
        project.mkdir()

        with patch.object(
            main,
            "_project_path",
            side_effect=main.HTTPException(404, "project not found"),
        ), patch.object(main, "enqueue_transcription") as enqueue:
            main.resume_incomplete_projects()

        enqueue.assert_not_called()

    def test_invalid_transcription_output_never_publishes_partial_project_state(self):
        pid = "0123456789ab"
        project, _ = self.create_terminal_project(pid, "error")
        invalid_word = {
            "id": "0000000001",
            "text": "outside",
            "startTime": 0.05,
            "endTime": 0.2,
            "isFiller": False,
            "isRetake": False,
            "isRemoved": False,
            "gapAfter": 0.0,
        }
        main.queued_ids.add(pid)
        main.cancel_events[pid] = threading.Event()

        with patch(
            "backend.transcribe.transcribe_words",
            return_value=([invalid_word], 0.1, 16_000),
        ):
            main.run_transcription(pid, str(project / "original.wav"))

        self.assertFalse(main.state_path(project).exists())
        self.assertEqual(main.read_json(main.meta_path(project))["duration"], 0.1)
        status = main.get_status(pid)
        self.assertEqual(status["status"], "error")
        self.assertIn("invalid word timing", status["error"])
        self.assertNotIn(pid, main.queued_ids)
        self.assertNotIn(pid, main.cancel_events)

    def create_terminal_project(self, pid: str, status: str) -> tuple[Path, bytes]:
        project = main.PROJECTS_DIR / pid
        project.mkdir()
        source = tiny_wav()
        (project / "original.wav").write_bytes(source)
        main.atomic_json(main.meta_path(project), {
            "id": pid,
            "name": f"{status.title()} recording",
            "duration": 0.1,
            "sampleRate": 16_000,
        })
        main.atomic_json(main.status_path(project), {
            "status": status,
            "stage": status,
            "message": "Transcription stopped",
            "progress": 0.5,
            "error": "worker failed" if status == "error" else None,
        })
        return project, source

    def test_retry_is_authenticated_reuses_original_and_never_duplicates_active_work(self):
        pid = "0123456789ab"
        project, source = self.create_terminal_project(pid, "error")
        token = "retry-test-token"
        headers = {"X-ScriptCut-Token": token}
        with patch.object(main.job_queue, "put") as put:
            with patch.dict(main.os.environ, {"SCRIPTCUT_SESSION_TOKEN": token}):
                denied = self.client.post(f"/api/projects/{pid}/transcription/retry")
                accepted = self.client.post(
                    f"/api/projects/{pid}/transcription/retry",
                    headers=headers,
                )
                duplicate = self.client.post(
                    f"/api/projects/{pid}/transcription/retry",
                    headers=headers,
                )

        self.assertEqual(denied.status_code, 403)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(accepted.json(), {"ok": True, "status": "queued"})
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual((project / "original.wav").read_bytes(), source)
        self.assertFalse(main.state_path(project).exists())
        self.assertEqual(main.read_json(main.status_path(project))["status"], "queued")
        put.assert_called_once_with((pid, str(project / "original.wav")))

    def test_retry_accepts_cancelled_but_rejects_ready_or_still_finishing_projects(self):
        cancelled_id = "111111111111"
        cancelled, _ = self.create_terminal_project(cancelled_id, "cancelled")
        ready_id = "222222222222"
        ready, _ = self.create_terminal_project(ready_id, "error")
        main.atomic_json(main.state_path(ready), {
            "words": [],
            "shortenedGapIds": [],
            "studioSound": False,
            "collapsedRetakes": [],
            "cleanupKeepWordIds": [],
            "cleanupKeepGapIds": [],
            "insertClips": [],
            "revision": 1,
        })
        finishing_id = "333333333333"
        self.create_terminal_project(finishing_id, "error")
        main.queued_ids.add(finishing_id)

        with patch.object(main.job_queue, "put") as put:
            cancelled_response = self.client.post(f"/api/projects/{cancelled_id}/transcription/retry")
            ready_response = self.client.post(f"/api/projects/{ready_id}/transcription/retry")
            finishing_response = self.client.post(f"/api/projects/{finishing_id}/transcription/retry")

        self.assertEqual(cancelled_response.status_code, 200, cancelled_response.text)
        self.assertEqual(ready_response.status_code, 409)
        self.assertIn("already complete", ready_response.text)
        self.assertEqual(finishing_response.status_code, 409)
        self.assertIn("still finishing", finishing_response.text)
        put.assert_called_once_with((cancelled_id, str(cancelled / "original.wav")))


class MediaValidationTests(unittest.TestCase):
    class FakeContainer:
        def __init__(self, frames):
            self.frames = frames
            self.duration = None
            self.stream = SimpleNamespace(
                type="audio",
                duration=None,
                time_base=None,
                codec_context=SimpleNamespace(sample_rate=48_000, channels=2),
            )
            self.streams = [self.stream]

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def decode(self, stream):
            if stream is not self.stream:
                raise AssertionError("unexpected stream")
            yield from self.frames

    @staticmethod
    def frame(samples: int, pts: int = 0):
        return SimpleNamespace(
            samples=samples,
            sample_rate=48_000,
            pts=pts,
            time_base=Fraction(1, 48_000),
        )

    def test_metadata_less_audio_is_timed_from_decoded_frames(self):
        frames = [self.frame(12_000, 0), self.frame(12_000, 12_000)]
        with patch("av.open", return_value=self.FakeContainer(frames)):
            duration, sample_rate, channels = main.validate_media(Path("metadata-less.webm"))
        self.assertAlmostEqual(duration, 0.5)
        self.assertEqual(sample_rate, 48_000)
        self.assertEqual(channels, 2)

    def test_metadata_less_audio_stops_at_limit_and_zero_decoded_audio_is_rejected(self):
        frames = [self.frame(36_000, 0), self.frame(36_000, 36_000)]
        with patch.object(main, "MAX_AUDIO_SECONDS", 1.0):
            with patch("av.open", return_value=self.FakeContainer(frames)):
                with self.assertRaisesRegex(ValueError, "longer than"):
                    main.validate_media(Path("too-long.webm"))
        with patch("av.open", return_value=self.FakeContainer([])):
            with self.assertRaisesRegex(ValueError, "no decodable audio"):
                main.validate_media(Path("empty.wav"))


if __name__ == "__main__":
    unittest.main()
