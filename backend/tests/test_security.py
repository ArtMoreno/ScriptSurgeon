import io
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend import main


def wav_bytes(duration: float = 0.2, rate: int = 16_000) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\0\0" * round(duration * rate))
    return output.getvalue()


def write_wav(path: Path, duration: float = 0.2) -> None:
    path.write_bytes(wav_bytes(duration, rate=48_000))


class BrandingTests(unittest.TestCase):
    def test_public_api_metadata_uses_scriptsurgeon_name(self):
        self.assertEqual(main.app.title, "ScriptSurgeon")
        health = main.health()
        self.assertEqual(health["ok"], True)
        self.assertEqual(health["service"], "ScriptSurgeon")
        self.assertIn("build", health)


class ProjectPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original_root = main.PROJECTS_DIR
        main.PROJECTS_DIR = Path(self.temp.name) / "projects"
        main.PROJECTS_DIR.mkdir()
        self.sentinel = Path(self.temp.name) / "sentinel.txt"
        self.sentinel.write_text("keep", encoding="utf-8")

    def tearDown(self):
        main.PROJECTS_DIR = self.original_root
        self.temp.cleanup()

    def test_dot_segments_and_malformed_ids_are_rejected(self):
        for value in (".", "..", "../", "abc", "0" * 11, "g" * 12, "0" * 13):
            with self.subTest(value=value), self.assertRaises(HTTPException):
                main.pdir(value)
        self.assertEqual(self.sentinel.read_text(encoding="utf-8"), "keep")

    def test_only_an_immediate_hex_child_is_accepted(self):
        project = main.PROJECTS_DIR / "0123456789ab"
        project.mkdir()
        self.assertEqual(main.pdir(project.name), project.resolve())

    def test_legacy_state_gets_cleanup_override_defaults_without_disk_rewrite(self):
        project = main.PROJECTS_DIR / "0123456789ab"
        project.mkdir()
        main.atomic_json(main.meta_path(project), {"id": project.name})
        main.atomic_json(main.state_path(project), {
            "words": [],
            "shortenedGapIds": [],
            "studioSound": False,
            "collapsedRetakes": [],
            "revision": 1,
        })

        _, state = main.load_project(project.name)

        self.assertEqual(state["cleanupKeepWordIds"], [])
        self.assertEqual(state["cleanupKeepGapIds"], [])
        self.assertEqual(state["insertClips"], [])
        self.assertEqual(state["gapPacing"]["targetGapMs"], 300)
        self.assertEqual(state["gapEdits"], [])
        self.assertEqual(state["markers"], [])
        persisted = main.read_json(main.state_path(project))
        self.assertNotIn("cleanupKeepWordIds", persisted)
        self.assertNotIn("cleanupKeepGapIds", persisted)
        self.assertNotIn("insertClips", persisted)
        self.assertNotIn("gapPacing", persisted)
        self.assertNotIn("gapEdits", persisted)
        self.assertNotIn("markers", persisted)

    def test_hybrid_legacy_gap_state_is_normalized_for_render_without_disk_rewrite(self):
        project = main.PROJECTS_DIR / "0123456789ab"
        project.mkdir()
        word = {
            "id": "0000000001", "text": "hello", "startTime": 0.1, "endTime": 0.4,
            "isFiller": False, "isRetake": False, "isRemoved": False, "gapAfter": 1.0,
        }
        main.atomic_json(main.meta_path(project), {"id": project.name})
        main.atomic_json(main.state_path(project), {
            "words": [word],
            "shortenedGapIds": [word["id"]],
            "gapEdits": [],
            "studioSound": False,
            "collapsedRetakes": [],
            "revision": 1,
        })

        _, state = main.load_project(project.name)

        self.assertEqual(state["gapEdits"], [{"afterWordId": word["id"], "targetGapMs": 300}])
        self.assertEqual(state["shortenedGapIds"], [word["id"]])
        persisted = main.read_json(main.state_path(project))
        self.assertEqual(persisted["gapEdits"], [])
        self.assertEqual(persisted["shortenedGapIds"], [word["id"]])

    def test_legacy_save_preserves_overrides_but_explicit_empty_lists_clear_them(self):
        project = main.PROJECTS_DIR / "0123456789ab"
        project.mkdir()
        word = {
            "id": "0000000001",
            "text": "hello",
            "startTime": 0.1,
            "endTime": 0.4,
            "isFiller": False,
            "isRetake": False,
            "isRemoved": False,
            "gapAfter": 0.2,
        }
        main.atomic_json(main.state_path(project), {
            "words": [word],
            "shortenedGapIds": [],
            "studioSound": False,
            "collapsedRetakes": [],
            "cleanupKeepWordIds": [word["id"]],
            "cleanupKeepGapIds": [word["id"]],
            "revision": 1,
        })

        main.save_state(project.name, main.StatePayload(words=[word]))
        preserved = main.read_json(main.state_path(project))
        self.assertEqual(preserved["cleanupKeepWordIds"], [word["id"]])
        self.assertEqual(preserved["cleanupKeepGapIds"], [word["id"]])

        main.save_state(project.name, main.StatePayload(
            words=[word],
            cleanupKeepWordIds=[],
            cleanupKeepGapIds=[],
        ))
        cleared = main.read_json(main.state_path(project))
        self.assertEqual(cleared["cleanupKeepWordIds"], [])
        self.assertEqual(cleared["cleanupKeepGapIds"], [])

    def test_legacy_gap_id_save_preserves_custom_target_and_marker_metadata(self):
        project = main.PROJECTS_DIR / "0123456789ab"
        project.mkdir()
        word = {
            "id": "0000000001",
            "text": "hello",
            "startTime": 0.1,
            "endTime": 0.4,
            "isFiller": False,
            "isRetake": False,
            "isRemoved": False,
            "gapAfter": 0.8,
        }
        marker = {"id": "222222222222", "title": "Intro", "kind": "chapter", "anchor": {"sourceTime": 0.1}}
        main.atomic_json(main.state_path(project), {
            "words": [word],
            "shortenedGapIds": [word["id"]],
            "gapEdits": [{"afterWordId": word["id"], "targetGapMs": 180}],
            "gapPacing": {"preset": "tight", "detectionThresholdMs": 600, "targetGapMs": 180},
            "markers": [marker],
            "studioSound": False,
            "collapsedRetakes": [],
            "revision": 1,
        })

        # A legacy frontend knows only the ID list. It must keep the existing
        # exact target and unknown marker metadata rather than flattening both.
        main.save_state(project.name, main.StatePayload(words=[word], shortenedGapIds=[word["id"]]))
        preserved = main.read_json(main.state_path(project))
        self.assertEqual(preserved["gapEdits"], [{"afterWordId": word["id"], "targetGapMs": 180}])
        self.assertEqual(preserved["gapPacing"]["preset"], "tight")
        self.assertEqual(preserved["markers"], [marker])

        main.save_state(project.name, main.StatePayload(
            words=[word],
            gapEdits=[],
            markers=[],
        ))
        cleared = main.read_json(main.state_path(project))
        self.assertEqual(cleared["shortenedGapIds"], [])
        self.assertEqual(cleared["gapEdits"], [])
        self.assertEqual(cleared["markers"], [])

    def test_legacy_save_preserves_durable_retake_choices(self):
        project = main.PROJECTS_DIR / "0123456789ab"
        project.mkdir()
        words = [
            {
                "id": "0000000001", "text": "first", "startTime": 0.1, "endTime": 0.4,
                "isFiller": False, "isRetake": True, "isRemoved": True, "gapAfter": 0.1,
            },
            {
                "id": "0000000002", "text": "second", "startTime": 0.6, "endTime": 1.0,
                "isFiller": False, "isRetake": False, "isRemoved": False, "gapAfter": 0.0,
            },
        ]
        group = {
            "id": "222222222222",
            "candidates": [["0000000001"], ["0000000002"]],
            "recommendedKeepIndex": 1,
            "selectedKeepIndex": 1,
        }
        main.atomic_json(main.state_path(project), {
            "words": words,
            "shortenedGapIds": [],
            "collapsedRetakes": [["0000000001"]],
            "retakeGroups": [group],
            "studioSound": False,
            "revision": 1,
        })

        main.save_state(project.name, main.StatePayload(words=words, collapsedRetakes=[["0000000001"]]))
        preserved = main.read_json(main.state_path(project))
        self.assertEqual(preserved["retakeGroups"], [group])

    def test_save_state_rejects_word_and_marker_times_beyond_metadata_duration(self):
        project = main.PROJECTS_DIR / "0123456789ab"
        project.mkdir()
        main.atomic_json(main.meta_path(project), {"id": project.name, "duration": 1.0})
        word = {
            "id": "0000000001",
            "text": "hello",
            "startTime": 0.1,
            "endTime": 0.4,
            "isFiller": False,
            "isRetake": False,
            "isRemoved": False,
            "gapAfter": 0.2,
        }
        marker = {
            "id": "222222222222",
            "title": "Out of range",
            "kind": "chapter",
            "anchor": {"sourceTime": 1.1},
        }

        invalid_payloads = (
            main.StatePayload(words=[{**word, "endTime": 1.1}]),
            main.StatePayload(words=[word], markers=[marker]),
            main.StatePayload(words=[word], markers=[{
                **marker,
                "anchor": {"sourceTime": 0.1},
                "end": {"sourceTime": 1.1},
            }]),
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload), self.assertRaisesRegex(HTTPException, "exceeds the source duration"):
                main.save_state(project.name, payload)

    def test_save_state_keeps_legacy_projects_without_a_finite_duration(self):
        project = main.PROJECTS_DIR / "0123456789ab"
        project.mkdir()
        main.atomic_json(main.meta_path(project), {"id": project.name, "duration": None})
        word = {
            "id": "0000000001",
            "text": "hello",
            "startTime": 0.1,
            "endTime": 2.0,
            "isFiller": False,
            "isRetake": False,
            "isRemoved": False,
            "gapAfter": 0.2,
        }

        saved = main.save_state(project.name, main.StatePayload(words=[word]))

        self.assertEqual(saved["revision"], 1)
        self.assertEqual(main.read_json(main.state_path(project))["words"][0]["endTime"], 2.0)


class RecordingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original_root = main.PROJECTS_DIR
        main.PROJECTS_DIR = Path(self.temp.name) / "projects"
        main.PROJECTS_DIR.mkdir()
        self.project = main.PROJECTS_DIR / "0123456789ab"
        self.project.mkdir()
        self.word = {
            "id": "0000000001",
            "text": "hello",
            "startTime": 0.1,
            "endTime": 0.4,
            "isFiller": False,
            "isRetake": False,
            "isRemoved": False,
            "gapAfter": 0.2,
        }
        main.atomic_json(main.meta_path(self.project), {
            "id": self.project.name,
            "name": "Recording test",
            "duration": 1.0,
            "sampleRate": 16_000,
        })
        main.atomic_json(main.state_path(self.project), {
            "words": [self.word],
            "shortenedGapIds": [],
            "studioSound": False,
            "collapsedRetakes": [],
            "cleanupKeepWordIds": [],
            "cleanupKeepGapIds": [],
            "insertClips": [],
            "revision": 1,
        })
        self.client = TestClient(main.app)

    def tearDown(self):
        main.recording_uploads.pop(self.project.name, None)
        main.PROJECTS_DIR = self.original_root
        self.temp.cleanup()

    def insert(self, clip_id: str = "aaaaaaaaaaaa", **values):
        return {
            "id": "111111111111",
            "clipId": clip_id,
            "sourceTime": 0.4,
            "duration": 0.2,
            "text": "replacement words",
            "afterWordId": self.word["id"],
            "isRemoved": False,
            **values,
        }

    def create_asset(self, clip_id: str = "aaaaaaaaaaaa", duration: float = 0.2) -> Path:
        directory = main.recordings_dir(self.project, create=True)
        path = directory / f"{clip_id}.wav"
        write_wav(path, duration)
        return path

    def test_recording_upload_canonicalizes_to_an_immutable_local_wav(self):
        response = self.client.post(
            f"/api/projects/{self.project.name}/recordings",
            files={"file": ("take.wav", wav_bytes(), "audio/wav")},
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(set(payload), {"clipId", "duration", "sampleRate", "channels"})
        self.assertRegex(payload["clipId"], r"^[0-9a-f]{12}$")
        self.assertAlmostEqual(payload["duration"], 0.2, places=2)
        self.assertEqual((payload["sampleRate"], payload["channels"]), (48_000, 1))
        path = main.recording_file(self.project, payload["clipId"])
        with wave.open(str(path), "rb") as handle:
            self.assertEqual(handle.getframerate(), 48_000)
            self.assertEqual(handle.getnchannels(), 1)
            self.assertEqual(handle.getsampwidth(), 2)
        self.assertEqual(list(path.parent.glob(".upload-*")), [])
        self.assertEqual(list(path.parent.glob(".recording-*")), [])

    def test_recording_conversion_is_dispatched_off_the_api_event_loop(self):
        calls = []

        async def dispatch(function, *args):
            calls.append((function, args))
            return function(*args)

        with patch.object(main, "run_in_threadpool", side_effect=dispatch):
            response = self.client.post(
                f"/api/projects/{self.project.name}/recordings",
                files={"file": ("take.wav", wav_bytes(), "audio/wav")},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(calls), 1)
        self.assertIs(calls[0][0], main.canonicalize_recording)

    def test_recording_upload_enforces_type_size_duration_and_storage_limits(self):
        self.assertTrue({".mp3", ".wav", ".m4a", ".mp4", ".aac", ".ogg", ".flac", ".webm"}.issubset(main.RECORDING_EXT))
        unsupported = self.client.post(
            f"/api/projects/{self.project.name}/recordings",
            files={"file": ("take.txt", b"not audio", "text/plain")},
        )
        self.assertEqual(unsupported.status_code, 400)
        self.assertIn("supported audio file", unsupported.text)

        with patch.object(main, "MAX_RECORDING_BYTES", 32):
            oversized = self.client.post(
                f"/api/projects/{self.project.name}/recordings",
                files={"file": ("take.wav", wav_bytes(), "audio/wav")},
            )
        self.assertEqual(oversized.status_code, 413)

        with patch.object(main, "MAX_RECORDING_SECONDS", 0.05):
            too_long = self.client.post(
                f"/api/projects/{self.project.name}/recordings",
                files={"file": ("take.wav", wav_bytes(), "audio/wav")},
            )
        self.assertEqual(too_long.status_code, 400)

        with patch.object(main, "MAX_RECORDING_STORAGE_BYTES", 1):
            storage_full = self.client.post(
                f"/api/projects/{self.project.name}/recordings",
                files={"file": ("take.wav", wav_bytes(), "audio/wav")},
            )
        self.assertEqual(storage_full.status_code, 413)
        self.assertEqual(list(main.recordings_dir(self.project).glob("*.wav")), [])

    def test_state_references_existing_clip_and_validates_duration_and_source_boundary(self):
        self.create_asset()
        saved = main.save_state(
            self.project.name,
            main.StatePayload(words=[self.word], insertClips=[self.insert(isRemoved=True)]),
        )
        self.assertEqual(saved["revision"], 2)
        persisted = main.read_json(main.state_path(self.project))
        self.assertTrue(persisted["insertClips"][0]["isRemoved"])

        with self.assertRaisesRegex(HTTPException, "missing"):
            main.save_state(
                self.project.name,
                main.StatePayload(words=[self.word], insertClips=[self.insert("bbbbbbbbbbbb")]),
            )
        with self.assertRaisesRegex(HTTPException, "duration does not match"):
            main.save_state(
                self.project.name,
                main.StatePayload(words=[self.word], insertClips=[self.insert(duration=0.5)]),
            )
        with self.assertRaisesRegex(HTTPException, "source time"):
            main.save_state(
                self.project.name,
                main.StatePayload(words=[self.word], insertClips=[self.insert(sourceTime=1.1)]),
            )

    def test_legacy_save_preserves_insert_but_explicit_empty_list_clears_it(self):
        self.create_asset()
        current = main.read_json(main.state_path(self.project))
        current["insertClips"] = [self.insert()]
        main.atomic_json(main.state_path(self.project), current)

        main.save_state(self.project.name, main.StatePayload(words=[self.word]))
        preserved = main.read_json(main.state_path(self.project))
        self.assertEqual(preserved["insertClips"], [self.insert()])

        main.save_state(self.project.name, main.StatePayload(words=[self.word], insertClips=[]))
        cleared = main.read_json(main.state_path(self.project))
        self.assertEqual(cleared["insertClips"], [])

    def test_recording_paths_never_accept_user_path_segments(self):
        for value in ("../aaaaaaaaaaaa", "A" * 12, "a" * 11, "a" * 13, "recording.wav"):
            with self.subTest(value=value), self.assertRaises(HTTPException):
                main.recording_file(self.project, value)

    def test_project_delete_waits_for_an_active_recording_import(self):
        main.recording_uploads[self.project.name] = 1
        response = self.client.delete(f"/api/projects/{self.project.name}")
        self.assertEqual(response.status_code, 409)
        self.assertIn("recording is still being imported", response.text)
        self.assertTrue(self.project.is_dir())

    def test_raw_audio_playback_lease_blocks_deletion_until_stream_cleanup(self):
        source = self.project / "original.wav"
        write_wav(source)

        response = main.audio(self.project.name, edited=False)
        key = str(source.resolve())
        self.assertEqual(main.render_leases.get(key), 1)
        self.assertIsNotNone(response.background)
        with self.assertRaisesRegex(HTTPException, "audio is still in use"):
            main.delete_project(self.project.name)

        response.background.func(*response.background.args, **response.background.kwargs)
        self.assertNotIn(key, main.render_leases)
        self.assertEqual(main.delete_project(self.project.name), {"ok": True})
        self.assertFalse(self.project.exists())


class StateValidationTests(unittest.TestCase):
    def word(self, identifier="0000000001"):
        return {
            "id": identifier,
            "text": "hello",
            "startTime": 0.1,
            "endTime": 0.4,
            "isFiller": False,
            "isRetake": False,
            "isRemoved": False,
            "gapAfter": 0.2,
        }

    def test_valid_state(self):
        state = main.StatePayload(words=[self.word()], shortenedGapIds=["0000000001"])
        self.assertEqual(len(state.words), 1)
        self.assertEqual(state.cleanupKeepWordIds, [])
        self.assertEqual(state.cleanupKeepGapIds, [])
        self.assertEqual(state.insertClips, [])
        self.assertEqual(state.gapPacing.targetGapMs, 300)
        self.assertEqual(state.gapEdits, [])
        self.assertEqual(state.markers, [])
        self.assertEqual(state.retakeGroups, [])

    def insert(self, **values):
        return {
            "id": "111111111111",
            "clipId": "aaaaaaaaaaaa",
            "sourceTime": 0.4,
            "duration": 0.2,
            "text": "new transcript",
            "afterWordId": "0000000001",
            "isRemoved": False,
            **values,
        }

    def test_insert_schema_is_strict_bounded_and_references_project_words(self):
        state = main.StatePayload(words=[self.word()], insertClips=[self.insert()])
        self.assertEqual(state.insertClips[0].text, "new transcript")

        invalid_values = (
            {"id": "A" * 12},
            {"clipId": "../take.wav"},
            {"text": "   "},
            {"afterWordId": "0000000002"},
            {"sourceTime": float("inf")},
            {"duration": 0},
        )
        for values in invalid_values:
            with self.subTest(values=values), self.assertRaises(ValidationError):
                main.StatePayload(words=[self.word()], insertClips=[self.insert(**values)])

        with self.assertRaises(ValidationError):
            main.StatePayload(words=[self.word()], insertClips=[self.insert(), self.insert()])
        with self.assertRaises(ValidationError):
            main.StatePayload(words=[self.word()], insertClips=[self.insert()] * (main.MAX_INSERT_CLIPS + 1))

    def test_valid_cleanup_overrides_are_persisted(self):
        state = main.StatePayload(
            words=[self.word()],
            cleanupKeepWordIds=["0000000001"],
            cleanupKeepGapIds=["0000000001"],
        )
        dumped = state.model_dump()
        self.assertEqual(dumped["cleanupKeepWordIds"], ["0000000001"])
        self.assertEqual(dumped["cleanupKeepGapIds"], ["0000000001"])

    def test_cleanup_overrides_reject_unknown_or_duplicate_word_ids(self):
        for field in ("cleanupKeepWordIds", "cleanupKeepGapIds"):
            with self.subTest(field=field, problem="unknown"), self.assertRaises(ValidationError):
                main.StatePayload(words=[self.word()], **{field: ["0000000002"]})
            with self.subTest(field=field, problem="duplicate"), self.assertRaises(ValidationError):
                main.StatePayload(words=[self.word()], **{field: ["0000000001", "0000000001"]})

    def test_cleanup_override_lists_are_bounded(self):
        with self.assertRaises(ValidationError):
            main.StatePayload(
                words=[self.word()],
                cleanupKeepWordIds=["0000000001"] * 500_001,
            )

    def test_gap_pacing_and_marker_schema_are_bounded_and_reference_safe(self):
        marker = {
            "id": "222222222222",
            "title": "Intro",
            "kind": "chapter",
            "anchor": {"sourceTime": 0.1},
        }
        state = main.StatePayload(
            words=[self.word()],
            gapPacing={"preset": "tight", "detectionThresholdMs": 600, "targetGapMs": 180},
            gapEdits=[{"afterWordId": "0000000001", "targetGapMs": 180}],
            markers=[marker],
        )
        self.assertEqual(state.gapEdits[0].targetGapMs, 180)
        self.assertEqual(state.markers[0].title, "Intro")

        invalid_states = (
            {"gapPacing": {"preset": "podcast", "detectionThresholdMs": 300, "targetGapMs": 300}},
            {"gapEdits": [{"afterWordId": "0000000002", "targetGapMs": 180}]},
            {"gapEdits": [{"afterWordId": "0000000001", "targetGapMs": 20}]},
            {"markers": [{**marker, "id": "333333333333", "title": "bad\nname"}]},
            {"markers": [{**marker, "anchor": {"sourceTime": 0.1, "insertId": "aaaaaaaaaaaa"}}]},
        )
        for values in invalid_states:
            with self.subTest(values=values), self.assertRaises(ValidationError):
                main.StatePayload(words=[self.word()], **values)

    def test_durable_retake_groups_are_bounded_and_reference_safe(self):
        words = [self.word("0000000001"), self.word("0000000002")]
        group = {
            "id": "222222222222",
            "candidates": [["0000000001"], ["0000000002"]],
            "recommendedKeepIndex": 1,
            "selectedKeepIndex": 0,
        }
        state = main.StatePayload(words=words, retakeGroups=[group])
        self.assertEqual(state.retakeGroups[0].selectedKeepIndex, 0)

        invalid_groups = (
            {**group, "id": "not-a-group"},
            {**group, "candidates": [["0000000001"], ["0000000003"]]},
            {**group, "selectedKeepIndex": 2},
        )
        for invalid in invalid_groups:
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                main.StatePayload(words=words, retakeGroups=[invalid])

    def test_durable_three_attempt_retake_group_accepts_disjoint_candidates(self):
        words = [self.word(f"{index:010d}") for index in range(1, 7)]
        group = {
            "id": "222222222222",
            "candidates": [
                ["0000000001", "0000000002"],
                ["0000000003", "0000000004"],
                ["0000000005", "0000000006"],
            ],
            "recommendedKeepIndex": 1,
            "selectedKeepIndex": 1,
        }

        state = main.StatePayload(words=words, retakeGroups=[group])

        self.assertEqual(
            state.model_dump()["retakeGroups"][0]["candidates"],
            group["candidates"],
        )
        self.assertEqual(state.retakeGroups[0].selectedKeepIndex, 1)

    def test_durable_retake_group_rejects_overlapping_candidate_word_ids(self):
        words = [self.word(f"{index:010d}") for index in range(1, 7)]
        overlapping_group = {
            "id": "222222222222",
            "candidates": [
                ["0000000001", "0000000002"],
                ["0000000002", "0000000003", "0000000004"],
                ["0000000005", "0000000006"],
            ],
            "recommendedKeepIndex": 1,
            "selectedKeepIndex": 1,
        }

        with self.assertRaisesRegex(ValidationError, "retake candidates may not overlap"):
            main.StatePayload(words=words, retakeGroups=[overlapping_group])

    def test_persisted_revision_is_valid_but_never_dumped_as_client_state(self):
        state = main.StatePayload(words=[self.word()], revision=7)
        self.assertEqual(state.revision, 7)
        self.assertNotIn("revision", state.model_dump())
        with self.assertRaises(ValidationError):
            main.StatePayload(words=[self.word()], revision=-1)

    def test_rejects_duplicate_word_ids(self):
        with self.assertRaises(ValidationError):
            main.StatePayload(words=[self.word(), self.word()])

    def test_rejects_unknown_gap_reference_and_extra_fields(self):
        with self.assertRaises(ValidationError):
            main.StatePayload(words=[self.word()], shortenedGapIds=["0000000002"])
        invalid = self.word()
        invalid["unexpected"] = True
        with self.assertRaises(ValidationError):
            main.StatePayload(words=[invalid])

    def test_rejects_reversed_or_non_finite_timestamps(self):
        reversed_word = self.word()
        reversed_word["endTime"] = 0.05
        with self.assertRaises(ValidationError):
            main.StatePayload(words=[reversed_word])
        infinite_word = self.word()
        infinite_word["startTime"] = float("inf")
        with self.assertRaises(ValidationError):
            main.StatePayload(words=[infinite_word])


class ClientErrorLoggingTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.token = "unit-test-session-token"
        self.headers = {
            "X-ScriptCut-Token": self.token,
            "User-Agent": "ScriptSurgeon-Test/1.0",
        }

    def test_requires_desktop_authentication(self):
        with patch.dict(main.os.environ, {"SCRIPTCUT_SESSION_TOKEN": self.token}):
            response = self.client.post("/api/client-errors", json={"message": "boom"})
        self.assertEqual(response.status_code, 403)

    def test_logs_bounded_diagnostics_without_location_query_or_tokens(self):
        payload = {
            "message": "The editor failed",
            "stack": "Error: failed at /?token=stack-secret&project=one",
            "componentStack": "at Editor (index.js:10)",
            "location": (
                "http://127.0.0.1:54321/editor"
                "?token=location-secret&project=6908f1bdad6e#selection"
            ),
        }
        with patch.dict(main.os.environ, {"SCRIPTCUT_SESSION_TOKEN": self.token}):
            with self.assertLogs(main.logger, level="ERROR") as captured:
                response = self.client.post(
                    "/api/client-errors",
                    json=payload,
                    headers=self.headers,
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})
        log = "\n".join(captured.output)
        self.assertIn("The editor failed", log)
        self.assertIn("component_stack", log)
        self.assertIn("http://127.0.0.1:54321/editor", log)
        self.assertIn("ScriptSurgeon-Test/1.0", log)
        for secret in (self.token, "stack-secret", "location-secret", "project=6908f1bdad6e"):
            self.assertNotIn(secret, log)

    def test_accepts_the_frontend_diagnostic_envelope(self):
        payload = {
            "source": "react",
            "name": "Error",
            "message": "No audio loaded",
            "stack": "at WaveformPanel",
            "componentStack": "at WaveformPanel (WaveformPanel.tsx:20)",
            "detail": "effect lifecycle",
            "page": "http://127.0.0.1:54321/?token=never-log-this",
            "userAgent": "WebView2",
            "occurredAt": "2026-08-08T17:30:00.000Z",
        }
        with patch.dict(main.os.environ, {"SCRIPTCUT_SESSION_TOKEN": self.token}):
            with self.assertLogs(main.logger, level="ERROR") as captured:
                response = self.client.post(
                    "/api/client-errors",
                    json=payload,
                    headers=self.headers,
                )

        self.assertEqual(response.status_code, 200)
        log = "\n".join(captured.output)
        self.assertIn("No audio loaded", log)
        self.assertIn("effect lifecycle", log)
        self.assertNotIn("never-log-this", log)

    def test_rejects_oversized_or_unknown_fields(self):
        with patch.dict(main.os.environ, {"SCRIPTCUT_SESSION_TOKEN": self.token}):
            oversized = self.client.post(
                "/api/client-errors",
                json={"message": "x" * 2_001},
                headers=self.headers,
            )
            unknown = self.client.post(
                "/api/client-errors",
                json={"message": "boom", "token": "must not be accepted"},
                headers=self.headers,
            )
        self.assertEqual(oversized.status_code, 422)
        self.assertEqual(unknown.status_code, 422)


if __name__ == "__main__":
    unittest.main()
