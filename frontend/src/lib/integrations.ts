import { create } from 'zustand'

import { api } from './api.ts'
import type { IntegrationTarget } from '../types'

/**
 * The delivery targets this build can produce, fetched once at startup.
 *
 * An unreachable route must degrade to "no extra targets" rather than blocking
 * the export control the user already had.
 */
interface IntegrationStore {
  targets: IntegrationTarget[]
  loaded: boolean
  load: () => Promise<void>
}

export const useIntegrations = create<IntegrationStore>((set) => ({
  targets: [],
  loaded: false,

  load: async () => {
    try {
      const { targets } = await api.getIntegrations()
      set({ targets: Array.isArray(targets) ? targets : [], loaded: true })
    } catch {
      set({ targets: [], loaded: true })
    }
  },
}))

/** The optgroup the served targets live under in the export picker. */
export const HANDOFF_GROUP = 'Handoff'

export interface ExportOption {
  id: string
  label: string
  group: string
  /** Present only for served targets; the built-in choices carry their own. */
  target?: IntegrationTarget
}

/**
 * Merge served targets into the built-in export choices.
 *
 * Kept pure and separate from the component so the ordering is testable
 * without mounting the toolbar.
 */
export function mergeExportOptions<T extends { id: string; label: string; group: string }>(
  builtIn: readonly T[],
  targets: readonly IntegrationTarget[],
): Array<T | ExportOption> {
  return [
    ...builtIn,
    ...targets.map((target) => ({
      id: `handoff:${target.id}`,
      label: target.label,
      group: HANDOFF_GROUP,
      target,
    })),
  ]
}

/** Groups to render, omitting Handoff entirely when nothing is served. */
export function exportGroups(base: readonly string[], targets: readonly IntegrationTarget[]): string[] {
  return targets.length ? [...base, HANDOFF_GROUP] : [...base]
}

export function targetFromOptionId(
  optionId: string,
  targets: readonly IntegrationTarget[],
): IntegrationTarget | null {
  if (!optionId.startsWith('handoff:')) return null
  const id = optionId.slice('handoff:'.length)
  return targets.find((target) => target.id === id) ?? null
}
