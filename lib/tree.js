/** 极简目录树：给验收与报告用，输出受条目上限约束。 */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_IGNORE = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.next', '.cache'])

export function buildTree(root, { maxEntries = 200, maxDepth = 4, ignore = DEFAULT_IGNORE } = {}) {
  const entries = []
  const stack = [{ dir: root, depth: 0, prefix: '' }]
  while (stack.length > 0 && entries.length < maxEntries) {
    const { dir, depth, prefix } = stack.pop()
    if (depth > maxDepth) continue
    let children
    try {
      children = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      if (entries.length >= maxEntries) break
      if (ignore.has(child.name)) continue
      const rel = prefix.length > 0 ? `${prefix}/${child.name}` : child.name
      const isDir = child.isDirectory()
      let size
      try {
        if (!isDir) size = statSync(path.join(dir, child.name)).size
      } catch {
        size = undefined
      }
      entries.push({ path: rel, type: isDir ? 'dir' : 'file', size })
      if (isDir) stack.push({ dir: path.join(dir, child.name), depth: depth + 1, prefix: rel })
    }
  }
  return { root, entries, truncated: entries.length >= maxEntries }
}