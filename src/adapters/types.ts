/**
 * The seam between "what version comes next" and "where versions live".
 *
 * The arithmetic in `version-from-commits.ts` was already ecosystem-agnostic;
 * everything that made the original release script npm-only was this — reading
 * `package.json`, writing eight of them, and keeping `bun.lock` in step. An
 * adapter is that knowledge and nothing more:
 *
 *   1. read the version the repository is at now,
 *   2. write a new one,
 *   3. say which files that touched.
 *
 * Point three is not decoration. The npm adapter's most important write is not
 * a manifest at all — it is eight lines of `bun.lock`, and the release that
 * shipped without them put seven packages on the registry declaring dependency
 * ranges that could not resolve. A `Change[]` that names every file is what
 * makes `--dry-run` a real answer rather than a summary of the interesting
 * half.
 */

import type { Target } from '../registry'

export type { Target } from '../registry'

export const ADAPTER_IDS = ['js', 'cargo'] as const
export type AdapterId = (typeof ADAPTER_IDS)[number]

/**
 * One file the adapter looked at.
 *
 * `unchanged` and `absent` are reported, not filtered. A dry run that lists
 * only what moved cannot distinguish "the lockfile is already in step" from
 * "the lockfile was never considered", and those failed differently once.
 */
export interface Change {
  /** Repo-relative, forward slashes, on every platform. */
  file: string
  state: 'updated' | 'unchanged' | 'absent'
  /** `1.2.3 -> 1.3.0`, `8 workspace entries`, `left alone: …` — for the log. */
  detail: string
}

export interface WriteOptions {
  root: string
  version: string
  /**
   * Write nothing and run nothing — but still return the full `Change[]`. A
   * dry run that reports less than the real one is not a preview of it.
   */
  dryRun: boolean
}

export interface Adapter {
  readonly id: AdapterId
  /** The manifest whose presence means this adapter applies. Repo-relative. */
  readonly manifest: string
  /** The version the repository is at now. Throws if the manifest cannot be read. */
  readVersion(root: string): Promise<string>
  /** Write `version` everywhere this ecosystem keeps one. */
  setVersion(options: WriteOptions): Promise<Change[]>
  /**
   * Everything this repository would publish, and under what name.
   *
   * Fourth thing an adapter knows, and the one that is not about files: which
   * registry entries a release is a promise about. `registry.ts` asks each of
   * them whether it exists yet, because a package that does not cannot be
   * published by a trusted publisher — and finding that out after the tag is
   * how a version number gets permanently spent.
   */
  publishTargets(root: string): Promise<Target[]>
}

/** Anything an adapter throws to say "this repository is not shaped as expected". */
export class AdapterError extends Error {}
