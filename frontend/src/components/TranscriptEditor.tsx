import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useStore } from '../store'
import { editedGaps, editedInsertTimes, editedWordTimes } from '../lib/timeline'
import { gapTargetsFromEdits } from '../lib/gapPacing'
import { requestSeek } from '../lib/seekBus'
import type { InsertClip, Word } from '../types'
import { findMatches, stepMatch } from '../lib/transcriptSearch'
import { AudioIcon, EditIcon } from './Icons'
import TranscriptContextMenu, { type TranscriptMenuAction } from './TranscriptContextMenu'

type Item =
  | { kind: 'word'; word: Word; idx: number }
  | { kind: 'insert'; clip: InsertClip }
  | { kind: 'retakePill'; retake: RetakePill }
  | { kind: 'gapMarker'; wordId: string; shortened: boolean; proposed: boolean; gap: number; targetGapMs?: number }

interface RetakePill {
  group: string[]
  groupId?: string
  candidateCount?: number
  selectedKeepIndex?: number
}

interface Correction {
  kind: 'word' | 'insert'
  id: string
  text: string
}

type MenuTarget =
  | { kind: 'word'; wordId: string; idx: number }
  | { kind: 'retake'; group: string[]; groupId?: string }
  | { kind: 'gap'; wordId: string }
  | { kind: 'insert'; insertId: string }

interface MenuState {
  x: number
  y: number
  label: string
  target: MenuTarget
  returnFocus: HTMLElement
  fallbackWordId?: string
}

function isContextMenuKey(event: KeyboardEvent<HTMLElement>): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
}

export default function TranscriptEditor({
  onRecordInsert,
  onReplaceInsert,
}: {
  onRecordInsert: (trigger?: HTMLElement | null, afterWordId?: string) => void
  onReplaceInsert: (clip: InsertClip, trigger?: HTMLElement | null) => void
}) {
  const words = useStore((state) => state.words)
  const insertClips = useStore((state) => state.insertClips)
  const shortenedGapIds = useStore((state) => state.shortenedGapIds)
  const gapEdits = useStore((state) => state.gapEdits)
  const gapPacing = useStore((state) => state.gapPacing)
  const collapsedRetakes = useStore((state) => state.collapsedRetakes)
  const retakeGroups = useStore((state) => state.retakeGroups)
  const sourceDuration = useStore((state) => state.sourceDuration)
  const status = useStore((state) => state.status)
  const statusDetail = useStore((state) => state.statusDetail)
  const progress = useStore((state) => state.progress)
  const errorMsg = useStore((state) => state.errorMsg)
  const transcriptionRetryable = useStore((state) => state.transcriptionRetryable)
  const cleanupPreview = useStore((state) => state.cleanupPreview)
  const setSelection = useStore((state) => state.setSelection)
  const selAnchor = useStore((state) => state.selAnchor)
  const selFocus = useStore((state) => state.selFocus)
  const removeWords = useStore((state) => state.removeWords)
  const restoreWords = useStore((state) => state.restoreWords)
  const removeRetakeGroup = useStore((state) => state.removeRetakeGroup)
  const restoreRetakeGroup = useStore((state) => state.restoreRetakeGroup)
  const chooseRetakeCandidate = useStore((state) => state.chooseRetakeCandidate)
  const restoreRetakeGroupById = useStore((state) => state.restoreRetakeGroupById)
  const shortenGaps = useStore((state) => state.shortenGaps)
  const unshortenGaps = useStore((state) => state.unshortenGaps)
  const restoreGaps = useStore((state) => state.restoreGaps)
  const keepOriginalGaps = useStore((state) => state.keepOriginalGaps)
  const setGapTarget = useStore((state) => state.setGapTarget)
  const correctWord = useStore((state) => state.correctWord)
  const correctInsertText = useStore((state) => state.correctInsertText)
  const removeInsert = useStore((state) => state.removeInsert)
  const restoreInsert = useStore((state) => state.restoreInsert)
  const closeProject = useStore((state) => state.closeProject)
  const retryTranscription = useStore((state) => state.retryTranscription)
  const speakers = useStore((state) => state.speakers)
  const speakerByWord = useStore((state) => state.speakerByWord)
  const assignSpeaker = useStore((state) => state.assignSpeaker)
  const addSpeaker = useStore((state) => state.addSpeaker)
  const addMarker = useStore((state) => state.addMarker)

  const [dragging, setDragging] = useState(false)
  const [correction, setCorrection] = useState<Correction | null>(null)
  const [namingSpeakerFor, setNamingSpeakerFor] = useState<string | null>(null)
  const [newSpeakerName, setNewSpeakerName] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const newSpeakerInputRef = useRef<HTMLInputElement>(null)
  const [contextMenu, setContextMenu] = useState<MenuState | null>(null)
  const cancelCorrection = useRef(false)
  const wordEls = useRef(new Map<string, HTMLElement>())
  const insertEls = useRef(new Map<string, HTMLElement>())
  const shortenedSet = useMemo(() => new Set(shortenedGapIds), [shortenedGapIds])
  const gapTargets = useMemo(() => gapTargetsFromEdits(gapEdits), [gapEdits])
  const times = useMemo(
    () => editedWordTimes(words, shortenedSet, sourceDuration, insertClips, gapTargets),
    [words, shortenedSet, sourceDuration, insertClips, gapTargets],
  )
  const insertTimes = useMemo(
    () => editedInsertTimes(words, shortenedSet, sourceDuration, insertClips, gapTargets),
    [words, shortenedSet, sourceDuration, insertClips, gapTargets],
  )
  const timedTokens = useMemo(() => [
    ...words.flatMap((word) => {
      if (word.isRemoved) return []
      const span = times.get(word.id)
      return span ? [{ key: `word:${word.id}`, ...span }] : []
    }),
    ...insertClips.flatMap((clip) => {
      if (clip.isRemoved) return []
      const span = insertTimes.get(clip.id)
      return span ? [{ key: `insert:${clip.id}`, ...span }] : []
    }),
  ].sort((left, right) => left.start - right.start || left.end - right.end), [words, times, insertClips, insertTimes])

  const groupOf = useMemo(() => {
    const groups = new Map<string, RetakePill>()
    collapsedRetakes.forEach((group) => group.forEach((id) => groups.set(id, { group })))
    retakeGroups.forEach((retake) => {
      const removed = retake.candidates
        .filter((_candidate, index) => index !== retake.selectedKeepIndex)
        .flat()
      const pill: RetakePill = {
        group: removed,
        groupId: retake.id,
        candidateCount: retake.candidates.length,
        selectedKeepIndex: retake.selectedKeepIndex,
      }
      removed.forEach((id) => groups.set(id, pill))
    })
    return groups
  }, [collapsedRetakes, retakeGroups])

  const proposedGroupOf = useMemo(() => {
    const groups = new Map<string, string[]>()
    cleanupPreview?.collapsedRetakes.forEach((group) => group.forEach((id) => groups.set(id, group)))
    return groups
  }, [cleanupPreview])

  const wordsById = useMemo(() => new Map(words.map((word) => [word.id, word])), [words])
  const insertsById = useMemo(() => new Map(insertClips.map((clip) => [clip.id, clip])), [insertClips])

  const gapsByWord = useMemo(() => new Map(
    editedGaps(words, shortenedSet, sourceDuration, insertClips, gapTargets).map((gap) => [gap.wordId, gap]),
  ), [words, shortenedSet, sourceDuration, insertClips, gapTargets])

  const proposedWords = useMemo(() => {
    const proposed = new Map<string, Word>()
    if (!cleanupPreview) return proposed
    const currentById = new Map(words.map((word) => [word.id, word]))
    cleanupPreview.words.forEach((word) => {
      const current = currentById.get(word.id)
      if (current && !current.isRemoved && word.isRemoved) proposed.set(word.id, word)
    })
    return proposed
  }, [cleanupPreview, words])

  const proposedGaps = useMemo(() => {
    if (!cleanupPreview) return new Set<string>()
    const current = new Set(shortenedGapIds)
    return new Set(cleanupPreview.shortenedGapIds.filter((id) => !current.has(id)))
  }, [cleanupPreview, shortenedGapIds])

  const items = useMemo(() => {
    const output: Item[] = []
    const pillsShown = new Set<string>()
    const wordIds = new Set(words.map((word) => word.id))
    const insertsAfter = new Map<string | null, InsertClip[]>()
    insertClips.forEach((clip) => {
      const anchor = clip.afterWordId && wordIds.has(clip.afterWordId) ? clip.afterWordId : null
      insertsAfter.set(anchor, [...(insertsAfter.get(anchor) ?? []), clip])
    })
    insertsAfter.get(null)?.forEach((clip) => output.push({ kind: 'insert', clip }))
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]
      const retake = groupOf.get(word.id)
      const retakeKey = retake?.groupId ?? retake?.group[0]
      if (word.isRemoved && word.isRetake && retake && retakeKey && !pillsShown.has(retakeKey)) {
        pillsShown.add(retakeKey)
        output.push({ kind: 'retakePill', retake })
      }
      output.push({ kind: 'word', word, idx: index })
      insertsAfter.get(word.id)?.forEach((clip) => output.push({ kind: 'insert', clip }))
      if (!word.isRemoved) {
        const gap = gapsByWord.get(word.id)
        if (gap && (gap.origGap >= gapPacing.detectionThresholdMs / 1000 || gap.shortened || proposedGaps.has(word.id))) {
          output.push({
            kind: 'gapMarker',
            wordId: word.id,
            shortened: gap.shortened,
            proposed: proposedGaps.has(word.id),
            gap: gap.origGap,
            targetGapMs: gap.targetGap === undefined ? undefined : Math.round(gap.targetGap * 1000),
          })
        }
      }
    }
    return output
  }, [words, insertClips, groupOf, gapsByWord, proposedGaps, gapPacing.detectionThresholdMs])

  // Update the active word directly from the store so playback does not render
  // thousands of transcript tokens on every WaveSurfer time event.
  const lastActiveId = useRef<string | null>(null)
  useEffect(() => {
    const highlight = (playTime: number) => {
      let activeId: string | null = null
      let low = 0
      let high = timedTokens.length - 1
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        if (timedTokens[middle].start <= playTime) {
          activeId = timedTokens[middle].key
          low = middle + 1
        } else {
          high = middle - 1
        }
      }
      if (activeId === lastActiveId.current) {
        if (activeId) {
          const [kind, id] = activeId.split(':', 2)
          ;(kind === 'insert' ? insertEls.current : wordEls.current).get(id)?.setAttribute('data-active', 'true')
        }
        return
      }
      if (lastActiveId.current) {
        const [kind, id] = lastActiveId.current.split(':', 2)
        ;(kind === 'insert' ? insertEls.current : wordEls.current).get(id)?.removeAttribute('data-active')
      }
      if (activeId) {
        const [kind, id] = activeId.split(':', 2)
        const element = (kind === 'insert' ? insertEls.current : wordEls.current).get(id)
        element?.setAttribute('data-active', 'true')
        element?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
      }
      lastActiveId.current = activeId
    }
    highlight(useStore.getState().playTime)
    return useStore.subscribe((state, previous) => {
      if (state.playTime !== previous.playTime) highlight(state.playTime)
    })
  }, [timedTokens])

  useEffect(() => {
    const stopDragging = () => setDragging(false)
    window.addEventListener('mouseup', stopDragging)
    return () => window.removeEventListener('mouseup', stopDragging)
  }, [])

  useEffect(() => {
    if (status !== 'ready') setContextMenu(null)
  }, [status])

  useEffect(() => {
    if (namingSpeakerFor) newSpeakerInputRef.current?.focus({ preventScroll: true })
  }, [namingSpeakerFor])

  const closeContextMenu = useCallback((restoreFocus: boolean) => {
    const menu = contextMenu
    setContextMenu(null)
    if (!restoreFocus || !menu) return
    window.setTimeout(() => {
      const fallback = menu.fallbackWordId ? wordEls.current.get(menu.fallbackWordId) : null
      const target = menu.returnFocus.isConnected ? menu.returnFocus : fallback
      target?.focus({ preventScroll: true })
    }, 0)
  }, [contextMenu])

  // Every search hook must sit above the status early-returns below; declaring
  // them after would change the hook count between loading and ready renders.
  const searchMatches = useMemo(
    () => (searchOpen ? findMatches(words, searchQuery) : []),
    [searchOpen, words, searchQuery],
  )
  const activeMatch = searchMatches.length
    ? searchMatches[Math.min(searchIndex, searchMatches.length - 1)]
    : null
  const matchedWordIds = useMemo(() => {
    const all = new Set<string>()
    for (const match of searchMatches) for (const id of match.wordIds) all.add(id)
    return all
  }, [searchMatches])
  const activeMatchKey = activeMatch ? activeMatch.wordIds.join(',') : ''
  const activeWordIds = useMemo(
    () => new Set(activeMatchKey ? activeMatchKey.split(',') : []),
    [activeMatchKey],
  )

  // Reveal the current hit without stealing focus from the search box.
  useEffect(() => {
    if (!activeMatchKey) return
    wordEls.current.get(activeMatchKey.split(',')[0])?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeMatchKey])

  useEffect(() => {
    setSearchIndex(0)
  }, [searchQuery])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchIndex(0)
  }, [])

  const stepSearch = (delta: number) => {
    setSearchIndex((current) => stepMatch(current, searchMatches.length, delta))
  }

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
      if (useStore.getState().status !== 'ready') return
      event.preventDefault()
      setSearchOpen(true)
      window.setTimeout(() => searchInputRef.current?.select(), 0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (status === 'transcribing' || status === 'uploading' || status === 'loading') {
    return (
      <section className="flex-1 min-h-0 grid place-items-center px-6" aria-live="polite" aria-busy="true">
        <div className="w-full max-w-md text-center">
          <span className="mx-auto h-14 w-14 rounded-2xl bg-ember-soft text-ember grid place-items-center mb-5">
            <AudioIcon className="h-7 w-7" />
          </span>
          <h2 className="text-xl font-semibold tracking-tight text-ink">
            {status === 'uploading' ? 'Importing your media' : status === 'loading' ? 'Opening your project' : 'Turning speech into editable text'}
          </h2>
          <p className="text-sm leading-6 text-ink-muted mt-2">
            {statusDetail || 'Everything stays on this computer.'}
          </p>
          <div className="mt-6 h-1.5 rounded-full bg-line overflow-hidden">
            <div
              className="h-full rounded-full bg-ember transition-[width] duration-300"
              style={{ width: `${status === 'loading' || status === 'uploading' ? 24 : Math.max(3, Math.round(progress * 100))}%` }}
            />
          </div>
          <div className="mt-2 text-[11px] text-ink-muted tabular-nums">
            {status === 'transcribing' ? `${Math.round(progress * 100)}% complete` : 'Preparing locally...'}
          </div>
        </div>
      </section>
    )
  }

  if (status === 'error' || status === 'cancelled') {
    return (
      <section className="flex-1 min-h-0 grid place-items-center px-6">
        <div className="max-w-md text-center rounded-2xl border border-danger/25 bg-danger-soft px-6 py-7">
          <div className="text-lg font-semibold text-danger-dark">
            {status === 'cancelled' ? 'Transcription was cancelled' : 'This project needs attention'}
          </div>
          <div className="text-sm leading-6 text-ink-muted whitespace-pre-wrap mt-2">
            {errorMsg || (status === 'cancelled'
              ? 'You can restart transcription from the original local media.'
              : 'Transcription did not finish.')}
          </div>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {transcriptionRetryable && (
              <button
                type="button"
                onClick={() => void retryTranscription()}
                className="h-10 px-4 rounded-lg bg-ember hover:bg-ember-hover text-sm font-semibold text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
              >
                Retry transcription
              </button>
            )}
            <button
              type="button"
              onClick={() => void closeProject().catch(() => undefined)}
              className="h-10 px-4 rounded-lg border border-line-strong bg-canvas-raised hover:bg-canvas-soft text-sm font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            >
              Back to projects
            </button>
          </div>
        </div>
      </section>
    )
  }

  const selection = selAnchor !== null && selFocus !== null
    ? [Math.min(selAnchor, selFocus), Math.max(selAnchor, selFocus)]
    : null
  const firstKeptIndex = words.findIndex((word) => !word.isRemoved)
  const rovingIndex = selFocus ?? (firstKeptIndex >= 0 ? firstKeptIndex : words.length ? 0 : -1)

  const focusWord = (index: number) => {
    const word = words[index]
    if (!word) return
    setSelection(index, index)
    window.setTimeout(() => wordEls.current.get(word.id)?.focus(), 0)
  }

  const beginCorrection = (word: Word) => {
    cancelCorrection.current = false
    setCorrection({ kind: 'word', id: word.id, text: word.text })
  }

  const beginInsertCorrection = (clip: InsertClip) => {
    cancelCorrection.current = false
    setCorrection({ kind: 'insert', id: clip.id, text: clip.text })
  }

  const openSpeakerNaming = (wordId: string) => {
    setNewSpeakerName('')
    setNamingSpeakerFor(wordId)
  }

  const cancelSpeakerNaming = () => {
    setNamingSpeakerFor(null)
    setNewSpeakerName('')
  }

  const saveSpeakerNaming = () => {
    if (!namingSpeakerFor) return
    const speakerId = addSpeaker(newSpeakerName)
    if (!speakerId) return
    assignSpeaker(namingSpeakerFor, speakerId)
    cancelSpeakerNaming()
  }

  const openMenu = (
    target: MenuTarget,
    trigger: HTMLElement,
    label: string,
    x: number,
    y: number,
    fallbackWordId?: string,
  ) => {
    setDragging(false)
    setContextMenu({ target, returnFocus: trigger, label, x, y, fallbackWordId })
  }

  const openPointerMenu = (
    event: MouseEvent<HTMLElement>,
    target: MenuTarget,
    label: string,
    fallbackWordId?: string,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    openMenu(target, event.currentTarget, label, event.clientX, event.clientY, fallbackWordId)
  }

  const openKeyboardMenu = (
    event: KeyboardEvent<HTMLElement>,
    target: MenuTarget,
    label: string,
    fallbackWordId?: string,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    const bounds = event.currentTarget.getBoundingClientRect()
    openMenu(target, event.currentTarget, label, bounds.left + Math.min(bounds.width / 2, 28), bounds.bottom + 4, fallbackWordId)
  }

  const selectedKeptIds = selection
    ? words.slice(selection[0], selection[1] + 1).filter((word) => !word.isRemoved).map((word) => word.id)
    : []
  const editGapTarget = (wordId: string) => {
    const currentTarget = gapEdits.find((edit) => edit.afterWordId === wordId)?.targetGapMs ?? gapPacing.targetGapMs
    const entered = window.prompt('Keep how many milliseconds of room tone in this pause?', String(currentTarget))
    if (entered === null) return
    const target = Number(entered)
    if (Number.isFinite(target)) setGapTarget(wordId, target)
  }
  const menuActions: TranscriptMenuAction[] = []

  if (contextMenu?.target.kind === 'word') {
    const { wordId, idx } = contextMenu.target
    const word = wordsById.get(wordId)
    if (word) {
      menuActions.push({
        id: 'edit-word',
        label: 'Edit word',
        onSelect: () => beginCorrection(word),
        returnFocus: false,
      })

      if (!word.isRemoved) {
        menuActions.push({
          id: 'record-after-word',
          label: 'Record after this word',
          onSelect: () => onRecordInsert(contextMenu.returnFocus, word.id),
          returnFocus: false,
        })
      }

      if (!word.isRemoved) {
        menuActions.push({
          id: 'add-marker-here',
          label: 'Add marker here',
          onSelect: () => addMarker('marker', undefined, { sourceTime: word.startTime }),
          dividerBefore: true,
        }, {
          id: 'add-chapter-here',
          label: 'Start chapter here',
          onSelect: () => addMarker('chapter', undefined, { sourceTime: word.startTime }),
        })
      }

      const targetInsideSelection = selection !== null && idx >= selection[0] && idx <= selection[1]
      if (targetInsideSelection && selectedKeptIds.length > 1) {
        menuActions.push({
          id: 'remove-selected-words',
          label: `Remove selected words (${selectedKeptIds.length})`,
          onSelect: () => removeWords(selectedKeptIds),
          destructive: true,
          dividerBefore: true,
        })
        menuActions.push({
          id: 'remove-selection-retake',
          label: `Remove selection as retake (${selectedKeptIds.length} words)`,
          onSelect: () => removeRetakeGroup(selectedKeptIds),
          destructive: true,
        })
      }

      menuActions.push(word.isRemoved
        ? {
            id: 'restore-word',
            label: 'Restore word',
            onSelect: () => restoreWords([word.id]),
            dividerBefore: targetInsideSelection && selectedKeptIds.length > 1,
          }
        : {
            id: 'remove-word',
            label: 'Remove word',
            onSelect: () => removeWords([word.id]),
            destructive: true,
            dividerBefore: targetInsideSelection && selectedKeptIds.length > 1,
          })

      const durablePill = groupOf.get(word.id)
      const group = durablePill?.group ?? proposedGroupOf.get(word.id)
      if (group?.length) {
        const anyGroupRemoved = group.some((id) => wordsById.get(id)?.isRemoved)
        const durable = durablePill?.groupId
          ? retakeGroups.find((candidate) => candidate.id === durablePill.groupId)
          : undefined
        if (durable) {
          menuActions.push({
            id: 'restore-retake-group',
            label: `Restore all ${durable.candidates.length} takes`,
            onSelect: () => restoreRetakeGroupById(durable.id),
            dividerBefore: true,
          })
          durable.candidates.forEach((candidate, candidateIndex) => {
            if (candidateIndex === durable.selectedKeepIndex) return
            menuActions.push({
              id: `keep-retake-take-${candidateIndex}`,
              label: `Keep Take ${candidateIndex + 1} (${candidate.length} words)`,
              onSelect: () => chooseRetakeCandidate(durable.id, candidateIndex),
            })
          })
        } else {
          menuActions.push(anyGroupRemoved
            ? {
                id: 'restore-retake',
                label: `Restore retake (${group.length} words)`,
                onSelect: () => restoreRetakeGroup(group),
                dividerBefore: true,
              }
            : {
                id: 'remove-retake',
                label: `Remove retake (${group.length} words)`,
                onSelect: () => removeRetakeGroup(group),
                destructive: true,
                dividerBefore: true,
              })
        }
      }

      // Speaker changes attach to the word that starts the run.
      speakers.forEach((speaker, position) => {
        if (speakerByWord[word.id] === speaker.id) return
        menuActions.push({
          id: `speaker-${speaker.id}`,
          label: `Speaker starts here: ${speaker.name}`,
          onSelect: () => assignSpeaker(word.id, speaker.id),
          dividerBefore: position === 0,
        })
      })
      menuActions.push({
        id: 'speaker-new',
        label: 'Speaker starts here: new speaker…',
          onSelect: () => openSpeakerNaming(word.id),
        dividerBefore: speakers.length === 0,
      })
      if (speakerByWord[word.id]) {
        menuActions.push({
          id: 'speaker-clear',
          label: 'Remove speaker change here',
          onSelect: () => assignSpeaker(word.id, null),
        })
      }

      const gap = gapsByWord.get(word.id)
      if (gap && (gap.origGap >= gapPacing.detectionThresholdMs / 1000 || gap.shortened || proposedGaps.has(word.id))) {
        if (gap.shortened) {
          menuActions.push({
            id: 'edit-gap-after-word',
            label: `Edit retained pause (${Math.round((gap.targetGap ?? 0) * 1000)} ms)`,
            onSelect: () => editGapTarget(word.id),
            dividerBefore: true,
          }, {
            id: 'restore-gap-after-word',
            label: 'Restore full pause after word',
            onSelect: () => restoreGaps([word.id]),
          }, {
            id: 'keep-gap-after-word',
            label: 'Keep original and ignore suggestion',
            onSelect: () => keepOriginalGaps([word.id]),
          })
        } else {
          menuActions.push({
            id: 'shorten-gap-after-word',
            label: `Shorten pause to ${gapPacing.targetGapMs} ms`,
            onSelect: () => shortenGaps([word.id]),
            dividerBefore: true,
          }, {
            id: 'edit-gap-after-word',
            label: 'Set exact retained pause…',
            onSelect: () => editGapTarget(word.id),
          })
        }
      }
    }
  } else if (contextMenu?.target.kind === 'retake') {
    const group = contextMenu.target.group
    const groupId = contextMenu.target.groupId
    const anyGroupRemoved = group.some((id) => wordsById.get(id)?.isRemoved)
    const durable = groupId
      ? retakeGroups.find((candidate) => candidate.id === groupId)
      : undefined
    if (durable) {
      menuActions.push({
        id: 'restore-retake-group',
        label: `Restore all ${durable.candidates.length} takes`,
        onSelect: () => restoreRetakeGroupById(durable.id),
      })
      durable.candidates.forEach((candidate, candidateIndex) => {
        if (candidateIndex === durable.selectedKeepIndex) return
        menuActions.push({
          id: `keep-retake-take-${candidateIndex}`,
          label: `Keep Take ${candidateIndex + 1} (${candidate.length} words)`,
          onSelect: () => chooseRetakeCandidate(durable.id, candidateIndex),
        })
      })
    } else {
      menuActions.push(anyGroupRemoved
        ? {
            id: 'restore-retake',
            label: `Restore retake (${group.length} words)`,
            onSelect: () => restoreRetakeGroup(group),
          }
        : {
            id: 'remove-retake',
            label: `Remove retake (${group.length} words)`,
            onSelect: () => removeRetakeGroup(group),
            destructive: true,
          })
    }
  } else if (contextMenu?.target.kind === 'gap') {
    const wordId = contextMenu.target.wordId
    const shortened = shortenedSet.has(wordId)
    menuActions.push(shortened
      ? {
          id: 'edit-gap',
          label: 'Edit retained pause…',
          onSelect: () => editGapTarget(wordId),
        }
      : {
          id: 'shorten-gap',
          label: `Shorten gap to ${gapPacing.targetGapMs} ms`,
          onSelect: () => shortenGaps([wordId]),
        })
    menuActions.push(shortened
      ? {
          id: 'restore-gap',
          label: 'Restore full gap',
          onSelect: () => restoreGaps([wordId]),
        }
      : {
          id: 'set-gap',
          label: 'Set exact retained pause…',
          onSelect: () => editGapTarget(wordId),
        })
  } else if (contextMenu?.target.kind === 'insert') {
    const clip = insertsById.get(contextMenu.target.insertId)
    if (clip) {
      menuActions.push({
        id: 'edit-insert-text',
        label: 'Edit text',
        onSelect: () => beginInsertCorrection(clip),
        returnFocus: false,
      })
      menuActions.push({
        id: 'rerecord-insert',
        label: 'Re-record audio',
        onSelect: () => onReplaceInsert(clip, contextMenu.returnFocus),
        returnFocus: false,
      })
      menuActions.push(clip.isRemoved
        ? {
            id: 'restore-insert',
            label: 'Restore inserted audio',
            onSelect: () => restoreInsert(clip.id),
            dividerBefore: true,
          }
        : {
            id: 'remove-insert',
            label: 'Remove inserted audio',
            onSelect: () => removeInsert(clip.id),
            destructive: true,
            dividerBefore: true,
          })
    }
  }

  return (
    <section className="flex-1 min-h-0 flex flex-col bg-canvas" aria-label="Transcript editor">
      <div className="min-h-10 shrink-0 border-b border-line px-5 py-1.5 flex flex-wrap items-center gap-3 text-[11px]">
        <span className="font-semibold uppercase tracking-[0.14em] text-ink">Transcript</span>
        <span className="text-line-strong">/</span>
        <span className="hidden md:inline text-ink-muted">Click to seek · drag to select · double-click to correct · right-click for actions</span>
        {searchOpen ? (
          <div className="ml-auto flex items-center gap-1.5" role="search">
            <label htmlFor="transcript-search" className="sr-only">Search the transcript</label>
            <input
              id="transcript-search"
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  stepSearch(event.shiftKey ? -1 : 1)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  closeSearch()
                }
              }}
              placeholder="Find in transcript"
              autoComplete="off"
              spellCheck={false}
              className="h-7 w-48 rounded-md border border-line bg-canvas-raised px-2 text-[12px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-ember"
            />
            <span className="tabular-nums text-ink-muted min-w-[54px]" aria-live="polite">
              {searchQuery.trim()
                ? searchMatches.length
                  ? `${Math.min(searchIndex, searchMatches.length - 1) + 1} of ${searchMatches.length}`
                  : 'No matches'
                : ''}
            </span>
            <button
              type="button"
              onClick={() => stepSearch(-1)}
              disabled={!searchMatches.length}
              className="h-7 w-7 grid place-items-center rounded-md text-ink-muted hover:bg-canvas-soft hover:text-ink disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
              aria-label="Previous match"
              title="Previous match (Shift+Enter)"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => stepSearch(1)}
              disabled={!searchMatches.length}
              className="h-7 w-7 grid place-items-center rounded-md text-ink-muted hover:bg-canvas-soft hover:text-ink disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
              aria-label="Next match"
              title="Next match (Enter)"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={closeSearch}
              className="h-7 w-7 grid place-items-center rounded-md text-ink-muted hover:bg-canvas-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
              aria-label="Close search"
              title="Close search (Esc)"
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setSearchOpen(true)
              window.setTimeout(() => searchInputRef.current?.focus(), 0)
            }}
            disabled={status !== 'ready'}
            className="ml-auto h-7 rounded-md border border-line px-2 text-[11px] text-ink-muted hover:bg-canvas-soft hover:text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            title="Find in transcript (Ctrl+F)"
          >
            Find
          </button>
        )}
        {cleanupPreview && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-plum-soft px-2.5 py-1 text-plum-dark">
            <span className="h-1.5 w-1.5 rounded-full bg-plum" />
            {cleanupPreview.kind === 'fillers' && 'Previewing filler removal'}
            {cleanupPreview.kind === 'gaps' && 'Previewing gap shortening'}
            {cleanupPreview.kind === 'retakes' && 'Previewing retake removal'}
          </span>
        )}
      </div>
      <div
        className="flex-1 min-h-0 overflow-y-auto px-[clamp(20px,5vw,72px)] py-8 select-none"
        onMouseUp={(event) => {
          setDragging(false)
          if (event.button !== 0) return
          if (!(event.target as HTMLElement).closest('[data-word-id]')) return
          if (selAnchor !== null && selAnchor === selFocus && !correction) {
            const word = words[selAnchor]
            if (word && !word.isRemoved) {
              const span = times.get(word.id)
              if (span) requestSeek(span.start, event.altKey)
            }
          }
        }}
      >
        <article className="max-w-[860px] mx-auto text-[19px] leading-[2.15] text-ink" aria-label="Editable transcript">
          {items.map((item, key) => {
            if (item.kind === 'retakePill') {
              const { retake } = item
              const retakeTarget = {
                kind: 'retake' as const,
                group: [...retake.group],
                ...(retake.groupId ? { groupId: retake.groupId } : {}),
              }
              return (
                <button
                  type="button"
                  key={`pill-${key}`}
                  data-retake-group={retake.groupId ?? retake.group[0]}
                  onClick={() => retake.groupId ? restoreRetakeGroupById(retake.groupId) : restoreRetakeGroup(retake.group)}
                  onContextMenu={(event) => openPointerMenu(
                    event,
                    retakeTarget,
                    `Actions for ${retake.candidateCount ?? 2}-take retake group`,
                    retake.group[0],
                  )}
                  onKeyDown={(event) => {
                    if (isContextMenuKey(event)) {
                      openKeyboardMenu(
                        event,
                        retakeTarget,
                        `Actions for ${retake.candidateCount ?? 2}-take retake group`,
                        retake.group[0],
                      )
                    }
                  }}
                  aria-haspopup="menu"
                  aria-expanded={contextMenu?.target.kind === 'retake' && contextMenu.target.group[0] === retake.group[0]}
                  className="mx-1 min-h-7 px-2.5 rounded-full bg-plum-soft border border-plum/30 text-plum-dark text-[11px] align-middle hover:bg-plum/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-plum"
                  title="Restore the takes, or choose a different retained take with right-click or Shift+F10"
                >
                  {retake.groupId ? `Retake group · ${retake.candidateCount} takes` : `Restore retake · ${retake.group.length} words`}
                </button>
              )
            }
            if (item.kind === 'insert') {
              const { clip } = item
              const editing = correction?.kind === 'insert' && correction.id === clip.id
              const span = insertTimes.get(clip.id)
              if (editing) {
                const restoreInsertFocus = () => {
                  window.setTimeout(() => insertEls.current.get(clip.id)?.focus({ preventScroll: true }), 0)
                }
                return (
                  <span key={`insert-edit-${clip.id}`} className="inline-flex align-middle items-center gap-1 mx-1">
                    <AudioIcon className="h-3.5 w-3.5 text-plum" />
                    <input
                      autoFocus
                      value={correction.text}
                      maxLength={500}
                      onChange={(event) => setCorrection({ kind: 'insert', id: clip.id, text: event.target.value })}
                      onFocus={(event) => event.currentTarget.select()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          correctInsertText(clip.id, correction.text)
                          setCorrection(null)
                          restoreInsertFocus()
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelCorrection.current = true
                          setCorrection(null)
                          restoreInsertFocus()
                        }
                      }}
                      onBlur={() => {
                        if (!cancelCorrection.current) correctInsertText(clip.id, correction.text)
                        cancelCorrection.current = false
                        setCorrection(null)
                      }}
                      className="h-8 min-w-24 max-w-72 rounded-md border border-plum/60 bg-canvas-raised px-2 text-[16px] leading-none text-ink shadow-lg shadow-ink/10 outline-none ring-2 ring-plum/15"
                      style={{ width: `${Math.min(22, Math.max(7, correction.text.length + 2))}ch` }}
                      aria-label={`Edit inserted transcript “${clip.text}”`}
                    />
                  </span>
                )
              }
              return (
                <button
                  type="button"
                  key={`insert-${clip.id}`}
                  ref={(element) => {
                    if (element) insertEls.current.set(clip.id, element)
                    else insertEls.current.delete(clip.id)
                  }}
                  data-insert-id={clip.id}
                  onClick={() => {
                    if (clip.isRemoved) restoreInsert(clip.id)
                    else if (span) requestSeek(span.start, false)
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation()
                    beginInsertCorrection(clip)
                  }}
                  onContextMenu={(event) => openPointerMenu(
                    event,
                    { kind: 'insert', insertId: clip.id },
                    `Actions for inserted audio “${clip.text}”`,
                  )}
                  onKeyDown={(event) => {
                    if (isContextMenuKey(event)) {
                      openKeyboardMenu(
                        event,
                        { kind: 'insert', insertId: clip.id },
                        `Actions for inserted audio “${clip.text}”`,
                      )
                    } else if (clip.isRemoved && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault()
                      restoreInsert(clip.id)
                    } else if (event.key === 'Enter' && span) {
                      event.preventDefault()
                      requestSeek(span.start, true)
                    } else if (event.key === 'F2') {
                      event.preventDefault()
                      beginInsertCorrection(clip)
                    } else if ((event.key === 'Backspace' || event.key === 'Delete') && !clip.isRemoved) {
                      event.preventDefault()
                      removeInsert(clip.id)
                    }
                  }}
                  aria-haspopup="menu"
                  aria-expanded={contextMenu?.target.kind === 'insert' && contextMenu.target.insertId === clip.id}
                  aria-label={`${clip.text}, inserted audio${clip.isRemoved ? ', removed; press Enter or Space to restore' : ''}; Shift+F10 opens actions`}
                  className={`word-token mx-1 min-h-8 max-w-full px-2.5 rounded-lg border text-[13px] leading-6 align-middle inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-plum ${
                    clip.isRemoved
                      ? 'border-line bg-canvas-soft text-ink-faint hover:text-ink-muted'
                      : 'border-plum/35 bg-plum-tint text-plum-dark hover:bg-plum/20'
                  }`}
                  title={clip.isRemoved
                    ? 'Restore inserted audio · right-click for actions'
                    : 'Click to seek · double-click to edit text · right-click for actions'}
                >
                  <AudioIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className={clip.isRemoved ? 'line-through decoration-current/70' : ''}>{clip.text}</span>
                  <span className="rounded border border-current/20 px-1 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide opacity-75">
                    {clip.isRemoved ? 'Restore' : 'Insert'}
                  </span>
                </button>
              )
            }
            if (item.kind === 'gapMarker') {
              const dynamicLabel = item.proposed
                ? `Shorten ${item.gap.toFixed(1)} second pause in preview`
                : item.shortened
                  ? `Restore or edit the ${item.targetGapMs ?? gapPacing.targetGapMs} millisecond pause`
                  : `Shorten ${item.gap.toFixed(1)} second pause`
              const dynamicText = item.proposed
                ? `${item.gap.toFixed(1)}s to ${gapPacing.targetGapMs}ms`
                : item.shortened
                  ? `${item.targetGapMs ?? gapPacing.targetGapMs}ms pause`
                  : `${item.gap.toFixed(1)}s pause`
              return (
                <button
                  type="button"
                  key={`gap-${key}`}
                  data-gap-after-word-id={item.wordId}
                  onClick={() => {
                    if (item.proposed) return
                    if (item.shortened) restoreGaps([item.wordId])
                    else shortenGaps([item.wordId])
                  }}
                  onContextMenu={(event) => openPointerMenu(
                    event,
                    { kind: 'gap', wordId: item.wordId },
                    `Actions for ${item.gap.toFixed(1)} second gap`,
                    item.wordId,
                  )}
                  onKeyDown={(event) => {
                    if (isContextMenuKey(event)) {
                      openKeyboardMenu(
                        event,
                        { kind: 'gap', wordId: item.wordId },
                        `Actions for ${item.gap.toFixed(1)} second gap`,
                        item.wordId,
                      )
                    }
                  }}
                  aria-haspopup="menu"
                  aria-expanded={contextMenu?.target.kind === 'gap' && contextMenu.target.wordId === item.wordId}
                  className={`mx-1 min-h-7 px-2 rounded-md text-[11px] font-medium align-middle border focus-visible:outline-none focus-visible:ring-2 ${
                    item.proposed
                      ? 'bg-plum-soft border-plum/40 text-plum-dark focus-visible:ring-plum'
                      : item.shortened
                        ? 'bg-forest-soft border-forest/30 text-forest-dark focus-visible:ring-forest'
                        : 'bg-ochre-soft border-ochre/25 text-ochre-dark hover:bg-ochre/15 focus-visible:ring-ochre'
                  }`}
                  aria-label={dynamicLabel}
                  title={dynamicLabel}
                >
                  {dynamicText}
                </button>
              )

            }

            const { word, idx } = item
            const selected = selection !== null && idx >= selection[0] && idx <= selection[1]
            const proposed = proposedWords.get(word.id)
            const editing = correction?.kind === 'word' && correction.id === word.id
            const classes = [
              'word-token rounded-[4px] px-[2px] outline-none',
              word.isRemoved
                ? word.isRetake
                  ? 'text-plum/55 hover:text-plum-dark/80'
                  : word.isFiller
                    ? 'text-ochre/60 hover:text-ochre-dark/85'
                    : 'text-ink-faint hover:text-ink-muted'
                : 'cursor-text hover:bg-canvas-soft',
              proposed
                ? proposed.isRetake
                  ? 'bg-plum/15 text-plum-dark ring-1 ring-inset ring-plum/40'
                  : 'bg-ochre/15 text-ochre-dark ring-1 ring-inset ring-ochre/35'
                : '',
              selected ? 'bg-ember/20 text-ink ring-1 ring-inset ring-ember/45' : '',
              activeWordIds.has(word.id)
                ? 'search-hit-active'
                : matchedWordIds.has(word.id)
                  ? 'search-hit'
                  : '',
            ].join(' ')

            return (
              <span key={word.id}>
                {editing ? (
                  <span className="inline-flex align-middle items-center gap-1 mx-0.5">
                    <EditIcon className="h-3.5 w-3.5 text-ember" />
                    <input
                      autoFocus
                      value={correction.text}
                      maxLength={500}
                      onChange={(event) => setCorrection({ kind: 'word', id: word.id, text: event.target.value })}
                      onFocus={(event) => event.currentTarget.select()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          correctWord(word.id, correction.text)
                          setCorrection(null)
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelCorrection.current = true
                          setCorrection(null)
                        }
                      }}
                      onBlur={() => {
                        if (!cancelCorrection.current) correctWord(word.id, correction.text)
                        cancelCorrection.current = false
                        setCorrection(null)
                      }}
                      className="h-8 min-w-20 max-w-64 rounded-md border border-ember/60 bg-canvas-raised px-2 text-[16px] leading-none text-ink shadow-lg shadow-ink/10 outline-none ring-2 ring-ember/15"
                      style={{ width: `${Math.min(16, Math.max(5, correction.text.length + 2))}ch` }}
                      aria-label={`Correct “${word.text}”`}
                    />
                  </span>
                ) : (
                  <span
                    ref={(element) => {
                      if (element) wordEls.current.set(word.id, element)
                      else wordEls.current.delete(word.id)
                    }}
                    role="button"
                    data-word-id={word.id}
                    tabIndex={idx === rovingIndex ? 0 : -1}
                    aria-pressed={selected}
                    aria-haspopup="menu"
                    aria-expanded={contextMenu?.target.kind === 'word' && contextMenu.target.wordId === word.id}
                    aria-label={`${word.text}${word.isRemoved ? ', removed; press Enter or Space to restore' : ', transcript word'}; Shift+F10 opens actions`}
                    className={classes}
                    onMouseDown={(event) => {
                      if (event.button !== 0) return
                      event.preventDefault()
                      event.currentTarget.focus()
                      if (word.isRemoved) { restoreWords([word.id]); return }
                      setDragging(true)
                      setSelection(idx, idx)
                    }}
                    onMouseEnter={() => {
                      if (dragging && selAnchor !== null) setSelection(selAnchor, idx)
                    }}
                    onDoubleClick={(event) => {
                      event.stopPropagation()
                      if (!word.isRemoved) {
                        beginCorrection(word)
                      }
                    }}
                    onContextMenu={(event) => openPointerMenu(
                      event,
                      { kind: 'word', wordId: word.id, idx },
                      `Actions for “${word.text}”`,
                      word.id,
                    )}
                    onKeyDown={(event) => {
                      if (isContextMenuKey(event)) {
                        openKeyboardMenu(
                          event,
                          { kind: 'word', wordId: word.id, idx },
                          `Actions for “${word.text}”`,
                          word.id,
                        )
                      } else if (event.key === 'S' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
                        event.preventDefault()
                        openSpeakerNaming(word.id)
                      } else if (word.isRemoved && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault()
                        restoreWords([word.id])
                      } else if (event.key === 'Enter') {
                        const span = times.get(word.id)
                        if (span) requestSeek(span.start, true)
                      } else if (event.key === 'F2') {
                        event.preventDefault()
                        beginCorrection(word)
                      } else if ((event.key === 'Backspace' || event.key === 'Delete') && !word.isRemoved) {
                        event.preventDefault()
                        const insideSelection = selection !== null && idx >= selection[0] && idx <= selection[1]
                        removeWords(insideSelection && selectedKeptIds.length > 1 ? selectedKeptIds : [word.id])
                      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                        event.preventDefault()
                        const direction = event.key === 'ArrowLeft' ? -1 : 1
                        const next = idx + direction
                        if (next >= 0 && next < words.length) focusWord(next)
                      }
                    }}
                    title={word.isRemoved
                      ? 'Click to restore · right-click for more actions'
                      : 'Click to seek · Alt-click to play · double-click to correct · right-click for actions'}
                  >
                    <span className={word.isRemoved ? 'line-through decoration-current/70' : ''}>{word.text}</span>
                    {word.isRemoved && !groupOf.has(word.id) && (
                      <span className="ml-1 inline-flex -translate-y-px items-center rounded border border-current/25 px-1 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide opacity-85 no-underline">
                        Restore
                      </span>
                    )}
                  </span>
                )}{' '}
              </span>
            )
          })}
          {words.length === 0 && insertClips.length === 0 && (
            <div className="rounded-2xl border border-dashed border-line-strong py-12 text-center">
              <AudioIcon className="h-6 w-6 mx-auto text-ink-faint mb-3" />
              <div className="text-sm text-ink-muted">No speech was detected.</div>
              <div className="text-xs text-ink-muted mt-1">The original audio is still preserved in the waveform and export.</div>
            </div>
          )}
        </article>
        {(words.length > 0 || insertClips.length > 0) && (
          <div className="max-w-[860px] mx-auto mt-7 pt-4 border-t border-line flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-muted">
            <span>Drag words, then press Backspace to ripple-cut</span>
            <span>F2 corrects text without changing audio</span>
            <span>Shift+F10 opens actions for the focused word</span>
            <span>Inserted audio is shown as an indigo transcript chip</span>
            <span>G shortens the pause at the playhead</span>
          </div>
        )}
      </div>
      {contextMenu && menuActions.length > 0 && (
        <TranscriptContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          label={contextMenu.label}
          actions={menuActions}
          onClose={closeContextMenu}
        />
      )}
      {namingSpeakerFor && (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-ink/25 p-4" role="presentation" onMouseDown={cancelSpeakerNaming}>
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-speaker-title"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                cancelSpeakerNaming()
              }
            }}
            onSubmit={(event) => {
              event.preventDefault()
              saveSpeakerNaming()
            }}
            className="w-full max-w-sm rounded-2xl border border-line-strong bg-canvas-raised p-5 shadow-2xl shadow-ink/20"
          >
            <h2 id="new-speaker-title" className="text-sm font-semibold text-ink">Name this speaker</h2>
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">
              The new speaker label will start at “{wordsById.get(namingSpeakerFor)?.text ?? 'this word'}”.
            </p>
            <label htmlFor="new-speaker-name" className="mt-4 block text-[12px] font-medium text-ink">Speaker name</label>
            <input
              ref={newSpeakerInputRef}
              id="new-speaker-name"
              value={newSpeakerName}
              onChange={(event) => setNewSpeakerName(event.target.value)}
              maxLength={80}
              autoComplete="off"
              className="mt-1.5 h-10 w-full rounded-lg border border-line-strong bg-canvas px-3 text-sm text-ink outline-none placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-ember"
              placeholder="For example, Alex"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={cancelSpeakerNaming} className="h-9 rounded-lg px-3 text-[12px] font-medium text-ink-muted hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember">
                Cancel
              </button>
              <button type="submit" disabled={!newSpeakerName.trim()} className="h-9 rounded-lg bg-ember px-3.5 text-[12px] font-semibold text-ink-inverse hover:bg-ember-dark disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember">
                Create and assign
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
