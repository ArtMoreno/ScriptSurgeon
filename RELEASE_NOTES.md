# v2026.09.28: retake review, reword, recorder, vim motions

The editing workspace gets its biggest revision since the September update.
Every feature below is in this release for Windows and macOS, and in the source
tree for Linux development.

**Retakes that are actually found.** A new balanced detection pass recognises the
restarts people really make: a sentence restarted after a pause, a restart longer
than five words, and a take separated from its retake by "sorry, let me redo that".
The previous rules remain as the Strict setting; the switch lives in the review
panel and is remembered per project. Nothing is ever applied without a choice.

**A review panel built around one decision.** Each retake group shows its takes as
rows you can play, with the words that differ tinted, one primary "Keep" button and
a sticky apply bar that counts decisions and seconds saved. The transcript labels
the takes, offers the same choice in place, and after applying shows a "Take 2 kept"
chip that reveals the cut words on hover.

**Reword phrases, not just words.** Select several words and press F2 (or Reword
selection… in the menu) to rewrite them as one phrase. Timing stays exact, audio
never changes, reworded words carry a marker, and Revert to original text undoes it.

**Long pauses after sentences.** Pauses of two seconds or more after a full stop
are now offered at low confidence with a 600 ms beat retained.

**A recorder you can read at a glance.** A round record control, a live waveform,
a zoned level meter with peak hold, a compact setup row and take cards replace the
previous form.

**Vim motions, off by default.** Turn them on in Settings and drive the transcript
with h j k l, sentence and paragraph motions, visual selection, d/c/r operators,
counts, u and Ctrl+R. Existing shortcuts are untouched; unknown keys pass through.

**Rename projects** from the home page, the sidebar and the editor title.

**Quieter transcript.** Speaker placeholders only appear when a speaker is set,
pause chips are subdued, and double-click rewords without moving the playhead.

## Packages

- Windows x64 installer;
- macOS Apple Silicon and Intel DMGs (ad-hoc signed, not notarized; macOS asks
  for approval on first open; Apple Silicon needs macOS 14 or later);
- `SHA256SUMS.txt` for every package.

Download only from this release page and verify the checksum. Projects,
transcription, previews and exports stay on your device. Bundled-runtime notices
are in [`THIRD_PARTY_NOTICES.md`](https://github.com/ArtMoreno/ScriptSurgeon/blob/main/THIRD_PARTY_NOTICES.md).

# September workspace update

Document-first editor, searchable home, reviewed retake improvements, live recorder
feedback and take downloads, exact WAV range exports, and refreshed Windows icon.

# ScriptSurgeon desktop release

**ScriptSurgeon is completely free and open source.** The previous Pro tier has
been removed: MP3 export, background noise cleanup, loudness normalize, chapter audio
and chapter list export, transcript with headings, VTT with chapter cues, and timeline
handoff (EDL and Final Cut XML) are included in every build. There is no license key,
no account, and nothing to buy.
