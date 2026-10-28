import { verifyDependencyPatches } from './dependency-patches'

const checks = verifyDependencyPatches()
console.log(`PASS ${checks} dependency patch checks: upstream compatibility, bounded nesting, cycles, traversal work and installed integrity`)
