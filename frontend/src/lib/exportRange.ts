/** Bounds are in edited seconds; blank end means the end of the project. */
export function resolveExportRange(start: string, end: string, duration: number): { start: number; end: number } | null {
  const from = Number(start)
  const to = end.trim() ? Number(end) : duration
  return Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to - from >= 0.01 && to <= duration
    ? { start: from, end: to }
    : null
}
