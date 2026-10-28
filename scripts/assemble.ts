import { assembleModules, buildAssembly } from './module-assembly'

async function main() {
  const args = process.argv.slice(2)
  const value = (flag: string) => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1] }
  if (args.includes('--help')) {
    console.log('npm run modules:assemble -- --modules base|all|payroll,records [--out build/assembled/name] [--build]')
    return
  }
  for (let at = 0; at < args.length; at++) {
    if (args[at] === '--build') continue
    if (['--modules', '--out'].includes(args[at]) && args[at + 1] && !args[at + 1].startsWith('--')) { at++; continue }
    throw new Error(`Unknown or incomplete assembly argument: ${args[at]}. See --help.`)
  }
  const selection = value('--modules')
  if (!selection) throw new Error('Explicit --modules base, all, or a comma-separated selection is required.')
  const result = await assembleModules({ selection, output: value('--out') })
  console.log(`Assembled ${result.sourceFiles} source files with add-ons: ${result.modules.join(', ') || 'none'}\n${result.output}`)
  if (args.includes('--build')) await buildAssembly(result.output)
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Assembly failed.'); process.exitCode = 1 })
