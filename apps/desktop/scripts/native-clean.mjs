// apps/desktop/scripts/native-clean.mjs
//
// Todo 25: removes the node-gyp build output so the next `native:build` is
// deterministic. Fails hard on non-Windows / non-x64 to keep the release
// contract consistent (a native clean on the wrong platform would mask a
// misconfigured release runner).
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const NATIVE = join(HERE, '..', 'native', 'windows')

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('[native-clean] ERROR: native clean requires Windows x64')
  process.exit(1)
}

rmSync(join(NATIVE, 'build'), { recursive: true, force: true })
console.log('[native-clean] OK: removed native/windows/build')
