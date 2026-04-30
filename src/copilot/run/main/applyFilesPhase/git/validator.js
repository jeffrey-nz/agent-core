import { log } from "#app/ui/log.js";

export function validateModifications(statusOut, scriptOutput, projectDir) {
  const isVendorChange = scriptOutput?.includes("/vendor/");
  const isAssetsChange = scriptOutput?.includes("/Assets/");

  if (!statusOut.trim()) {
    if (isVendorChange || isAssetsChange) {
      log(
        `  💡 Note: Change applied to a directory that may be ignored by Git (${isVendorChange ? "vendor" : "Assets"}). Skipping Git verification.`,
      );
      return { ok: true };
    }

    const msg = `Applied changes, but Git detected NO modifications in: ${projectDir}. 
This usually means the AI wrote to a hallucinated path, an ignored file, or a location outside the repository. 
Verify your absolute paths and ensure the file is not listed in .gitignore.`;

    return { ok: true, note: msg };
  }

  return { ok: true };
}
