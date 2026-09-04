import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import main
from backend.build_identity import build_identity


class BuildIdentityTests(unittest.TestCase):
    def test_packaged_identity_accepts_utf8_bom(self):
        with tempfile.TemporaryDirectory() as temp:
            resource_root = Path(temp)
            (resource_root / "build-info.json").write_text(
                json.dumps(
                    {
                        "version": "2026.08.12.bom",
                        "commit": "bom123456789",
                        "frontendBuildId": "frontend-bom",
                        "backendBuildId": "bom123456789",
                        "builtUtc": "2026-08-12T00:00:00Z",
                    }
                ),
                encoding="utf-8-sig",
            )
            with patch.dict(os.environ, {"SCRIPTCUT_RESOURCE_DIR": str(resource_root)}, clear=False):
                self.assertEqual(build_identity()["commit"], "bom123456789")

    def test_packaged_identity_is_loaded_from_resource_root(self):
        with tempfile.TemporaryDirectory() as temp:
            resource_root = Path(temp)
            (resource_root / "build-info.json").write_text(
                json.dumps(
                    {
                        "version": "2026.08.11.test",
                        "commit": "abc123def456",
                        "frontendBuildId": "frontend123",
                        "backendBuildId": "abc123def456",
                        "builtUtc": "2026-08-11T00:00:00Z",
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"SCRIPTCUT_RESOURCE_DIR": str(resource_root)}, clear=False):
                self.assertEqual(build_identity()["commit"], "abc123def456")
                self.assertEqual(build_identity()["frontendBuildId"], "frontend123")

    def test_packaged_identity_is_loaded_when_resource_root_is_install_root(self):
        with tempfile.TemporaryDirectory() as temp:
            resource_root = Path(temp)
            internal = resource_root / "_internal"
            internal.mkdir()
            (internal / "build-info.json").write_text(
                json.dumps(
                    {
                        "version": "2026.08.12.test",
                        "commit": "def456abc123",
                        "frontendBuildId": "frontend456",
                        "backendBuildId": "def456abc123",
                        "builtUtc": "2026-08-12T00:00:00Z",
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"SCRIPTCUT_RESOURCE_DIR": str(resource_root)}, clear=False):
                self.assertEqual(build_identity()["commit"], "def456abc123")
                self.assertEqual(build_identity()["frontendBuildId"], "frontend456")

    def test_packaged_identity_falls_back_to_the_frozen_executable_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            install_root = Path(temp)
            internal = install_root / "_internal"
            internal.mkdir()
            (internal / "build-info.json").write_text(
                json.dumps(
                    {
                        "version": "2026.08.12.test",
                        "commit": "frozen123456",
                        "frontendBuildId": "frontend789",
                        "backendBuildId": "frozen123456",
                        "builtUtc": "2026-08-12T00:00:00Z",
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"SCRIPTCUT_RESOURCE_DIR": str(install_root / "missing")}, clear=False), patch(
                "backend.build_identity.sys.executable", str(install_root / "ScriptSurgeon.exe")
            ):
                self.assertEqual(build_identity()["commit"], "frozen123456")

    def test_health_exposes_identity_without_project_data(self):
        identity = {
            "version": "test",
            "commit": "commit",
            "frontendBuildId": "frontend",
            "backendBuildId": "backend",
            "builtUtc": "now",
        }
        with patch.object(main, "build_identity", return_value=identity):
            with TestClient(main.app) as client:
                response = client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "service": "ScriptSurgeon", "build": identity})

    def test_retake_diagnostic_accepts_counts_only(self):
        payload = {
            "correlationId": "a" * 32,
            "projectId": "0123456789ab",
            "mediaAssetId": "0123456789ab",
            "jobId": "a" * 32,
            "jobStatus": "completed",
            "stage": "retake-preview",
            "transcriptRevision": 3,
            "wordCount": 12,
            "sourceStart": 0,
            "sourceEnd": 4.5,
            "sourceDuration": 6,
            "processedDuration": 5.1,
            "sourceSampleRate": 48_000,
            "sourceChannels": 2,
            "processedSampleRate": None,
            "processedChannels": None,
            "candidateWindows": 8,
            "rejected": {"speaker-boundary": 2},
            "groups": 1,
            "suggestions": 1,
            "noiseReduction": "off",
            "exceptionType": None,
            "exceptionLocation": None,
        }
        with TestClient(main.app) as client:
            response = client.post("/api/diagnostics/retake-analysis", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"ok": True, "correlationId": payload["correlationId"]})

    def test_retake_diagnostic_rejects_private_unstructured_fields(self):
        payload = {
            "correlationId": "a" * 32,
            "projectId": "0123456789ab",
            "mediaAssetId": "0123456789ab",
            "jobId": "a" * 32,
            "jobStatus": "completed",
            "stage": "retake-preview",
            "transcriptRevision": 0,
            "wordCount": 0,
            "sourceStart": 0,
            "sourceEnd": 0,
            "sourceDuration": 0,
            "processedDuration": 0,
            "sourceSampleRate": None,
            "sourceChannels": None,
            "processedSampleRate": None,
            "processedChannels": None,
            "candidateWindows": 0,
            "groups": 0,
            "suggestions": 0,
            "exceptionType": None,
            "exceptionLocation": None,
            "transcript": "must not be accepted",
        }
        with TestClient(main.app) as client:
            response = client.post("/api/diagnostics/retake-analysis", json=payload)
        self.assertEqual(response.status_code, 422)

    def test_retake_diagnostic_rejects_mismatched_asset_and_accepts_bounded_failure(self):
        payload = {
            "correlationId": "a" * 32,
            "projectId": "0123456789ab",
            "mediaAssetId": "fedcba987654",
            "jobId": "a" * 32,
            "jobStatus": "completed",
            "stage": "retake-preview",
            "transcriptRevision": 0,
            "wordCount": 0,
            "sourceStart": 0,
            "sourceEnd": 0,
            "sourceDuration": 0,
            "processedDuration": 0,
            "sourceSampleRate": None,
            "sourceChannels": None,
            "processedSampleRate": None,
            "processedChannels": None,
            "candidateWindows": 0,
            "groups": 0,
            "suggestions": 0,
            "noiseReduction": "off",
            "exceptionType": None,
            "exceptionLocation": None,
        }
        with TestClient(main.app) as client:
            response = client.post("/api/diagnostics/retake-analysis", json=payload)
        self.assertEqual(response.status_code, 422)

        payload.update({
            "mediaAssetId": payload["projectId"],
            "jobStatus": "failed",
            "exceptionType": "Error",
            "exceptionLocation": "retake-preview",
        })
        with TestClient(main.app) as client:
            accepted = client.post("/api/diagnostics/retake-analysis", json=payload)
        self.assertEqual(accepted.status_code, 200, accepted.text)
