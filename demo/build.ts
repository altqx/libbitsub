import { cp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const demoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)))
const repoRoot = resolve(join(demoRoot, '..'))
const outputRoot = join(demoRoot, 'dist')
const registryPackage = join(repoRoot, 'node_modules', 'libbitsub-registry')
const registryVersion = '1.12.0'
const registryMetadata = JSON.parse(await Bun.file(join(registryPackage, 'package.json')).text())

if (registryMetadata.version !== registryVersion) {
  throw new Error(`Expected registry libbitsub ${registryVersion}, found ${registryMetadata.version}`)
}

const wasmPackage = join(registryPackage, 'pkg')

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })

for (const file of ['index.html', 'styles.css', 'app.js', 'fixtures.js']) {
  await cp(join(demoRoot, file), join(outputRoot, file))
}

await cp(wasmPackage, join(outputRoot, 'pkg'), { recursive: true })

const libraryOutput = join(outputRoot, 'libbitsub')
await mkdir(libraryOutput, { recursive: true })
const libraryBuild = await Bun.build({
  entrypoints: [join(registryPackage, 'dist', 'index.js')],
  outfile: join(libraryOutput, 'index.js'),
  format: 'esm',
  target: 'browser',
  minify: false
})
if (!libraryBuild.success) {
  throw new Error(libraryBuild.logs.map((log) => log.message).join('\n'))
}
const libraryArtifact = libraryBuild.outputs[0]
if (!libraryArtifact) throw new Error('Bun did not produce a browser library bundle')
await Bun.write(join(libraryOutput, 'index.js'), await libraryArtifact.arrayBuffer())
await cp(join(wasmPackage, 'libbitsub_bg.wasm'), join(libraryOutput, 'libbitsub_bg.wasm'))

const assetsRoot = join(outputRoot, 'assets')
await mkdir(assetsRoot, { recursive: true })
for (const file of ['vobsub.idx', 'vobsub.sub', 'vobsub.mks']) {
  const sourcePath = join(repoRoot, 'src', 'testfiles', file)
  if (file === 'vobsub.mks') {
    const source = new Uint8Array(await Bun.file(sourcePath).arrayBuffer())
    const demoAsset = new Uint8Array(source.length + 1)
    demoAsset.set(source)
    await Bun.write(join(assetsRoot, file), demoAsset)
  } else {
    await cp(sourcePath, join(assetsRoot, file))
  }
}

console.log(`Demo assets prepared in ${outputRoot} using libbitsub ${registryVersion} from npm`)
