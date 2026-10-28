import { moduleManifests } from './module-manifests'
import { excludedModules } from '@/assembly/excluded'

const omittedRoutes = excludedModules.flatMap(module => module.paths).map(path =>
  new RegExp('^' + path.split(':ledgerId').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '(?:/|$)'))

export const isExcludedModulePath = (pathname: string) => omittedRoutes.some(pattern => pattern.test(pathname))

const publicRoutes = moduleManifests.flatMap(manifest => manifest.publicRoutes ?? []).map(pattern => new RegExp(pattern, 'i'))
export const isPublicModulePath = (pathname: string) => publicRoutes.some(pattern => pattern.test(pathname))
