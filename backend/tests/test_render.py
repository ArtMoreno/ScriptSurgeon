import json
import math
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from pydub import AudioSegment

from backend.render import (
    LOUDNORM_CHAIN,
    NOISE_LEVELS,
    STUDIO_CHAIN,
    cut_intervals,
    encode_mp3,
    export_segment,
    filter_chain,
    kept_intervals,
    normalized_noise,
    render_edited,
    source_fingerprint,
    state_hash,
    timeline_segments,
    wav_duration,
)
from backend import render


def write_tone(path: Path, duration: float = 3.0, rate: int = 16_000) -> None:
    frames = bytearray()
    for index in range(round(duration * rate)):
        sample = round(10_000 * math.sin(2 * math.pi * 220 * index / rate))
        frames.extend(int(sample).to_bytes(2, "little", signed=True))
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(frames)


def words():
    return [
        {"id": "0000000001", "text": "one", "startTime": 0.2, "endTime": 0.8, "isRemoved": False},
        {"id": "0000000002", "text": "two", "startTime": 1.2, "endTime": 1.8, "isRemoved": False},
        {"id": "0000000003", "text": "three", "startTime": 2.2, "endTime": 2.8, "isRemoved": False},
    ]


class RenderTimelineTests(unittest.TestCase):
    def test_no_edits_preserve_the_entire_source(self):
        self.assertEqual(cut_intervals(words(), [], 3000), [])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.wav"
            write_tone(source)
            rendered = render_edited(str(source), words(), [], False, str(root))
            self.assertAlmostEqual(wav_duration(rendered), 3.0, places=2)

    def test_source_replacement_invalidates_decode_and_render_caches(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "original.wav"
            write_tone(source, duration=3.0, rate=16_000)
            original_identity = source_fingerprint(source)
            first = render_edited(str(source), words(), [], False, str(root))
            self.assertAlmostEqual(wav_duration(first), 3.0, places=2)

            # Keep the exact project path and edit state. A stale decoded PCM or
            # render cache would incorrectly return the former three-second WAV.
            write_tone(source, duration=4.0, rate=22_050)
            replacement_identity = source_fingerprint(source)
            second = render_edited(str(source), words(), [], False, str(root))

            self.assertNotEqual(original_identity, replacement_identity)
            self.assertNotEqual(first, second)
            self.assertAlmostEqual(wav_duration(second), 4.0, places=2)
            self.assertEqual(
                json.loads((root / "source_pcm.identity.json").read_text(encoding="utf-8"))["source"],
                replacement_identity,
            )

    def test_middle_word_is_ripple_cut_instead_of_replaced_by_silence(self):
        edited = words()
        edited[1]["isRemoved"] = True
        self.assertEqual(cut_intervals(edited, [], 3000), [(1200, 1800)])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.wav"
            write_tone(source)
            rendered = render_edited(str(source), edited, [], False, str(root))
            # 600 ms is removed and the actual edit boundary gets a 10 ms crossfade.
            self.assertAlmostEqual(wav_duration(rendered), 2.39, places=2)

    def test_gap_shortening_only_applies_to_adjacent_kept_words(self):
        self.assertEqual(cut_intervals(words(), ["0000000001"], 3000), [(955, 1045)])
        edited = words()
        edited[1]["isRemoved"] = True
        self.assertEqual(cut_intervals(edited, ["0000000001"], 3000), [(1200, 1800)])

    def test_exact_gap_target_is_rendered_and_part_of_the_cache_identity(self):
        tight = [{"afterWordId": "0000000001", "targetGapMs": 180}]
        relaxed = [{"afterWordId": "0000000001", "targetGapMs": 350}]
        # Retain target + the bounded 10 ms join fade, split around the source
        # pause. A 400 ms source gap therefore cuts 210 ms at the 180 ms target.
        self.assertEqual(cut_intervals(words(), tight, 3000), [(895, 1105)])
        self.assertEqual(cut_intervals(words(), relaxed, 3000), [(980, 1020)])
        self.assertEqual(cut_intervals(words(), [{"afterWordId": "0000000001", "targetGapMs": 500}], 3000), [])
        self.assertNotEqual(state_hash(words(), tight, False), state_hash(words(), relaxed, False))

    def test_consecutive_removed_words_include_the_pause_between_them(self):
        edited = words()
        edited[0]["isRemoved"] = True
        edited[1]["isRemoved"] = True
        self.assertEqual(cut_intervals(edited, [], 3000), [(200, 1800)])

    def test_no_detected_words_do_not_destroy_audio(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.wav"
            write_tone(source)
            rendered = render_edited(str(source), [], [], False, str(root))
            self.assertAlmostEqual(wav_duration(rendered), 3.0, places=2)

    def test_cutting_the_entire_source_exports_zero_duration(self):
        edited = [{"id": "0000000001", "text": "all", "startTime": 0, "endTime": 3, "isRemoved": True}]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.wav"
            write_tone(source)
            rendered = render_edited(str(source), edited, [], False, str(root))
            self.assertEqual(wav_duration(rendered), 0.0)

    def test_active_insert_splits_source_at_boundary_and_removed_insert_is_skipped(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.wav"
            recordings = root / "recordings"
            recordings.mkdir()
            clip = recordings / "aaaaaaaaaaaa.wav"
            write_tone(source)
            write_tone(clip, duration=0.4)
            insert = {
                "id": "111111111111",
                "clipId": "aaaaaaaaaaaa",
                "sourceTime": 1.5,
                "duration": 0.4,
                "text": "new words",
                "afterWordId": "0000000002",
                "isRemoved": False,
            }

            rendered = render_edited(str(source), words(), [], False, str(root), [insert])
            # Two source/insert joins each receive the bounded 10 ms crossfade.
            self.assertAlmostEqual(wav_duration(rendered), 3.38, places=2)

            removed = {**insert, "isRemoved": True}
            rendered_without = render_edited(str(source), words(), [], False, str(root), [removed])
            self.assertAlmostEqual(wav_duration(rendered_without), 3.0, places=2)

    def test_insert_inside_removed_source_is_kept_at_the_collapsed_edit_boundary(self):
        edited = words()
        edited[1]["isRemoved"] = True
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.wav"
            recordings = root / "recordings"
            recordings.mkdir()
            clip = recordings / "bbbbbbbbbbbb.wav"
            write_tone(source)
            write_tone(clip, duration=0.4)
            insert = {
                "id": "222222222222",
                "clipId": "bbbbbbbbbbbb",
                "sourceTime": 1.5,
                "duration": 0.4,
                "text": "replacement",
                "afterWordId": "0000000001",
                "isRemoved": False,
            }

            rendered = render_edited(str(source), edited, [], False, str(root), [insert])
            # Remove 600 ms, add 400 ms, and crossfade both insert joins.
            self.assertAlmostEqual(wav_duration(rendered), 2.78, places=2)

    def test_inserts_inside_same_cut_keep_state_order_not_raw_source_time_order(self):
        edited = words()
        edited[1]["isRemoved"] = True
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source_path = root / "source.wav"
            recordings = root / "recordings"
            recordings.mkdir()
            write_tone(source_path)
            write_tone(recordings / "aaaaaaaaaaaa.wav", duration=0.2)
            write_tone(recordings / "bbbbbbbbbbbb.wav", duration=0.3)
            with source_path.open("rb") as source_handle:
                source = AudioSegment.from_wav(source_handle)
            inserts = [
                {
                    "id": "111111111111", "clipId": "aaaaaaaaaaaa", "sourceTime": 1.7,
                    "duration": 0.2, "text": "first", "afterWordId": "0000000001", "isRemoved": False,
                },
                {
                    "id": "222222222222", "clipId": "bbbbbbbbbbbb", "sourceTime": 1.3,
                    "duration": 0.3, "text": "second", "afterWordId": "0000000001", "isRemoved": False,
                },
            ]

            segments = timeline_segments(
                source,
                kept_intervals(edited, [], len(source)),
                inserts,
                root,
            )

            self.assertEqual([len(segment) for segment in segments], [1200, 200, 300, 1200])

    def test_render_hash_tracks_ordered_insert_descriptors(self):
        first = {
            "id": "111111111111", "clipId": "aaaaaaaaaaaa", "sourceTime": 1.0,
            "duration": 0.2, "isRemoved": False,
        }
        second = {
            "id": "222222222222", "clipId": "bbbbbbbbbbbb", "sourceTime": 1.0,
            "duration": 0.3, "isRemoved": False,
        }
        baseline = state_hash(words(), [], False, [first, second])
        self.assertNotEqual(baseline, state_hash(words(), [], False, [second, first]))
        self.assertNotEqual(baseline, state_hash(words(), [], False, [{**first, "isRemoved": True}, second]))
        # Presentation-only changes do not invalidate an identical audio render.
        self.assertEqual(baseline, state_hash(words(), [], False, [{**first, "text": "edited"}, second]))


class Mp3FallbackTests(unittest.TestCase):
    def test_pyav_fallback_encodes_when_bundled_ffmpeg_omits_libmp3lame(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.wav"
            output = root / "fallback.mp3"
            write_tone(source, duration=0.5, rate=44_100)
            with patch(
                "backend.render.run_ffmpeg",
                side_effect=RuntimeError("MP3 encoding failed: Unknown encoder 'libmp3lame'"),
            ):
                encode_mp3(str(source), str(output))
            self.assertGreater(output.stat().st_size, 0)
            import av

            with av.open(str(output)) as encoded:
                self.assertEqual(encoded.format.name, "mp3")
                self.assertEqual(encoded.streams.audio[0].codec_context.sample_rate, 44_100)

    def test_range_export_fallback_keeps_the_requested_time_slice(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.wav"
            output = root / "segment.mp3"
            write_tone(source, duration=2.0, rate=44_100)
            original_run_ffmpeg = render.run_ffmpeg

            def missing_cli_encoder(arguments, purpose):
                if purpose == "Range export":
                    raise RuntimeError("Range export failed: Unknown encoder 'libmp3lame'")
                return original_run_ffmpeg(arguments, purpose)

            with patch("backend.render.run_ffmpeg", side_effect=missing_cli_encoder):
                export_segment(str(source), str(output), "mp3", start=0.5, end=1.5)

            self.assertGreater(output.stat().st_size, 0)
            import av

            with av.open(str(output)) as encoded:
                self.assertAlmostEqual(encoded.duration / av.time_base, 1.0, places=1)


class NoiseReductionTests(unittest.TestCase):
    def test_every_strength_is_a_distinct_cached_render(self):
        digests = {level: state_hash(words(), [], False, [], level) for level in NOISE_LEVELS}
        self.assertEqual(len(set(digests.values())), len(NOISE_LEVELS))

    def test_unknown_strengths_fall_back_to_off_rather_than_reaching_ffmpeg(self):
        for junk in ("", None, "extreme", "afftdn=nr=97", "off;rm -rf"):
            self.assertEqual(normalized_noise(junk), "off")
            self.assertEqual(filter_chain(False, junk), "")
        # An unknown level must not silently render as a different cached result.
        self.assertEqual(state_hash(words(), [], False, [], "bogus"), state_hash(words(), [], False, [], "off"))

    def test_denoising_runs_before_studio_sound(self):
        chain = filter_chain(True, "medium", True)
        self.assertLess(chain.index("afftdn"), chain.index("acompressor"))
        self.assertLess(chain.index("acompressor"), chain.index("loudnorm"))
        self.assertEqual(filter_chain(False, "off"), "")
        self.assertEqual(filter_chain(True, "off"), STUDIO_CHAIN)


class LoudnessTests(unittest.TestCase):
    def test_normalization_is_independent_of_studio_sound(self):
        self.assertEqual(filter_chain(False, "off", True), LOUDNORM_CHAIN)
        self.assertNotIn("loudnorm", filter_chain(True, "off", False))
        self.assertNotIn("acompressor", filter_chain(False, "off", True))
        both = filter_chain(True, "off", True)
        self.assertIn("acompressor", both)
        self.assertIn("loudnorm", both)

    def test_normalization_is_part_of_the_render_identity(self):
        plain = state_hash(words(), [], True, [], "off", False)
        normalized = state_hash(words(), [], True, [], "off", True)
        self.assertNotEqual(plain, normalized, "a cached render must not be reused across this toggle")

    def test_each_strength_renders_audible_audio_of_the_same_length(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.wav"
            write_tone(source)
            for level in NOISE_LEVELS:
                rendered = render_edited(str(source), words(), [], False, str(root), [], level)
                self.assertAlmostEqual(wav_duration(rendered), 3.0, places=1, msg=level)
                # Keep the test's decoder handle scoped to the assertion.  Passing a
                # path lets pydub retain a temporary WAV reader until GC, which
                # obscures real resource-leak warnings from the renderer.
                with open(rendered, "rb") as rendered_handle:
                    self.assertGreater(AudioSegment.from_wav(rendered_handle).rms, 0, msg=level)


if __name__ == "__main__":
    unittest.main()
