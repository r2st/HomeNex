// Module-loader hooks that let `node --test` import the app's real source.
//
// Vite normally handles two things Node can't: JSX syntax and `import './x.css'`.
// Without them, component files are simply unimportable from a test, which is why
// the UI suite could only ever cover plain-JS helpers in src/lib. These hooks close
// that gap using esbuild (already present as a Vite dependency), so no new package
// is added to the project.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'
import { transformSync } from 'esbuild'

const JSX = /\.jsx(\?|$)/
const STYLE = /\.(css|scss|sass|less)(\?|$)/

registerHooks({
  load(url, context, nextLoad) {
    if (STYLE.test(url)) {
      // Stylesheets carry no behaviour worth testing; stub them so importing a
      // component that pulls in CSS doesn't explode.
      return { format: 'module', shortCircuit: true, source: 'export default {}' }
    }
    if (!JSX.test(url)) return nextLoad(url, context)

    const filename = fileURLToPath(url)
    const { code } = transformSync(readFileSync(filename, 'utf8'), {
      loader: 'jsx',
      format: 'esm',
      target: 'node20',
      jsx: 'automatic',
      sourcefile: filename,
      sourcemap: 'inline',
    })
    return { format: 'module', shortCircuit: true, source: code }
  },
})
