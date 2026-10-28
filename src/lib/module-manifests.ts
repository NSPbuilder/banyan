import { moduleManifests } from '@/assembly/catalog'
export { moduleManifests }

export const installedAddonIds = new Set(moduleManifests.map(manifest => manifest.id))
export const defaultDisabledSeats = new Set(moduleManifests.flatMap(manifest => [...manifest.defaultDisabledSeats ?? []]))

/** Preserve the established UI/prompt order while each owner supplies its rows. */
export function orderedModuleItems<T>(items: ReadonlyArray<T & { order: number }>): T[] {
  return [...items].sort((a, b) => a.order - b.order).map(item => {
    const { order, ...value } = item
    void order
    return value as T
  })
}
