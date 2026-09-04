from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from backend import transcribe


class ConfidenceTranscriptionTests(unittest.TestCase):
    def test_word_probability_is_optional_bounded_review_metadata(self):
        segment = SimpleNamespace(
            end=1.0,
            words=[
                SimpleNamespace(word=" um", start=0.0, end=0.2, probability=1.4),
                SimpleNamespace(word="hello", start=0.3, end=0.8, probability=-0.2),
                SimpleNamespace(word="there", start=0.8, end=1.0, probability=None),
            ],
        )
        info = SimpleNamespace(duration=1.0)
        model = SimpleNamespace(transcribe=lambda *_args, **_kwargs: ([segment], info))

        with patch.object(transcribe, "get_model", return_value=model), patch.object(
            transcribe, "source_sample_rate", return_value=48_000,
        ):
            words, duration, sample_rate = transcribe.transcribe_words("anonymous.wav")

        self.assertEqual(duration, 1.0)
        self.assertEqual(sample_rate, 48_000)
        self.assertEqual(words[0]["asrConfidence"], 1.0)
        self.assertEqual(words[1]["asrConfidence"], 0.0)
        self.assertNotIn("asrConfidence", words[2])
        self.assertEqual(words[0]["gapAfter"], 0.1)
