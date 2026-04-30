import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export function logOperationStats(executionOps) {
  log(`\n${colors.cyan("🧠 Thought Log:")} Applying Operations:`);
  if (executionOps.files?.length > 0)
    log(`  - ${executionOps.files.length} write_file call(s)`);
  if (executionOps.patches?.length > 0)
    log(`  - ${executionOps.patches.length} patch_file call(s)`);
  if (executionOps.moves?.length > 0)
    log(`  - ${executionOps.moves.length} move_file call(s)`);
  if (executionOps.deletes?.length > 0)
    log(`  - ${executionOps.deletes.length} delete_file call(s)`);
}
