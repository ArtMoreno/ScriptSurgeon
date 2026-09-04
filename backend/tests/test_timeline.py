from __future__ import annotations

import pytest

from backend.integrations.edl import _channel as edl_channel, timecode
from backend.timeline import build_cues, build_timeline, total_cut_ms


def word(wid: str, text: str, start: float, end: float, removed: bool = False) -> dict:
    return {"id": wid, "text": text, "startTime": start, "endTime": end, "isRemoved": removed}


def test_untouched_project_maps_one_to_one():
    words = [word("a", "one", 0.0, 1.0), word("b", "two", 1.0, 2.0)]
    timeline = build_timeline(words, [], 2_000)

    assert timeline.duration == 2_000
    assert timeline.to_edited(1_500) == 1_500
    assert total_cut_ms(timeline) == 0


def test_removed_word_pulls_later_audio_earlier():
    words = [
        word("a", "one", 0.0, 1.0),
        word("b", "um", 1.0, 1.5, removed=True),
        word("c", "two", 1.5, 2.5),
    ]
    timeline = build_timeline(words, [], 2_500)

    # 500 ms of speech leaves, less the crossfade the renderer applies.
    assert timeline.duration == 2_000 - 10
    # The second segment starts one crossfade early, and everything inside it
    # keeps that offset.
    assert timeline.to_edited(1_500) == 990
    assert timeline.to_edited(2_500) == 1_990


def test_time_inside_a_cut_has_no_edited_position():
    words = [
        word("a", "one", 0.0, 1.0),
        word("b", "um", 1.0, 1.5, removed=True),
        word("c", "two", 1.5, 2.5),
    ]
    timeline = build_timeline(words, [], 2_500)

    assert timeline.to_edited(1_200) is None


def test_cues_skip_removed_words_and_use_edited_times():
    words = [
        word("a", "Hello", 0.0, 0.4),
        word("b", "um", 0.4, 0.9, removed=True),
        word("c", "world", 0.9, 1.3),
    ]
    timeline = build_timeline(words, [], 1_300)
    cues = build_cues(timeline, words)

    assert len(cues) == 1
    assert cues[0].text == "Hello world"
    assert cues[0].start == 0
    assert cues[0].end == 790


def test_cues_break_on_a_long_pause():
    words = [
        word("a", "first", 0.0, 0.4),
        word("b", "second", 3.0, 3.4),
    ]
    timeline = build_timeline(words, [], 3_400)
    cues = build_cues(timeline, words)

    assert [cue.text for cue in cues] == ["first", "second"]
    assert [cue.index for cue in cues] == [1, 2]


def test_cues_break_when_the_speaker_changes():
    words = [word("a", "hi", 0.0, 0.3), word("b", "hey", 0.35, 0.7)]
    timeline = build_timeline(words, [], 700)
    cues = build_cues(
        timeline,
        words,
        speaker_by_word={"a": "s1", "b": "s2"},
        speaker_names={"s1": "Art", "s2": "Guest"},
    )

    assert [(cue.speaker, cue.text) for cue in cues] == [("Art", "hi"), ("Guest", "hey")]


@pytest.mark.parametrize(
    ("milliseconds", "expected"),
    [(0, "00:00:00:00"), (1_000, "00:00:01:00"), (3_661_500, "01:01:01:15")],
)
def test_edl_timecode_at_thirty_frames(milliseconds, expected):
    assert timecode(milliseconds, 30.0) == expected


@pytest.mark.parametrize(
    ("channels", "expected"),
    [(1, "A"), (2, "AA"), (None, "AA")],
)
def test_edl_channel_matches_the_source(channels, expected):
    # "AA" on a mono recording lays the same signal onto two tracks in the
    # importer, which a CMX parser reproduces as a duplicated event.
    assert edl_channel(channels, False) == expected


def test_edl_channel_adds_video_when_asked():
    assert edl_channel(2, True) == "AA/V"
