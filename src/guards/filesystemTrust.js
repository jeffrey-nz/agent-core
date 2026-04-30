export function assertFilesystemTrust(projectConfig) {
  if (projectConfig.requiresFilesystem) {
    return {
      allowPasteFallback: false,
      message:
        "Filesystem is trusted. Do not request file pastes for existing files.",
    };
  }

  return { allowPasteFallback: true };
}
