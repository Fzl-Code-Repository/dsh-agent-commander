/** 路径小工具：~ 展开、profile 目录定位、数据目录。 */
import os from 'node:os'
import path from 'node:path'

export function expandHome(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/** DSH profile 目录：优先 DSH_PROFILE_DIR，其次 DSH_HOME/profiles/<DSH_PROFILE>。 */
export function profileDir() {
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.length > 0) {
    return process.env.DSH_PROFILE_DIR
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
}

/** 插件数据目录：<profile>/agent-commander。 */
export function dataDir(config) {
  if (typeof config?.dataDir === 'string' && config.dataDir.length > 0) return expandHome(config.dataDir)
  return path.join(profileDir(), 'agent-commander')
}

export function resolveLocalPath(base, value) {
  return path.isAbsolute(value) ? value : path.resolve(base, value)
}