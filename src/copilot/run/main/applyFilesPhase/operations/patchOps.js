import fs from "node:fs/promises";
import path from "node:path";
import { validateFileTarget } from "./validator.js";
import { fuzzyReplace } from "./pathUtils.js";
import { sanitizeCode } from "./sanitize.js";

export async function applyPatchOperations(rootDir, patches, result, allowedDirs = [], dryRun = false) {
  for (const patch of patches) {
    if (!validateFileTarget(rootDir, patch.filePath, "patch", result, allowedDirs)) continue;

    const absPath = path.resolve(rootDir, patch.filePath);

    if (dryRun) {
      result.stdout += `[DRY RUN] Would patch file: ${absPath}\n`;
      result.applied++;
      continue;
    }
    try {
      let fileContent = await fs.readFile(absPath, "utf8");
      fileContent = sanitizeCode(fileContent);

      const cleanOldBlock = sanitizeCode(patch.oldBlock).trimEnd();
      const cleanNewBlock = sanitizeCode(patch.newBlock).trimEnd();

      if (!cleanOldBlock && patch.oldBlock !== "") {
        result.errors.push(`Validation Error: search_block is empty.`);
        result.status = 1;
        continue;
      }

      // Count occurrences of the search block to give better feedback
      const countOccurrences = (haystack, needle) => {
        if (!needle) return 0;
        let count = 0;
        let idx = haystack.indexOf(needle);
        while (idx !== -1) { count++; idx = haystack.indexOf(needle, idx + needle.length); }
        return count;
      };

      if (fileContent.includes(cleanOldBlock)) {
        if (patch.replaceAll) {
          fileContent = fileContent.split(cleanOldBlock).join(cleanNewBlock);
        } else {
          const occurrences = countOccurrences(fileContent, cleanOldBlock);
          if (occurrences > 1) {
            // Ambiguous — multiple identical blocks. Fail with a helpful hint.
            result.errors.push(
              `Failed to patch ${patch.filePath}: search_block matches ${occurrences} locations in the file.\n` +
              `HINT: Your search_block is not unique — it matches the same content in ${occurrences} different places.\n` +
              `FIX: Expand your search_block to include MORE surrounding context lines (add the lines before/after the target section) until the search_block is unique.\n` +
              `If you want to replace ALL occurrences at once, add "replace_all": true to the patch_file call.`,
            );
            result.status = 1;
            continue;
          }
          const idx = fileContent.indexOf(cleanOldBlock);
          fileContent =
            fileContent.slice(0, idx) +
            cleanNewBlock +
            fileContent.slice(idx + cleanOldBlock.length);
        }

        await fs.writeFile(absPath, fileContent, "utf8");
        result.stdout += `Successfully patched (exact match): ${absPath}\n`;
        result.applied++;
        continue;
      }

      const fuzzyContent = fuzzyReplace(
        fileContent,
        cleanOldBlock,
        cleanNewBlock,
      );
      if (fuzzyContent) {
        await fs.writeFile(absPath, fuzzyContent, "utf8");
        result.stdout += `Successfully patched (fuzzy match): ${absPath}\n`;
        result.applied++;
        continue;
      }

      const strippedFile = fileContent.replace(/\s+/g, "");
      const strippedSearch = cleanOldBlock.replace(/\s+/g, "");

      if (strippedFile.includes(strippedSearch)) {
        result.errors.push(
          `Failed to patch ${patch.filePath}: The code exists, but your search_block has incorrect indentation or invisible character mismatches. \n` +
            `HINT: Ensure you match the file's use of TABS vs SPACES exactly, or provide more unique context lines.`,
        );
      } else {
        // Check if whitespace-normalized version matches multiple times (different formatting)
        const fuzzyOccurrences = countOccurrences(strippedFile, strippedSearch);
        if (fuzzyOccurrences > 1) {
          result.errors.push(
            `Failed to patch ${patch.filePath}: search_block (after ignoring whitespace) matches ${fuzzyOccurrences} locations.\n` +
            `HINT: There appear to be duplicate code blocks in this file. Your search_block matches the same logic in ${fuzzyOccurrences} places.\n` +
            `FIX: Expand your search_block to include surrounding unique context lines that exist only near the section you want to change.`,
          );
        } else {
          result.errors.push(
            `Failed to patch ${patch.filePath}: search_block not found. \n` +
              `HINT: The code you are trying to replace might have been modified or doesn't exist in this version of the file.`,
          );
        }
      }
      result.status = 1;
    } catch (err) {
      if (err.code === "ENOENT" && patch.oldBlock.trim() === "") {
        if (dryRun) {
          result.stdout += `[DRY RUN] Would create new file: ${absPath}\n`;
          result.applied++;
        } else {
          await fs.mkdir(path.dirname(absPath), { recursive: true });
          await fs.writeFile(absPath, sanitizeCode(patch.newBlock), "utf8");
          result.stdout += `Created new file: ${absPath}\n`;
          result.applied++;
        }
      } else {
        result.errors.push(`File error on ${patch.filePath}: ${err.message}`);
        result.status = 1;
      }
    }
  }
}
