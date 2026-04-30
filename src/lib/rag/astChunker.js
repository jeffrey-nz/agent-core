import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Php from "tree-sitter-php";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import Rust from "tree-sitter-rust";

const parsers = {
  ".js": JavaScript,
  ".jsx": JavaScript,
  ".ts": JavaScript,
  ".tsx": JavaScript,
  ".php": Php.php,
  ".py": Python,
  ".go": Go,
  ".rs": Rust,
};

export function chunkFileWithAST(filepath, content) {
  const ext = filepath.match(/\.[^.]+$/)?.[0];
  const lang = parsers[ext];

  if (!lang) {
    return [
      {
        type: "file",
        name: filepath,
        content: content.slice(0, 8000),
      },
    ];
  }

  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(content);
  const chunks = [];

  function traverse(node) {
    if (
      node.type.includes("function") ||
      node.type.includes("class") ||
      node.type.includes("method") ||
      node.type === "struct_type" ||
      node.type === "impl_item"
    ) {
      const nameNode = node.children.find(
        (c) =>
          c.type === "identifier" ||
          c.type === "name" ||
          c.type === "type_identifier",
      );
      const name = nameNode ? nameNode.text : "anonymous";

      chunks.push({
        type: node.type,
        name: name,
        content: node.text,
      });
      return;
    }

    for (const child of node.children) {
      traverse(child);
    }
  }

  traverse(tree.rootNode);

  if (chunks.length === 0) {
    chunks.push({ type: "file", name: filepath, content });
  }

  return chunks;
}
