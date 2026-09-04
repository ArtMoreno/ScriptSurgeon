import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveOpenTimelineSize, resolveTimelineSize, resolveWorkspaceTheme, restoredTimelineSize } from './workspacePreferences.ts'

test('workspace theme accepts only explicit safe choices and defaults to dark', () => {
  assert.equal(resolveWorkspaceTheme('light'), 'light')
  assert.equal(resolveWorkspaceTheme('dark'), 'dark')
  assert.equal(resolveWorkspaceTheme(null), 'dark')
  assert.equal(resolveWorkspaceTheme('system'), 'dark')
})

test('timeline size preserves valid preferences and migrates the legacy toggle compactly', () => {
  assert.equal(resolveTimelineSize('normal', 'true'), 'normal')
  assert.equal(resolveTimelineSize('compact', 'true'), 'compact')
  assert.equal(resolveTimelineSize('minimized', 'false'), 'minimized')
  assert.equal(resolveTimelineSize(null, 'true'), 'minimized')
  assert.equal(resolveTimelineSize(null, 'false'), 'compact')
  assert.equal(resolveTimelineSize('oversized', null), 'compact')
  assert.equal(restoredTimelineSize('minimized'), 'compact')
  assert.equal(restoredTimelineSize('normal'), 'normal')
  assert.equal(resolveOpenTimelineSize('normal', 'minimized'), 'normal')
  assert.equal(resolveOpenTimelineSize('compact', 'normal'), 'compact')
  assert.equal(resolveOpenTimelineSize(null, 'normal'), 'normal')
  assert.equal(resolveOpenTimelineSize(null, 'minimized'), 'compact')
})
