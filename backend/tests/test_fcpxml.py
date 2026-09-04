from __future__ import annotations

import wave
from pathlib import Path
from xml.etree import ElementTree

import pytest

from backend.integrations import ExportRequest
from backend.integrations.fcpxml import export_fcpxml, frame_duration
from backend.timeline import build_timeline


def word(wid: str, text: str, start: float, end: float, removed: bool = False) -> dict:
    return {"id": wid, "text": text, "startTime": start, "endTime": end, "isRemoved": removed}


def silent_wav(path: Path, milliseconds: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(1000)
        handle.writeframes(b"\x00\x00" * milliseconds)
    return path


@pytest.fixture
def project(tmp_path: Path) -> Path:
    silent_wav(tmp_path / "original.wav", 4_000)
    return tmp_path


def build(project: Path, words: list[dict], state: dict | None = None, inserts=None):
    timeline = build_timeline(
        words,
        [],
        4_000,
        inserts or [],
        lambda clip_id: 500,
    )
    return ExportRequest(
        timeline=timeline,
        words=words,
        state={"markers": [], "speakers": [], **(state or {})},
        meta={"name": "Demo project"},
        project_dir=project,
        source_path=project / "original.wav",
        output_dir=project,
    )


def parse(path: Path) -> ElementTree.Element:
    return ElementTree.parse(path).getroot()


CUT_WORDS = [
    word("a", "one", 0.0, 0.8),
    word("b", "um", 0.8, 1.1, removed=True),
    word("c", "two", 1.1, 4.0),
]


def test_the_format_declares_a_frame_duration(project):
    root = parse(export_fcpxml(build(project, CUT_WORDS)))

    # Importers read the sequence rate from this before reading any clip, so
    # omitting it fails the parse outright rather than degrading. Confirmed
    # against OpenTimelineIO's fcpx_xml adapter, which raised on its absence.
    assert root.find(".//format").get("frameDuration") == "100/3000s"


@pytest.mark.parametrize(
    ("fps", "expected"),
    [(30.0, "100/3000s"), (25.0, "100/2500s"), (29.97, "1001/30000s"), (23.976, "1001/24000s")],
)
def test_broadcast_rates_use_their_exact_ratio(fps, expected):
    assert frame_duration(fps) == expected


def test_the_document_is_well_formed_and_declares_its_version(project):
    root = parse(export_fcpxml(build(project, CUT_WORDS)))

    assert root.tag == "fcpxml"
    assert root.get("version") == "1.10"


def test_each_kept_run_becomes_one_clip_referencing_the_original(project):
    root = parse(export_fcpxml(build(project, CUT_WORDS)))

    clips = root.findall(".//spine/asset-clip")
    assert len(clips) == 2
    assert {clip.get("ref") for clip in clips} == {"r2"}


def test_clip_times_place_the_edit_on_two_clocks(project):
    clips = parse(export_fcpxml(build(project, CUT_WORDS))).findall(".//spine/asset-clip")

    # First run: source head, sitting at the head of the export.
    assert clips[0].get("offset") == "0/1000s"
    assert clips[0].get("start") == "0/1000s"
    assert clips[0].get("duration") == "800/1000s"
    # Second run resumes after the cut in the source but is contiguous in the
    # export, less the renderer's crossfade.
    assert clips[1].get("start") == "1100/1000s"
    assert clips[1].get("offset") == "790/1000s"


def test_the_source_is_referenced_not_copied(project):
    root = parse(export_fcpxml(build(project, CUT_WORDS)))

    rep = root.find(".//asset/media-rep")
    assert rep.get("kind") == "original-media"
    assert rep.get("src") == (project / "original.wav").as_uri()


def test_a_marker_lands_inside_the_clip_that_contains_it(project):
    state = {"markers": [
        {"id": "m1", "title": "Key point", "kind": "marker", "anchor": {"sourceTime": 2.0}},
    ]}
    clips = parse(export_fcpxml(build(project, CUT_WORDS, state))).findall(".//spine/asset-clip")

    assert clips[0].find("marker") is None
    marker = clips[1].find("marker")
    assert marker.get("value") == "Key point"
    # Marker times share the clip's source clock, so this is 2.0s, not the
    # 1.21s it sits at in the export.
    assert marker.get("start") == "2000/1000s"


def test_a_chapter_uses_the_chapter_element(project):
    state = {"markers": [
        {"id": "m1", "title": "Part two", "kind": "chapter", "anchor": {"sourceTime": 2.0}},
    ]}
    clips = parse(export_fcpxml(build(project, CUT_WORDS, state))).findall(".//spine/asset-clip")

    assert clips[1].find("chapter-marker").get("value") == "Part two"


def test_a_marker_on_removed_audio_is_dropped_rather_than_misplaced(project):
    state = {"markers": [
        {"id": "m1", "title": "On the filler", "kind": "marker", "anchor": {"sourceTime": 0.9}},
    ]}
    root = parse(export_fcpxml(build(project, CUT_WORDS, state)))

    assert root.findall(".//marker") == []


def test_titles_with_xml_significant_characters_are_escaped(project):
    state = {"markers": [
        {"id": "m1", "title": 'Q&A "live" <one>', "kind": "marker", "anchor": {"sourceTime": 2.0}},
    ]}
    root = parse(export_fcpxml(build(project, CUT_WORDS, state)))

    assert root.find(".//marker").get("value") == 'Q&A "live" <one>'


def test_an_inserted_take_becomes_its_own_asset_and_clip(project):
    silent_wav(project / "recordings" / "aaaaaaaaaaaa.wav", 500)
    inserts = [{"id": "i1", "clipId": "aaaaaaaaaaaa", "sourceTime": 2.0, "duration": 0.5}]
    root = parse(export_fcpxml(build(project, CUT_WORDS, None, inserts)))

    assets = root.findall(".//asset")
    assert len(assets) == 2
    insert_clip = [clip for clip in root.findall(".//spine/asset-clip")
                   if clip.get("name").startswith("Insert")]
    assert len(insert_clip) == 1
    assert insert_clip[0].get("ref") == assets[1].get("id")
    assert insert_clip[0].get("start") == "0/1000s"


def test_a_marker_inside_an_insert_rides_that_clip(project):
    silent_wav(project / "recordings" / "aaaaaaaaaaaa.wav", 500)
    inserts = [{"id": "i1", "clipId": "aaaaaaaaaaaa", "sourceTime": 2.0, "duration": 0.5}]
    state = {"markers": [{
        "id": "m1",
        "title": "In the pickup",
        "kind": "marker",
        "anchor": {"sourceTime": 2.0, "insertId": "i1", "insertOffset": 0.2},
    }]}
    root = parse(export_fcpxml(build(project, CUT_WORDS, state, inserts)))

    insert_clip = [clip for clip in root.findall(".//spine/asset-clip")
                   if clip.get("name").startswith("Insert")][0]
    assert insert_clip.find("marker").get("start") == "200/1000s"


def test_sequence_duration_matches_the_edit(project):
    root = parse(export_fcpxml(build(project, CUT_WORDS)))

    sequence = root.find(".//sequence")
    # 4000 source, less the 300 ms filler, less one 10 ms crossfade.
    assert sequence.get("duration") == "3690/1000s"
