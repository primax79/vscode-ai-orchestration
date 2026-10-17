import * as fs from 'fs';
import * as path from 'path';

function findFrontendDist() {
  // 1. Direct sibling: ../ai-orchestration-ui/frontend/dist
  const directSibling = path.resolve(process.cwd(), '../ai-orchestration-ui/frontend/dist');
  if (fs.existsSync(directSibling)) {
    return directSibling;
  }

  // 2. Search upward in case running inside a worktree or subfolder
  let current = process.cwd();
  while (true) {
    const candidate = path.resolve(current, '../ai-orchestration-ui/frontend/dist');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

const distSource = findFrontendDist();
if (!distSource) {
  console.error('Error: Sibling frontend dist not found at ../ai-orchestration-ui/frontend/dist.');
  console.error('Build it first: cd ../ai-orchestration-ui/frontend && npm run build');
  process.exit(1);
}

const targetDir = path.resolve(process.cwd(), 'dist-webview');
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// Clear target directory and copy
fs.rmSync(targetDir, { recursive: true, force: true });
fs.cpSync(distSource, targetDir, { recursive: true });

console.log(`Synced webview assets from ${distSource} to ${targetDir}`);
