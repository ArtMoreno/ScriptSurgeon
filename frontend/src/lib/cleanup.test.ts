import assert from 'node:assert/strict'
import test from 'node:test'
import type { Word } from '../types.ts'
import { CLEANUP_BENCHMARK } from './cleanup.benchmark.ts'
import {
  applyCleanupProposals,
  canonicalizeRetakeCandidateAttempts,
  retakeWordGroupsAreDisjoint,
  describeEmptyGapReview,
  runCleanup,
  selectRetakeCandidate,
  withCleanupSelection,
} from './cleanup.ts'

function materializeWords(tuples: typeof CLEANUP_BENCHMARK[number]['words']): Word[] {
  let cursor = 0
  return tuples.map(([id, text, durationMs, gapAfterMs]) => {
    const startTime = cursor / 1000
    const endTime = (cursor + durationMs) / 1000
    cursor += durationMs + gapAfterMs
    return {
      id,
      text,
      startTime,
      endTime,
      gapAfter: gapAfterMs / 1000,
      isFiller: false,
      isRetake: false,
      isRemoved: false,
    }
  })
}

function proposalKey(proposal: { gapWordId?: string; wordIds: string[] }): string {
  return proposal.gapWordId ?? proposal.wordIds.join(',')
}

function removedIds(words: Word[]): string[] {
  return words.filter((word) => word.isRemoved).map((word) => word.id)
}

test('long retakes preserve complete attempts and exclude the next sentence', () => {
  const phrase = 'The defense needs to win the ball back before the final whistle.'
  const length = phrase.split(' ').length
  const words = materializeWords([...phrase.split(' '), ...phrase.split(' '), 'Next', 'topic.'].map((text, i) =>
    [`long${i}`, text, 100, i === length - 1 ? 1800 : 50]))
  const result = runCleanup('retakes', words, [], [], [], [])
  assert.equal(result.proposals.length, 1)
  const proposal = result.proposals[0]
  assert.deepEqual(proposal.retakeGroup?.candidates.map(c => c.wordIds), [words.slice(0, length), words.slice(length, 2 * length)].map(t => t.map(w => w.id)))
  assert.deepEqual(result.selectedProposalIds, [])
  for (const candidate of proposal.retakeGroup!.candidates) {
    const selected = selectRetakeCandidate(result, proposal.id, candidate.id)
    const kept = selected.words.filter(w => !w.isRemoved).map(w => w.text).join(' ')
    assert.equal(kept, `${phrase} Next topic.`)
  }
})

test('spoken correction markers respect quoted content and protected words', () => {
  const text = 'The opening needs energy take two The opening needs energy.'
  const words = materializeWords(text.split(' ').map((token, i) => [`mark${i}`, token, 100, 50]))
  assert.equal(runCleanup('retakes', words, [], [], [], []).proposals.length, 1)
  assert.deepEqual(runCleanup('retakes', words, [], [], ['mark1'], []).proposals, [])
  const quoted = words.map((w, i) => ({ ...w, text: i === 0 ? `“${w.text}` : i === words.length - 1 ? `${w.text}”` : w.text }))
  assert.deepEqual(runCleanup('retakes', quoted, [], [], [], []).proposals, [])
})

test('rapid retakes do not merge distinct restarts across a sentence or long pause', () => {
  const tokens = "Downhill. He's willing to tackle, he's willing to tackle. But at safety, but at safety, sometimes".split(' ')
  const words = materializeWords(tokens.map((text, i) => [`separate${i}`, text, 150, i === 4 || i === 11 ? 400 : i === 8 ? 7000 : 50]))
  const result = runCleanup('retakes', words, [], [], [], [])
  assert.equal(result.proposals.length, 2)
  assert.deepEqual(result.proposals[0].retakeGroup?.candidates.map(c => c.transcript), ["He's willing to tackle,", "he's willing to tackle."])
  assert.ok(result.proposals.every(p => !p.retakeGroup?.candidates.some(c => c.wordIds.includes(words[0].id))))
})

test('an exact restart without silence keeps the repeated opening word on the correct take', () => {
  const words = materializeWords("You don't get, you don't get voted captain.".split(' ').map((text, i) =>
    [`opening${i}`, text, 150, i === 2 ? 0 : 50]))
  const result = runCleanup('retakes', words, [], [], [], [])
  assert.equal(result.proposals.length, 1)
  assert.deepEqual(result.proposals[0].wordIds, words.slice(0, 3).map(w => w.id))
  assert.equal(result.proposals[0].retakeGroup?.candidates[1].transcript, "you don't get")
})

test('long incomplete revisions keep the full later ending and honor review safeguards', () => {
  const first = 'The most useful thing we can do is give each person a clear task,'
  const last = 'The most useful thing we can do is give each person a clear task before we begin.'
  const words = materializeWords(`${first} ${last}`.split(' ').map((text, i) => [`clause${i}`, text, 180, 80]))
  const result = runCleanup('retakes', words, [], [], [], [])
  const proposal = result.proposals.find(p => p.reason.includes('inner restart'))!
  assert.ok(proposal)
  assert.deepEqual(result.selectedProposalIds, [])
  assert.equal(proposal.retakeGroup!.candidates[1].transcript, last)
  const selected = selectRetakeCandidate(result, proposal.id, proposal.retakeGroup!.candidates[1].id)
  assert.equal(selected.words.filter(w => !w.isRemoved).map(w => w.text).join(' '), last)
  for (const candidate of proposal.retakeGroup!.candidates) {
    assert.ok(!runCleanup('retakes', words, [], [], [candidate.wordIds[0]], []).proposals.some(p => p.reason.includes('inner restart')))
  }
  const secondStart = first.split(' ').length
  const options = { speakerByWord: { [words[0].id]: 'a', [words[secondStart].id]: 'b' } }
  assert.deepEqual(runCleanup('retakes', words, [], [], [], [], options).proposals, [])
  const complete = words.map((w, i) => ({ ...w, text: i === secondStart - 1 ? 'task.' : w.text }))
  assert.ok(!runCleanup('retakes', complete, [], [], [], []).proposals.some(p => p.reason.includes('inner restart')))
})

test('cleanup benchmark is exact, conservative, and input-immutable', () => {
  for (const fixture of CLEANUP_BENCHMARK) {
    const words = materializeWords(fixture.words)
    const before = structuredClone(words)
    const result = runCleanup(fixture.kind, words, [], [], [], [], fixture.options)
    const proposalKeys = result.proposals.map(proposalKey)
    const selectedKeys = result.proposals
      .filter((proposal) => result.selectedProposalIds.includes(proposal.id))
      .map(proposalKey)

    assert.deepEqual(proposalKeys, fixture.expectedProposalKeys, `${fixture.id}: proposal keys`)
    assert.deepEqual(selectedKeys, fixture.expectedSelectedKeys, `${fixture.id}: default selections`)
    assert.deepEqual(words, before, `${fixture.id}: detection must not mutate transcript words`)

    const applied = applyCleanupProposals(
      fixture.kind,
      words,
      [],
      [],
      result.proposals,
      result.selectedProposalIds,
    )
    const appliedKeys = result.proposals
      .filter((proposal) => applied.appliedProposalIds.includes(proposal.id))
      .map(proposalKey)
    assert.deepEqual(appliedKeys, fixture.expectedSelectedKeys, `${fixture.id}: applied proposal keys`)

    if (fixture.kind === 'gaps') {
      assert.deepEqual(applied.shortenedGapIds, fixture.expectedSelectedKeys, `${fixture.id}: shortened gaps`)
    } else {
      assert.deepEqual(removedIds(applied.words), fixture.expectedSelectedKeys.flatMap((key) => key.split(',')), `${fixture.id}: removed words`)
    }

    // Applying the same reviewed proposal twice is a no-op; it cannot re-cut
    // content after the first application changed the source word snapshot.
    const second = applyCleanupProposals(
      fixture.kind,
      applied.words,
      applied.shortenedGapIds,
      applied.collapsedRetakes,
      result.proposals,
      result.selectedProposalIds,
    )
    assert.deepEqual(second.appliedProposalIds, [], `${fixture.id}: repeated apply is idempotent`)

    if (fixture.expectedProposalKeys.length) {
      const protectedWordIds = fixture.retakeGroundTruth
        ? fixture.retakeGroundTruth.candidateWordIds.flat()
        : fixture.expectedProposalKeys.flatMap((key) => key.split(','))
      const protectedResult = runCleanup(
        fixture.kind,
        words,
        [],
        [],
        fixture.kind === 'gaps' ? [] : protectedWordIds,
        fixture.kind === 'gaps' ? fixture.expectedProposalKeys : [],
        fixture.options,
      )
      assert.deepEqual(protectedResult.proposals, [], `${fixture.id}: explicit keep suppresses the same suggestion`)
    }

    if (fixture.retakeGroundTruth) {
      assert.equal(result.proposals.length, 1, `${fixture.id}: one merged alternate-take group`)
      const proposal = result.proposals[0]
      const group = proposal.retakeGroup
      assert.ok(group, `${fixture.id}: reviewable candidates are present`)
      assert.deepEqual(
        group!.candidates.map((candidate) => candidate.wordIds),
        fixture.retakeGroundTruth.candidateWordIds,
        `${fixture.id}: chronological candidate ground truth`,
      )
      const recommended = group!.candidates[fixture.retakeGroundTruth.recommendedCandidateIndex]
      assert.equal(
        group!.recommendedCandidateId,
        recommended.id,
        `${fixture.id}: recommendation must follow editorial ground truth`,
      )

      const selected = selectRetakeCandidate(result, proposal.id, recommended.id)
      const chosen = applyCleanupProposals(
        'retakes',
        words,
        [],
        [],
        selected.proposals,
        selected.selectedProposalIds,
        selected.retakeCandidateChoices,
      )
      assert.deepEqual(
        removedIds(chosen.words),
        fixture.retakeGroundTruth.expectedRemovedWhenKeepingRecommendation,
        `${fixture.id}: choosing the recommended take removes only the alternate attempts`,
      )
    }
  }
})

test('selection preview can include a review-only suggestion without changing the source', () => {
  const fixture = CLEANUP_BENCHMARK.find((candidate) => candidate.id === 'contextual_like')!
  const words = materializeWords(fixture.words)
  const result = runCleanup('fillers', words, [], [])
  const selected = withCleanupSelection(result, [result.proposals[0].id])

  assert.equal(selected.words.find((word) => word.id === 'fl3')?.isRemoved, true)
  assert.equal(words.find((word) => word.id === 'fl3')?.isRemoved, false)
  assert.deepEqual(selected.selectedSummary, { fillers: 1, gaps: 0, retakes: 0 })
})

test('a stale proposal never overwrites a manually corrected word', () => {
  const fixture = CLEANUP_BENCHMARK.find((candidate) => candidate.id === 'clear_single_filler')!
  const preview = runCleanup('fillers', materializeWords(fixture.words), [], [])
  const manuallyCorrected = materializeWords(fixture.words).map((word) => word.id === 'cf2'
    ? { ...word, text: 'hmm' }
    : word)
  const applied = applyCleanupProposals('fillers', manuallyCorrected, [], [], preview.proposals, preview.selectedProposalIds)

  assert.deepEqual(applied.appliedProposalIds, [])
  assert.equal(applied.words.find((word) => word.id === 'cf2')?.text, 'hmm')
  assert.equal(applied.words.find((word) => word.id === 'cf2')?.isRemoved, false)
})

test('adjacent repeated attempts merge into one three-take choice', () => {
  const text = ['we', 'need', 'help', 'we', 'need', 'help', 'we', 'need', 'help']
  const words: Word[] = text.map((token, index) => {
    const take = Math.floor(index / 3)
    const offset = (index % 3) * 0.15
    const startTime = take * 2 + offset
    return {
      id: `tt${String(index).padStart(8, '0')}`.slice(-10),
      text: token,
      startTime,
      endTime: startTime + 0.1,
      gapAfter: index % 3 === 2 && index < text.length - 1 ? 1.6 : 0.05,
      isFiller: false,
      isRetake: false,
      isRemoved: false,
    }
  })
  const result = runCleanup('retakes', words, [], [])
  assert.equal(result.proposals.length, 1)
  const proposal = result.proposals[0]
  assert.equal(proposal.retakeGroup?.candidates.length, 3)
  assert.equal(proposal.retakeGroup?.recommendedCandidateId, proposal.retakeGroup?.candidates[2].id)

  const selected = selectRetakeCandidate(result, proposal.id, proposal.retakeGroup!.candidates[1].id)
  const applied = applyCleanupProposals(
    'retakes',
    words,
    [],
    [],
    selected.proposals,
    selected.selectedProposalIds,
    selected.retakeCandidateChoices,
  )
  const removed = applied.words.filter((word) => word.isRemoved).map((word) => word.id)
  assert.deepEqual(removed, [words[0].id, words[1].id, words[2].id, words[6].id, words[7].id, words[8].id])
})

test('overlapping pairwise windows collapse into disjoint physical retake attempts before apply', () => {
  const tokens = [
    ['we', 'need', 'help'],
    ['we', 'need', 'help', 'now'],
    ['need', 'help', 'now', 'soon'],
  ]
  let time = 0
  let ordinal = 0
  const words: Word[] = []
  for (let attempt = 0; attempt < tokens.length; attempt += 1) {
    for (let index = 0; index < tokens[attempt].length; index += 1) {
      const last = index === tokens[attempt].length - 1
      // The first substantial pause starts a new take. The short internal
      // restart makes the detector discover a prefix and a longer version of
      // the same physical attempt, which used to create overlapping candidates.
      const gapAfter = last ? (attempt === 0 ? 1.6 : attempt === 1 ? 0.25 : 0) : 0
      words.push({
        id: String(++ordinal).padStart(10, '0'),
        text: tokens[attempt][index],
        startTime: time,
        endTime: time + 0.1,
        gapAfter,
        isFiller: false,
        isRetake: false,
        isRemoved: false,
      })
      time += 0.1 + gapAfter
    }
  }

  const result = runCleanup('retakes', words, [], [])
  assert.equal(result.proposals.length, 1)
  const group = result.proposals[0].retakeGroup!
  assert.equal(retakeWordGroupsAreDisjoint(group.candidates.map((candidate) => candidate.wordIds)), true)
  assert.deepEqual(group.candidates.map((candidate) => candidate.wordIds), [
    words.slice(0, 3).map((word) => word.id),
    words.slice(3, 7).map((word) => word.id),
    words.slice(7).map((word) => word.id),
  ])

  const chosen = selectRetakeCandidate(result, result.proposals[0].id, group.candidates[1].id)
  const applied = applyCleanupProposals(
    'retakes',
    words,
    [],
    [],
    chosen.proposals,
    chosen.selectedProposalIds,
    chosen.retakeCandidateChoices,
  )
  assert.deepEqual(applied.appliedProposalIds, [result.proposals[0].id])
  assert.deepEqual(removedIds(applied.words), [
    ...words.slice(0, 3).map((word) => word.id),
    ...words.slice(7).map((word) => word.id),
  ])

  // The apply boundary remains defensive even if a stale/malformed preview
  // somehow reaches it: it must not create a state payload the backend will
  // reject.
  const malformed = {
    ...result.proposals[0],
    retakeGroup: {
      ...group,
      candidates: [
        group.candidates[0],
        { ...group.candidates[1], wordIds: [...group.candidates[0].wordIds, ...group.candidates[1].wordIds] },
      ],
    },
  }
  const blocked = applyCleanupProposals(
    'retakes',
    words,
    [],
    [],
    [malformed],
    [malformed.id],
    { [malformed.id]: malformed.retakeGroup.candidates[1].id },
  )
  assert.deepEqual(blocked.appliedProposalIds, [])
  assert.deepEqual(removedIds(blocked.words), [])
})

test('candidate canonicalization keeps one full chronological attempt for overlapping windows', () => {
  const words = materializeWords([
    ['oc1', 'first', 100, 50], ['oc2', 'attempt', 100, 50], ['oc3', 'here', 100, 1000],
    ['oc4', 'second', 100, 50], ['oc5', 'attempt', 100, 50], ['oc6', 'starts', 100, 50], ['oc7', 'and', 100, 50], ['oc8', 'finishes', 100, 1000],
    ['oc9', 'third', 100, 50], ['oc10', 'attempt', 100, 50], ['oc11', 'ends', 100, 0],
  ])
  const byId = new Map(words.map((word) => [word.id, word]))
  const raw = [
    ['oc1', 'oc2', 'oc3'],
    ['oc4', 'oc5', 'oc6'],
    ['oc4', 'oc5', 'oc6', 'oc7', 'oc8'],
    ['oc9', 'oc10', 'oc11'],
  ].map((wordIds, index) => {
    const selected = wordIds.map((id) => byId.get(id)!)
    return {
      id: `raw-${index}`,
      label: `Raw ${index}`,
      wordIds,
      startTime: selected[0].startTime,
      endTime: selected.at(-1)!.endTime,
      transcript: selected.map((word) => word.text).join(' '),
    }
  })

  const canonical = canonicalizeRetakeCandidateAttempts(words, [
    [raw[0], raw[2]],
    [raw[1], raw[3]],
  ])
  assert.equal(retakeWordGroupsAreDisjoint(canonical.map((candidate) => candidate.wordIds)), true)
  assert.deepEqual(canonical.map((candidate) => candidate.wordIds), [
    ['oc1', 'oc2', 'oc3'],
    ['oc4', 'oc5', 'oc6', 'oc7', 'oc8'],
    ['oc9', 'oc10', 'oc11'],
  ])
})

test('candidate canonicalization respects a later pair boundary through a bridge window', () => {
  const words = materializeWords([
    ['cc1', 'first', 100, 40], ['cc2', 'take', 100, 40], ['cc3', 'here', 100, 800],
    ['cc4', 'second', 100, 40], ['cc5', 'take', 100, 40], ['cc6', 'words', 100, 800],
    ['cc7', 'third', 100, 40], ['cc8', 'take', 100, 40], ['cc9', 'ends', 100, 0],
  ])
  const byId = new Map(words.map((word) => [word.id, word]))
  const candidate = (id: string, wordIds: string[]) => {
    const selected = wordIds.map((wordId) => byId.get(wordId)!)
    return {
      id,
      label: id,
      wordIds,
      startTime: selected[0].startTime,
      endTime: selected.at(-1)!.endTime,
      transcript: selected.map((word) => word.text).join(' '),
    }
  }
  const canonical = canonicalizeRetakeCandidateAttempts(words, [
    [candidate('A', ['cc1', 'cc2', 'cc3']), candidate('B-bridge', ['cc4', 'cc5', 'cc6', 'cc7', 'cc8'])],
    [candidate('B-prefix', ['cc4', 'cc5', 'cc6']), candidate('C', ['cc7', 'cc8', 'cc9'])],
  ])

  assert.equal(retakeWordGroupsAreDisjoint(canonical.map((item) => item.wordIds)), true)
  assert.deepEqual(canonical.map((item) => item.wordIds), [
    ['cc1', 'cc2', 'cc3'],
    ['cc4', 'cc5', 'cc6'],
    ['cc7', 'cc8', 'cc9'],
  ])
})

test('candidate canonicalization suppresses a malformed pair with overlapping choices', () => {
  const words = materializeWords([
    ['mc1', 'first', 100, 40], ['mc2', 'words', 100, 800],
    ['mc3', 'later', 100, 40], ['mc4', 'words', 100, 0],
  ])
  const candidate = (id: string, wordIds: string[]) => ({
    id,
    label: id,
    wordIds,
    startTime: words.find((word) => word.id === wordIds[0])!.startTime,
    endTime: words.find((word) => word.id === wordIds[wordIds.length - 1])!.endTime,
    transcript: wordIds.join(' '),
  })

  assert.deepEqual(canonicalizeRetakeCandidateAttempts(words, [[
    candidate('left', ['mc1', 'mc2', 'mc3']),
    candidate('right', ['mc3', 'mc4']),
  ]]), [])
})

test('ASR confidence only suppresses or downgrades lexical filler suggestions', () => {
  const fixture = CLEANUP_BENCHMARK.find((candidate) => candidate.id === 'clear_single_filler')!
  const lowConfidence = runCleanup('fillers', materializeWords(fixture.words), [], [], [], [], {
    wordConfidenceById: { cf2: 0.45 },
  })
  assert.deepEqual(lowConfidence.proposals, [])

  const reviewOnly = runCleanup('fillers', materializeWords(fixture.words), [], [], [], [], {
    wordConfidenceById: { cf2: 0.72 },
  })
  assert.equal(reviewOnly.proposals.length, 1)
  assert.equal(reviewOnly.proposals[0].confidence, 'medium')
  assert.deepEqual(reviewOnly.selectedProposalIds, [])
  assert.match(reviewOnly.proposals[0].reason, /ASR word confidence is 72%/)
  assert.match(reviewOnly.proposals[0].reason, /review-only/)

  const highConfidence = runCleanup('fillers', materializeWords(fixture.words), [], [], [], [], {
    wordConfidenceById: { cf2: 0.93 },
  })
  assert.equal(highConfidence.proposals[0].confidence, 'high')
  assert.deepEqual(highConfidence.selectedProposalIds, [highConfidence.proposals[0].id])
  assert.match(highConfidence.proposals[0].reason, /high ASR word confidence \(93%\)/)
})

test('retake candidates are review-first and can keep either alternate take', () => {
  const fixture = CLEANUP_BENCHMARK.find((candidate) => candidate.id === 'false_start')!
  const words = materializeWords(fixture.words)
  const result = runCleanup('retakes', words, [], [])
  const proposal = result.proposals[0]
  const group = proposal.retakeGroup

  assert.deepEqual(result.selectedProposalIds, [])
  assert.ok(group)
  assert.deepEqual(group.candidates.map((candidate) => candidate.wordIds), [
    ['fs1', 'fs2', 'fs3'],
    ['fs4', 'fs5', 'fs6'],
  ])
  assert.equal(group.recommendedCandidateId, group.candidates[1].id)

  // A checked proposal alone cannot make an editorial choice. It remains a
  // no-op until the caller records which take to keep.
  const noChoice = applyCleanupProposals('retakes', words, [], [], [proposal], [proposal.id])
  assert.deepEqual(noChoice.appliedProposalIds, [])
  assert.deepEqual(removedIds(noChoice.words), [])

  const chooseLater = selectRetakeCandidate(result, proposal.id, group.candidates[1].id)
  const recommended = applyCleanupProposals(
    'retakes',
    words,
    [],
    [],
    chooseLater.proposals,
    chooseLater.selectedProposalIds,
    chooseLater.retakeCandidateChoices,
  )
  assert.deepEqual(removedIds(recommended.words), ['fs1', 'fs2', 'fs3'])

  const chooseEarlier = selectRetakeCandidate(result, proposal.id, group.candidates[0].id)
  assert.deepEqual(chooseEarlier.selectedProposalIds, [proposal.id])
  assert.deepEqual(chooseEarlier.retakeCandidateChoices, { [proposal.id]: group.candidates[0].id })
  assert.deepEqual(removedIds(chooseEarlier.words), ['fs4', 'fs5', 'fs6'])
  assert.deepEqual(chooseEarlier.collapsedRetakes, [['fs4', 'fs5', 'fs6']])
})

test('retake alignment recognizes exact, revised, and sorry-marked restarts without auto-applying them', () => {
  const exact = CLEANUP_BENCHMARK.find((candidate) => candidate.id === 'exact_fast_sentence_restart')!
  const exactResult = runCleanup('retakes', materializeWords(exact.words), [], [])
  assert.deepEqual(exactResult.proposals[0].wordIds, ['ef1', 'ef2', 'ef3'])
  assert.deepEqual(exactResult.proposals[0].retakeGroup?.candidates[1].wordIds, ['ef4', 'ef5', 'ef6'])
  assert.deepEqual(exactResult.selectedProposalIds, [])

  const revision = CLEANUP_BENCHMARK.find((candidate) => candidate.id === 'punctuated_revision_after_pause')!
  const revisionResult = runCleanup('retakes', materializeWords(revision.words), [], [])
  assert.deepEqual(revisionResult.proposals[0].wordIds, ['pr1', 'pr2', 'pr3', 'pr4', 'pr5'])
  assert.match(revisionResult.proposals[0].reason, /aligns with a following retake/)
  assert.deepEqual(revisionResult.selectedProposalIds, [])

  const marker = CLEANUP_BENCHMARK.find((candidate) => candidate.id === 'sorry_marker_retake')!
  const markerResult = runCleanup('retakes', materializeWords(marker.words), [], [])
  assert.deepEqual(markerResult.proposals[0].wordIds, ['sm1', 'sm2', 'sm3', 'sm4', 'sm5', 'sm6'])
  assert.match(markerResult.proposals[0].reason, /sorry/)
  assert.deepEqual(markerResult.selectedProposalIds, [])

  const contraction = CLEANUP_BENCHMARK.find((candidate) => candidate.id === 'contraction_retake_after_pause')!
  const contractionResult = runCleanup('retakes', materializeWords(contraction.words), [], [])
  assert.deepEqual(contractionResult.proposals[0].wordIds, ['cr1', 'cr2', 'cr3', 'cr4'])

  const earlierComplete = CLEANUP_BENCHMARK.find((candidate) => candidate.id === 'earlier_complete_later_incomplete')!
  const earlierCompleteResult = runCleanup('retakes', materializeWords(earlierComplete.words), [], [])
  assert.equal(
    earlierCompleteResult.proposals[0].retakeGroup?.recommendedCandidateId,
    earlierCompleteResult.proposals[0].retakeGroup?.candidates[0].id,
    'A complete earlier take must beat an incomplete later restart',
  )
  assert.match(earlierCompleteResult.proposals[0].retakeGroup?.recommendationReason ?? '', /complete sentence ending/)

  const quoted = CLEANUP_BENCHMARK.find((candidate) => candidate.id === 'quoted_language_repeat')!
  const quotedResult = runCleanup('retakes', materializeWords(quoted.words), [], [])
  assert.deepEqual(quotedResult.proposals, [])
  assert.ok((quotedResult.retakeDiagnostics?.rejected['quoted-content-or-speaker-boundary'] ?? 0) > 0)
})

test('a partial overlap inside fluent continuation cannot steal a valid preceding retake', () => {
  const fixture = CLEANUP_BENCHMARK.find((candidate) => candidate.id === 'continuous_overlap_after_retake')!
  const result = runCleanup('retakes', materializeWords(fixture.words), [], [])

  assert.deepEqual(result.proposals.map((proposal) => proposal.wordIds), [['co1', 'co2', 'co3']])
  // The accepted take may carry on to a complete ending; only the earlier
  // aligned attempt is removable.
  assert.deepEqual(result.proposals[0].retakeGroup?.candidates[1].wordIds, ['co4', 'co5', 'co6', 'co7'])
})

test('even high-confidence retakes are never preselected without a take choice', () => {
  const words = materializeWords([
    ['hr1', 'We', 80, 50], ['hr2', 'need', 100, 50], ['hr3', 'help', 100, 1900],
    ['hr4', 'We', 80, 50], ['hr5', 'need', 100, 50], ['hr6', 'help', 100, 0],
  ])
  const result = runCleanup('retakes', words, [], [])

  assert.equal(result.proposals[0].confidence, 'high')
  assert.ok(result.proposals[0].retakeGroup)
  assert.deepEqual(result.selectedProposalIds, [])
  assert.deepEqual(removedIds(result.words), [])
})

test('an empty retake review records count-only rejection evidence', () => {
  const fixture = CLEANUP_BENCHMARK.find((candidate) => candidate.id === 'intentional_repetition')!
  const result = runCleanup('retakes', materializeWords(fixture.words), [], [])

  assert.deepEqual(result.proposals, [])
  assert.ok(result.retakeDiagnostics)
  assert.equal(result.retakeDiagnostics?.analyzedWordCount, fixture.words.length)
  assert.ok((result.retakeDiagnostics?.candidateWindows ?? 0) > 0)
  assert.ok((result.retakeDiagnostics?.rejected['insufficient-paused-alignment'] ?? 0) > 0)
  assert.equal(result.retakeDiagnostics?.groups, 0)
})

test('an empty gap review explains which long pauses were held back and why', () => {
  // "done." then a 1.6s pause: over the threshold, but a sentence end, so the
  // detector declines it. The old copy claimed no long gaps existed at all.
  const words: Word[] = [
    { id: 'g1', text: 'all', startTime: 0, endTime: 0.3, isRemoved: false, isFiller: false },
    { id: 'g2', text: 'done.', startTime: 0.3, endTime: 0.6, isRemoved: false, isFiller: false },
    { id: 'g3', text: 'next', startTime: 2.2, endTime: 2.5, isRemoved: false, isFiller: false },
  ]
  const result = runCleanup('gaps', words, [], [])

  assert.deepEqual(result.proposals, [])
  assert.equal(result.gapDiagnostics?.overThreshold, 1)
  assert.equal(result.gapDiagnostics?.skipped.sentenceBoundary, 1)

  const copy = describeEmptyGapReview(result.gapDiagnostics!, 800)
  assert.match(copy, /1 long pause was left alone on purpose/)
  assert.match(copy, /1 at a sentence end/)
})

test('a gap review with no long pauses at all names the detection threshold', () => {
  const words: Word[] = [
    { id: 's1', text: 'tight', startTime: 0, endTime: 0.3, isRemoved: false, isFiller: false },
    { id: 's2', text: 'copy', startTime: 0.5, endTime: 0.8, isRemoved: false, isFiller: false },
  ]
  const result = runCleanup('gaps', words, [], [])

  assert.equal(result.gapDiagnostics?.overThreshold, 0)
  assert.match(describeEmptyGapReview(result.gapDiagnostics!, 800), /longer than 800ms/)
})
