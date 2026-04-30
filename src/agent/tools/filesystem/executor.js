import { handleReadFile } from "./handlers/read.js";
import { handleListDir } from "./handlers/list.js";
import { handleFindFile } from "./handlers/find.js";
import { handleOutlineFile } from "./handlers/outline.js";
import {
  handleWriteFile,
  handlePatchFile,
  handleMoveFile,
  handleDeleteFile,
  handleRevertFile,
  handleApplyDiff,
} from "./handlers/mutations.js";
import { createToolDispatcher } from "../dispatcher.js";

const filesystemHandlers = {
  read_file: handleReadFile,
  write_file: handleWriteFile,
  patch_file: handlePatchFile,
  apply_diff: handleApplyDiff,
  list_dir: handleListDir,
  find_file: handleFindFile,
  delete_file: handleDeleteFile,
  move_file: handleMoveFile,
  revert_file: handleRevertFile,
  outline_file: handleOutlineFile,
};

export const executeFilesystemTool = createToolDispatcher(filesystemHandlers);
