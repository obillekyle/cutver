import { cargoAdapter } from './cargo'
import { jsAdapter } from './js'
import { ADAPTER_IDS, type Adapter, type AdapterId } from './types'

export * from './types'
export { cargoAdapter } from './cargo'
export { jsAdapter } from './js'

export const ADAPTERS: Record<AdapterId, Adapter> = {
  js: jsAdapter,
  cargo: cargoAdapter,
}

/**
 * Which adapters could handle this repository, by manifest presence.
 *
 * Returns every match rather than the first, because a repository with both a
 * `Cargo.toml` and a `package.json` — a Rust crate with a Node wrapper, a
 * napi-rs binding, a tauri app — is common enough that guessing would
 * eventually bump the wrong file. The caller asks for `--adapter` instead; a
 * question is cheaper than a wrong version in a published manifest.
 */
export async function applicableAdapters(root: string): Promise<AdapterId[]> {
  const found: AdapterId[] = []
  for (const id of ADAPTER_IDS) {
    if (await Bun.file(`${root}/${ADAPTERS[id].manifest}`).exists()) found.push(id)
  }
  return found
}
