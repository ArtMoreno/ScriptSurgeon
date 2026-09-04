"""Delivery integrations: one edit, many things to hand to something else.

Each target turns an `EditTimeline` into a file another tool understands - a
caption sidecar, an NLE timeline, a cut video. They are registered rather than
hard-coded into the API so adding a target is one module plus one entry, and
the UI can list what exists without the frontend knowing the set.

Everything here runs locally. A target that would need a network call does not
belong in ScriptSurgeon.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from ..timeline import EditTimeline


class Unavailable(RuntimeError):
    """The target cannot run for this project (wrong media, missing tool)."""


@dataclass(frozen=True)
class ExportRequest:
    """Everything a target may need, resolved by the API layer."""

    timeline: EditTimeline
    words: list[dict]
    state: dict[str, Any]
    meta: dict[str, Any]
    project_dir: Path
    source_path: Path
    # Where the target writes. Callers own the lifetime of this directory.
    output_dir: Path
    options: dict[str, Any] = field(default_factory=dict)


class Exporter(Protocol):
    def __call__(self, request: ExportRequest) -> Path:
        """Write the deliverable and return its path."""


@dataclass(frozen=True)
class Target:
    id: str
    label: str
    # What the user is getting, in the app's own voice. Shown in the picker.
    summary: str
    extension: str
    media_type: str
    run: Exporter
    # Set when a target only makes sense for some sources, e.g. video output.
    requires_video: bool = False
    # False while a target is registered but not yet built. The picker hides
    # these, so a scaffold never becomes a menu entry that only ever errors.
    available: bool = True


_REGISTRY: dict[str, Target] = {}


def register(target: Target) -> Target:
    if target.id in _REGISTRY:
        raise ValueError(f"duplicate integration target {target.id}")
    _REGISTRY[target.id] = target
    return target


def targets() -> list[Target]:
    return list(_REGISTRY.values())


def get(target_id: str) -> Target | None:
    return _REGISTRY.get(target_id)


def _load_targets() -> None:
    """Import the target modules for their registration side effects.

    Captions are deliberately absent: SRT and VTT are already produced
    client-side in frontend/src/lib/subtitles.ts, against the same edited
    timeline. A second implementation here would only drift from it.
    """
    from . import edl, fcpxml, video  # noqa: F401


_load_targets()
