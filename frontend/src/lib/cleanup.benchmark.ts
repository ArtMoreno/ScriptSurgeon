import type { CleanupKind, CleanupOptions } from './cleanup'

export type CleanupBenchmarkTuple = [id: string, text: string, durationMs: number, gapAfterMs: number]

/**
 * Machine-readable editorial ground truth for a reviewable alternate-take
 * group.  The benchmark never assumes automatic removal: the test selects
 * the recommended candidate explicitly before it checks the expected cuts.
 */
export interface RetakeBenchmarkGroundTruth {
  candidateWordIds: string[][]
  recommendedCandidateIndex: number
  expectedRemovedWhenKeepingRecommendation: string[]
}

export interface CleanupBenchmarkCase {
  id: string
  kind: CleanupKind
  tags: string[]
  words: CleanupBenchmarkTuple[]
  options?: CleanupOptions
  /** Each value is a gap anchor or a comma-separated word group. */
  expectedProposalKeys: string[]
  expectedSelectedKeys: string[]
  /** Present when a fixture defines a reviewable alternate-take ground truth. */
  retakeGroundTruth?: RetakeBenchmarkGroundTruth
}

/**
 * Deterministic, data-only decision corpus. Timings are generated from each
 * tuple so start/end and gapAfter can never disagree in a fixture.
 */
export const CLEANUP_BENCHMARK: CleanupBenchmarkCase[] = [
  {
    id: 'clean_quick',
    kind: 'fillers',
    tags: ['clean', 'quick', 'safety'],
    words: [['cq1', 'We', 110, 70], ['cq2', 'ship', 120, 60], ['cq3', 'today.', 140, 0]],
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'noise_low_confidence_uh',
    kind: 'fillers',
    tags: ['noise-proxy', 'low-confidence', 'safety'],
    words: [['bn1', 'I', 110, 70], ['bn2', 'uh', 100, 70], ['bn3', 'agree.', 170, 0]],
    options: { wordConfidenceById: { bn2: 0.31 }, speechProbabilityById: { bn2: 0.42 } },
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'clear_single_filler',
    kind: 'fillers',
    tags: ['filler-positive'],
    words: [['cf1', 'Well', 140, 60], ['cf2', 'um', 100, 60], ['cf3', 'I', 80, 60], ['cf4', 'agree.', 160, 0]],
    expectedProposalKeys: ['cf2'],
    expectedSelectedKeys: ['cf2'],
  },
  {
    id: 'filler_phrase',
    kind: 'fillers',
    tags: ['filler-positive', 'phrase', 'review-only'],
    words: [['fp1', 'It', 90, 60], ['fp2', 'is', 80, 60], ['fp3', 'you', 100, 50], ['fp4', 'know', 130, 60], ['fp5', 'hard.', 140, 0]],
    expectedProposalKeys: ['fp3,fp4'],
    expectedSelectedKeys: [],
  },
  {
    id: 'semantic_you_know',
    kind: 'fillers',
    tags: ['filler-negative', 'meaningful-phrase', 'safety'],
    words: [['uy1', 'You', 120, 60], ['uy2', 'know', 130, 60], ['uy3', 'the', 80, 60], ['uy4', 'answer.', 160, 0]],
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'meaningful_like',
    kind: 'fillers',
    tags: ['filler-negative', 'meaningful-like', 'safety'],
    words: [['ml1', 'I', 80, 60], ['ml2', 'like', 110, 60], ['ml3', 'coffee.', 160, 0]],
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'contextual_like',
    kind: 'fillers',
    tags: ['filler-positive', 'context-sensitive', 'review-only'],
    words: [['fl1', 'It', 80, 60], ['fl2', 'was', 100, 60], ['fl3', 'like', 110, 60], ['fl4', 'really', 150, 60], ['fl5', 'loud.', 130, 0]],
    expectedProposalKeys: ['fl3'],
    expectedSelectedKeys: [],
  },
  {
    id: 'clean_slow',
    kind: 'gaps',
    tags: ['clean', 'slow', 'safety'],
    words: [['cs1', 'This', 270, 850], ['cs2', 'needs', 290, 930], ['cs3', 'careful', 380, 840], ['cs4', 'review.', 360, 0]],
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'meaningful_pause',
    kind: 'gaps',
    tags: ['gap-negative', 'sentence-boundary', 'safety'],
    words: [['mp1', 'Let', 100, 60], ['mp2', 'that', 110, 60], ['mp3', 'sink', 120, 60], ['mp4', 'in.', 90, 1800], ['mp5', 'Now', 100, 60], ['mp6', 'continue.', 160, 0]],
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'speaker_change_pause',
    kind: 'gaps',
    tags: ['gap-negative', 'speaker-change', 'safety'],
    words: [['sp1', 'Could', 100, 60], ['sp2', 'you', 100, 1200], ['sp3', 'answer', 130, 60], ['sp4', 'that?', 130, 0]],
    options: { speakerByWord: { sp2: 'speaker-a', sp3: 'speaker-b' } },
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'run_start_speaker_change_gap',
    kind: 'gaps',
    tags: ['gap-negative', 'speaker-run-start', 'safety'],
    words: [['rsg1', 'I', 100, 60], ['rsg2', 'agree', 100, 1300], ['rsg3', 'but', 120, 60], ['rsg4', 'noted.', 140, 0]],
    // Speaker state is stored only where each run begins. The long pause is
    // between an unmarked continuation word and the next run's marker.
    options: { speakerByWord: { rsg1: 'speaker-a', rsg3: 'speaker-b' } },
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'shortenable_gap',
    kind: 'gaps',
    tags: ['gap-positive'],
    words: [['sg1', 'We', 90, 60], ['sg2', 'should', 140, 1100], ['sg3', 'begin', 130, 60], ['sg4', 'now.', 100, 0]],
    expectedProposalKeys: ['sg2'],
    expectedSelectedKeys: ['sg2'],
  },
  {
    id: 'false_start',
    kind: 'retakes',
    tags: ['retake-positive', 'false-start', 'review-only'],
    words: [['fs1', 'I', 80, 60], ['fs2', 'need', 130, 60], ['fs3', 'to', 80, 240], ['fs4', 'we', 90, 60], ['fs5', 'need', 130, 60], ['fs6', 'to', 80, 60], ['fs7', 'leave.', 140, 0]],
    expectedProposalKeys: ['fs1,fs2,fs3'],
    expectedSelectedKeys: [],
  },
  {
    id: 'exact_fast_sentence_restart',
    kind: 'retakes',
    tags: ['retake-positive', 'exact-repeat', 'fast-restart', 'punctuation', 'review-only'],
    words: [
      ['ef1', 'We', 80, 50], ['ef2', 'need', 100, 50], ['ef3', 'help.', 100, 220],
      ['ef4', 'We', 80, 50], ['ef5', 'need', 100, 50], ['ef6', 'help.', 100, 0],
    ],
    expectedProposalKeys: ['ef1,ef2,ef3'],
    expectedSelectedKeys: [],
  },
  {
    id: 'contraction_retake_after_pause',
    kind: 'retakes',
    tags: ['retake-positive', 'contraction', 'punctuation', 'paused-repeat', 'review-only'],
    words: [
      ['cr1', "Don't", 90, 50], ['cr2', 'lose', 100, 50], ['cr3', 'your', 80, 50], ['cr4', 'focus.', 110, 1900],
      ['cr5', "Don't", 90, 50], ['cr6', 'lose', 100, 50], ['cr7', 'your', 80, 50], ['cr8', 'focus.', 110, 0],
    ],
    expectedProposalKeys: ['cr1,cr2,cr3,cr4'],
    expectedSelectedKeys: [],
  },
  {
    id: 'earlier_complete_later_incomplete',
    kind: 'retakes',
    tags: ['retake-positive', 'recommend-earlier', 'sentence-completeness', 'review-only'],
    words: [
      ['ec1', 'We', 90, 50], ['ec2', 'need', 100, 50], ['ec3', 'the', 70, 50], ['ec4', 'blue', 90, 50], ['ec5', 'version.', 110, 1900],
      ['ec6', 'We', 90, 50], ['ec7', 'need', 100, 50], ['ec8', 'the', 70, 50], ['ec9', 'blue', 90, 0],
    ],
    expectedProposalKeys: ['ec1,ec2,ec3,ec4,ec5'],
    expectedSelectedKeys: [],
  },
  {
    id: 'quoted_language_repeat',
    kind: 'retakes',
    tags: ['retake-negative', 'quoted-language', 'safety'],
    words: [
      ['ql1', '"We', 90, 50], ['ql2', 'need', 100, 50], ['ql3', 'help', 90, 50], ['ql4', 'now."', 110, 1900],
      ['ql5', '"We', 90, 50], ['ql6', 'need', 100, 50], ['ql7', 'help', 90, 50], ['ql8', 'now."', 110, 0],
    ],
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'punctuated_revision_after_pause',
    kind: 'retakes',
    tags: ['retake-positive', 'partial-overlap', 'punctuation', 'paused-revision', 'review-only'],
    words: [
      ['pr1', 'I', 80, 50], ['pr2', 'need', 100, 50], ['pr3', 'the', 80, 50], ['pr4', 'blue', 100, 50], ['pr5', 'version.', 120, 1900],
      ['pr6', 'I', 80, 50], ['pr7', 'need', 100, 50], ['pr8', 'the', 80, 50], ['pr9', 'red', 100, 50], ['pr10', 'version.', 120, 0],
    ],
    expectedProposalKeys: ['pr1,pr2,pr3,pr4,pr5'],
    expectedSelectedKeys: [],
  },
  {
    id: 'sorry_marker_retake',
    kind: 'retakes',
    tags: ['retake-positive', 'spoken-marker', 'sorry', 'partial-overlap', 'review-only'],
    words: [
      ['sm1', 'I', 80, 50], ['sm2', 'need', 100, 50], ['sm3', 'the', 80, 50], ['sm4', 'blue', 100, 50], ['sm5', 'version.', 120, 90],
      ['sm6', 'Sorry,', 100, 90],
      ['sm7', 'I', 80, 50], ['sm8', 'need', 100, 50], ['sm9', 'the', 80, 50], ['sm10', 'red', 100, 50], ['sm11', 'version.', 120, 0],
    ],
    expectedProposalKeys: ['sm1,sm2,sm3,sm4,sm5,sm6'],
    expectedSelectedKeys: [],
  },
  {
    id: 'intentional_repetition',
    kind: 'retakes',
    tags: ['retake-negative', 'intentional-repetition', 'safety'],
    words: [['ir1', 'We', 90, 60], ['ir2', 'will', 100, 60], ['ir3', 'win.', 100, 1600], ['ir4', 'We', 90, 60], ['ir5', 'will', 100, 60], ['ir6', 'win.', 100, 0]],
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'continuous_overlap_after_retake',
    kind: 'retakes',
    tags: ['retake-positive', 'overlap-safety', 'review-only'],
    words: [
      ['co1', 'we', 90, 50], ['co2', 'need', 100, 50], ['co3', 'clarity', 120, 1600],
      ['co4', 'we', 90, 50], ['co5', 'need', 100, 50], ['co6', 'clarity', 120, 50], ['co7', 'finish', 110, 0],
    ],
    expectedProposalKeys: ['co1,co2,co3'],
    expectedSelectedKeys: [],
  },
  {
    id: 'run_start_speaker_change_retake',
    kind: 'retakes',
    tags: ['retake-negative', 'speaker-run-start', 'safety'],
    words: [
      ['rsr1', 'We', 90, 60], ['rsr2', 'need', 100, 60], ['rsr3', 'help', 110, 60], ['rsr4', 'now', 100, 1900],
      ['rsr5', 'We', 90, 60], ['rsr6', 'need', 100, 60], ['rsr7', 'help', 110, 60], ['rsr8', 'now.', 100, 0],
    ],
    // A repeated phrase spoken by a new speaker is a handoff, not a retake.
    options: { speakerByWord: { rsr1: 'speaker-a', rsr5: 'speaker-b' } },
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'semantic_again',
    kind: 'retakes',
    tags: ['retake-negative', 'marker-safety', 'safety'],
    words: [['sa1', 'I', 80, 60], ['sa2', 'will', 100, 60], ['sa3', 'try', 90, 60], ['sa4', 'again', 120, 60], ['sa5', 'tomorrow.', 170, 0]],
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'spoken_marker_retake',
    kind: 'retakes',
    tags: ['retake-positive', 'spoken-marker', 'review-only'],
    words: [['rm1', 'The', 80, 60], ['rm2', 'opening', 160, 60], ['rm3', 'needs', 120, 60], ['rm4', 'energy', 140, 80], ['rm5', 'take', 100, 50], ['rm6', 'two', 100, 80], ['rm7', 'The', 80, 60], ['rm8', 'opening', 160, 60], ['rm9', 'needs', 120, 60], ['rm10', 'energy.', 140, 0]],
    expectedProposalKeys: ['rm1,rm2,rm3,rm4,rm5,rm6'],
    expectedSelectedKeys: [],
  },
  {
    id: 'corrected_name_after_sorry',
    kind: 'retakes',
    tags: ['retake-positive', 'spoken-marker', 'correction', 'name', 'review-only'],
    words: [
      ['cn1', 'The', 80, 50], ['cn2', 'presenter', 120, 50], ['cn3', 'is', 70, 50], ['cn4', 'Casey.', 100, 80],
      ['cn5', 'Sorry,', 100, 80],
      ['cn6', 'The', 80, 50], ['cn7', 'presenter', 120, 50], ['cn8', 'is', 70, 50], ['cn9', 'Kasey.', 100, 0],
    ],
    expectedProposalKeys: ['cn1,cn2,cn3,cn4,cn5'],
    expectedSelectedKeys: [],
  },
  {
    id: 'corrected_number_after_sorry',
    kind: 'retakes',
    tags: ['retake-positive', 'spoken-marker', 'correction', 'number', 'review-only'],
    words: [
      ['nu1', 'The', 80, 50], ['nu2', 'reference', 120, 50], ['nu3', 'number', 100, 50], ['nu4', 'is', 70, 50], ['nu5', 'forty-two.', 120, 80],
      ['nu6', 'Sorry,', 100, 80],
      ['nu7', 'The', 80, 50], ['nu8', 'reference', 120, 50], ['nu9', 'number', 100, 50], ['nu10', 'is', 70, 50], ['nu11', 'twenty-four.', 120, 0],
    ],
    expectedProposalKeys: ['nu1,nu2,nu3,nu4,nu5,nu6'],
    expectedSelectedKeys: [],
  },
  {
    id: 'again_filler_marked_retry',
    kind: 'retakes',
    tags: ['retake-positive', 'spoken-marker', 'again', 'filler', 'review-only'],
    words: [
      ['ag1', 'Um,', 70, 50], ['ag2', 'The', 80, 50], ['ag3', 'total', 100, 50], ['ag4', 'number', 110, 50], ['ag5', 'is', 70, 50], ['ag6', 'forty-two.', 120, 70],
      ['ag7', 'Again,', 80, 50], ['ag8', 'sorry,', 80, 60],
      ['ag9', 'The', 80, 50], ['ag10', 'total', 100, 50], ['ag11', 'number', 110, 50], ['ag12', 'is', 70, 50], ['ag13', 'twenty-four.', 120, 0],
    ],
    expectedProposalKeys: ['ag1,ag2,ag3,ag4,ag5,ag6,ag7,ag8'],
    expectedSelectedKeys: [],
  },
  {
    id: 'repeated_list_structure',
    kind: 'retakes',
    tags: ['retake-negative', 'list-structure', 'intentional-repetition', 'safety'],
    words: [
      ['ls1', 'Item', 80, 50], ['ls2', 'one', 80, 50], ['ls3', 'is', 70, 50], ['ls4', 'ready.', 90, 1800],
      ['ls5', 'Item', 80, 50], ['ls6', 'two', 80, 50], ['ls7', 'is', 70, 50], ['ls8', 'ready.', 90, 1800],
      ['ls9', 'Item', 80, 50], ['ls10', 'three', 90, 50], ['ls11', 'is', 70, 50], ['ls12', 'ready.', 90, 0],
    ],
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'same_phrase_much_later',
    kind: 'retakes',
    tags: ['retake-negative', 'outside-window', 'same-phrase', 'safety'],
    words: [
      ['lt1', 'This', 80, 50], ['lt2', 'plan', 80, 50], ['lt3', 'needs', 100, 50], ['lt4', 'review.', 100, 6100],
      ['lt5', 'This', 80, 50], ['lt6', 'plan', 80, 50], ['lt7', 'needs', 100, 50], ['lt8', 'review.', 100, 0],
    ],
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'capitalization_only_restart',
    kind: 'retakes',
    tags: ['retake-positive', 'capitalization', 'normalization', 'review-only'],
    words: [
      ['ca1', 'PLEASE', 80, 50], ['ca2', 'SEND', 80, 50], ['ca3', 'THE', 70, 50], ['ca4', 'REPORT.', 100, 1800],
      ['ca5', 'Please', 80, 50], ['ca6', 'send', 80, 50], ['ca7', 'the', 70, 50], ['ca8', 'report.', 100, 0],
    ],
    expectedProposalKeys: ['ca1,ca2,ca3,ca4'],
    expectedSelectedKeys: [],
  },
  {
    id: 'minor_asr_token_error_restart',
    kind: 'retakes',
    tags: ['retake-positive', 'minor-asr-error', 'partial-alignment', 'review-only'],
    words: [
      ['as1', 'We', 80, 50], ['as2', 'need', 80, 50], ['as3', 'the', 70, 50], ['as4', 'revised', 100, 50], ['as5', 'document.', 110, 1800],
      ['as6', 'We', 80, 50], ['as7', 'need', 80, 50], ['as8', 'the', 70, 50], ['as9', 'revised', 100, 50], ['as10', 'documint.', 110, 0],
    ],
    expectedProposalKeys: ['as1,as2,as3,as4,as5'],
    expectedSelectedKeys: [],
  },
  {
    id: 'single_word_stutter',
    kind: 'retakes',
    tags: ['retake-negative', 'single-word-stutter', 'safety'],
    words: [
      ['st1', 'I', 80, 40], ['st2', 'I', 80, 40], ['st3', 'I', 80, 40], ['st4', 'want', 90, 40], ['st5', 'to', 70, 40], ['st6', 'continue.', 110, 0],
    ],
    expectedProposalKeys: [],
    expectedSelectedKeys: [],
  },
  {
    id: 'three_attempt_complete_middle_ground_truth',
    kind: 'retakes',
    tags: ['retake-positive', 'three-attempt', 'ground-truth', 'recommendation', 'review-only'],
    words: [
      ['ta1', 'We', 80, 50], ['ta2', 'need', 80, 50], ['ta3', 'the', 70, 50], ['ta4', 'blue', 80, 1800],
      ['tb1', 'We', 80, 50], ['tb2', 'need', 80, 50], ['tb3', 'the', 70, 50], ['tb4', 'blue', 80, 50], ['tb5', 'version.', 100, 1800],
      ['tc1', 'We', 80, 50], ['tc2', 'need', 80, 50], ['tc3', 'the', 70, 50], ['tc4', 'blue', 80, 0],
    ],
    expectedProposalKeys: ['ta1,ta2,ta3,ta4,tc1,tc2,tc3,tc4'],
    expectedSelectedKeys: [],
    retakeGroundTruth: {
      candidateWordIds: [
        ['ta1', 'ta2', 'ta3', 'ta4'],
        ['tb1', 'tb2', 'tb3', 'tb4', 'tb5'],
        ['tc1', 'tc2', 'tc3', 'tc4'],
      ],
      recommendedCandidateIndex: 1,
      expectedRemovedWhenKeepingRecommendation: ['ta1', 'ta2', 'ta3', 'ta4', 'tc1', 'tc2', 'tc3', 'tc4'],
    },
  },
]
