/** Public-but-non-UI build data for local support diagnostics. */
export const frontendBuildIdentity = {
  version: import.meta.env.VITE_SCRIPTSURGEON_BUILD_VERSION || 'development',
  commit: import.meta.env.VITE_SCRIPTSURGEON_BUILD_COMMIT || 'working-tree',
}
