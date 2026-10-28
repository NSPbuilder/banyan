'use strict';

// Local GHSA-vfj7-8cjw-p6xm mitigation. Validate iteratively before recursion.
// Parent/prev metadata are deliberately ignored; only child edges are walked.
const MAX_DEPTH = 128;
const MAX_NODES = 200000;
const refuse = (code, message) => { const error = new Error(message); error.code = code; throw error; };

const guard = ast => {
  const stack = [{ node: ast, depth: 0, exit: false }];
  const ancestors = new Set();
  let visits = 0;
  let scheduled = 1;
  while (stack.length) {
    const { node, depth, exit } = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (exit) { ancestors.delete(node); continue; }
    if (depth > MAX_DEPTH) refuse('ERR_BRACES_DEPTH_LIMIT', 'Brace AST exceeds the safe nesting limit');
    if (++visits > MAX_NODES) refuse('ERR_BRACES_NODE_LIMIT', 'Brace AST exceeds the safe traversal limit');
    if (ancestors.has(node)) refuse('ERR_BRACES_CYCLE', 'Brace AST contains a child cycle');
    ancestors.add(node);
    stack.push({ node, depth, exit: true });
    if (Array.isArray(node.nodes)) {
      // Bound queued work as well: wide children at successive levels must
      // not allocate an oversized stack before the visit budget is reached.
      if (node.nodes.length > MAX_NODES - scheduled) refuse('ERR_BRACES_NODE_LIMIT', 'Brace AST exceeds the safe traversal limit');
      scheduled += node.nodes.length;
      for (let i = node.nodes.length - 1; i >= 0; i--) stack.push({ node: node.nodes[i], depth: depth + 1, exit: false });
    }
  }
  return ast;
};
module.exports = guard;
module.exports.MAX_DEPTH = MAX_DEPTH;
module.exports.MAX_NODES = MAX_NODES;
