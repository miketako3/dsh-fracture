/**
 * Probe workspace isolation.
 *
 * A probe compares two runs of the same task, so both sides need the same
 * starting files and neither may see the other's edits. Copying a checkout
 * together with its `node_modules` would dominate probe cost, so heavy
 * directories are excluded from the copy and symlinked back in.
 */

import { access, cp, mkdir, rm, symlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** Directories copied as symlinks instead of content. */
export const LINKED_DIRECTORIES = ['node_modules', '.git', '.venv', 'venv'] as const

/** Directories skipped entirely: build output and local caches. */
export const SKIPPED_DIRECTORIES = ['dist', 'build', 'out', '.next', '.turbo', 'target', 'coverage', '.cache'] as const

const LINKED = new Set<string>(LINKED_DIRECTORIES)
const SKIPPED = new Set<string>(SKIPPED_DIRECTORIES)

/** What one isolation produced. */
export interface IsolatedWorkspace {
  readonly dir: string
  readonly linked: readonly string[]
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Copy a workspace for one probe side.
 * @param source - absolute directory to copy.
 * @param destination - absolute directory to create; removed first when present.
 * @param excludedAbsolute - directories to skip by absolute path (the loop's own base).
 * @returns the created directory and the names reattached as symlinks.
 */
export async function isolateWorkspace(
  source: string,
  destination: string,
  excludedAbsolute: readonly string[] = [],
): Promise<IsolatedWorkspace> {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })

  const excluded = new Set(excludedAbsolute)
  await cp(source, destination, {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: false,
    filter: (from) => {
      if (excluded.has(from)) return false
      const name = basename(from)
      if (SKIPPED.has(name)) return false
      if (LINKED.has(name)) return false
      return true
    },
  })

  const linked: string[] = []
  for (const name of LINKED_DIRECTORIES) {
    const origin = join(source, name)
    if (!(await exists(origin))) continue
    const target = join(destination, name)
    if (await exists(target)) continue
    try {
      await symlink(origin, target, 'dir')
      linked.push(name)
    } catch {
      // A symlink failure degrades the probe, not the loop: the copy still runs.
    }
  }

  return { dir: destination, linked }
}
