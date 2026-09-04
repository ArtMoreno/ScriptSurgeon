import { useId } from 'react'
import { useStore } from '../store'
import { fmtTime } from '../lib/timeline'
import { player } from '../lib/player'
import { requestSeek } from '../lib/seekBus'
import { BackIcon, ForwardIcon, PauseIcon, PlayIcon } from './Icons'

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]

export default function TransportBar({
  variant,
  zoom,
  setZoom,
  onShowTimeline,
}: {
  variant: 'full' | 'thin'
  zoom: number
  setZoom: (zoom: number) => void
  onShowTimeline: () => void
}) {
  const playing = useStore((state) => state.playing)
  const playTime = useStore((state) => state.playTime)
  const duration = useStore((state) => state.duration)
  const audioUrl = useStore((state) => state.audioUrl)
  const waveformReady = useStore((state) => state.waveformReady)
  const status = useStore((state) => state.status)
  const rendering = useStore((state) => state.rendering)
  const playbackRate = useStore((state) => state.playbackRate)
  const setPlaybackRate = useStore((state) => state.setPlaybackRate)
  const waveformGain = useStore((state) => state.waveformGain)
  const setWaveformGain = useStore((state) => state.setWaveformGain)
  const zoomId = useId()
  const seekId = useId()
  const rateId = useId()
  const gainId = useId()

  const thin = variant === 'thin'
  const canPlay = status === 'ready' && Boolean(audioUrl) && waveformReady && !rendering
  const canSeek = canPlay && duration > 0

  return (
    <div
      className="h-12 shrink-0 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 border-t border-line bg-canvas-soft"
      role="group"
      aria-label="Playback transport"
    >
      {/* Equal edge tracks center the playable transport in the usable editor workspace. */}
      <div aria-hidden="true" />
      <div
        data-transport-centerline
        className={`min-w-0 justify-self-center flex items-center ${thin ? 'gap-1.5' : 'gap-2.5'}`}
      >
        <div className={thin ? 'flex items-center gap-0.5' : 'flex items-center gap-1 rounded-xl border border-line bg-canvas-raised p-1 shadow-sm shadow-line/20'}>
          <button
            type="button"
            onClick={() => player.skip(-5)}
            disabled={!canPlay}
            className={`toolbar-icon-button ${thin ? '!h-10 !w-10' : ''}`}
            aria-label="Go back 5 seconds"
            title="Back 5 seconds"
          >
            <BackIcon className={thin ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
          </button>
          <button
            type="button"
            onClick={() => player.playPause()}
            disabled={!canPlay}
            className={`${thin ? 'h-10 w-10' : 'h-9 w-9'} rounded-lg bg-ember hover:bg-ember-dark disabled:opacity-40 disabled:hover:bg-ember grid place-items-center text-ink-inverse shadow-md shadow-ember/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember`}
            aria-label={playing ? 'Pause audio' : 'Play audio'}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
          >
            {playing ? (
              <PauseIcon className={thin ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
            ) : (
              <PlayIcon className={thin ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
            )}
          </button>
          <button
            type="button"
            onClick={() => player.skip(5)}
            disabled={!canPlay}
            className={`toolbar-icon-button ${thin ? '!h-10 !w-10' : ''}`}
            aria-label="Go forward 5 seconds"
            title="Forward 5 seconds"
          >
            <ForwardIcon className={thin ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
          </button>
        </div>

        <div
          className={`font-mono ${thin ? 'hidden min-[960px]:block text-[11px]' : 'text-[12px]'} text-ink tabular-nums whitespace-nowrap px-1`}
          aria-label={`${fmtTime(playTime)} of ${fmtTime(duration)}`}
        >
          {fmtTime(playTime)} <span className="text-ink-faint">/ {fmtTime(duration)}</span>
        </div>

        <label htmlFor={rateId} className="sr-only">Playback speed</label>
        <select
          id={rateId}
          value={playbackRate}
          disabled={!canPlay}
          onChange={(event) => setPlaybackRate(Number(event.target.value))}
          className={`app-select ${thin ? 'h-10' : 'h-8'} shrink-0 rounded-md border bg-canvas-raised px-1 ${thin ? 'text-[10px]' : 'text-[11px]'} tabular-nums outline-none disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ember ${
            playbackRate === 1 ? 'border-line text-ink-muted' : 'border-ember/40 bg-ember-soft text-ember-dark'
          }`}
          title="Playback speed (pitch is preserved)"
        >
          {PLAYBACK_RATES.map((rate) => (
            <option key={rate} value={rate}>{rate}x</option>
          ))}
        </select>

        {thin && (
          <>
            <label htmlFor={seekId} className="sr-only">Seek through the recording</label>
            <input
              id={seekId}
              type="range"
              min={0}
              max={Math.max(duration, 0.01)}
              step={0.01}
              value={Math.min(playTime, duration)}
              disabled={!canSeek}
              onChange={(event) => requestSeek(Number(event.target.value))}
              className="transport-seek w-[clamp(84px,20vw,250px)] min-w-[84px]"
            />
          </>
        )}
      </div>

      {thin ? (
        <button
          type="button"
          onClick={onShowTimeline}
          aria-expanded={false}
          aria-controls="audio-waveform-content"
          className="justify-self-end h-10 shrink-0 rounded-md px-2 text-[11px] font-semibold text-ink-muted hover:bg-canvas-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
          title="Restore the compact timeline"
        >
          Show timeline
        </button>
      ) : (
        <div className="justify-self-end flex items-center gap-3">
          <div className="hidden lg:flex items-center gap-2 text-[11px] text-ink-muted">
            <label htmlFor={gainId} title="Vertical amplitude only; panel size, playback, and export are unaffected">Wave scale</label>
            <input
              id={gainId}
              type="range"
              min={1}
              max={8}
              step={0.5}
              value={waveformGain}
              disabled={!canPlay}
              onChange={(event) => setWaveformGain(Number(event.target.value))}
              className="w-20 accent-ember disabled:opacity-40"
            />
          </div>
          <div className="hidden sm:flex items-center gap-2 text-[11px] text-ink-muted">
            <label htmlFor={zoomId}>Timeline zoom</label>
            <input
              id={zoomId}
              type="range"
              min={10}
              max={200}
              value={zoom}
              disabled={!canPlay}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="w-28 accent-ember disabled:opacity-40"
            />
          </div>
        </div>
      )}
    </div>
  )
}
