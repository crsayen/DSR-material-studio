// Copies the browser libraries the editor imports (three.js, three-mesh-bvh, three-gpu-pathtracer)
// into src/wwwroot/vendor so the app works offline and is served from the exe. Only the modules
// actually reachable from the app's imports are copied: esbuild traces them (its metafile) and
// the files are copied as they are, so the page keeps using plain ES modules through its import map.
//
//   cd web-libs && npm install && npm run vendor
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const out = resolve(here, '..', 'src', 'wwwroot', 'vendor');
const entry = join(here, 'entry.js');
// What the app imports from the libraries (keep in step with src/wwwroot/js/*.js).
writeFileSync(entry, `
export * as THREE from 'three';
export { OrbitControls } from 'three/addons/controls/OrbitControls.js';
export { WebGLPathTracer } from 'three-gpu-pathtracer';
export { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
`);
const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, metafile: true, absWorkingDir: here, logLevel: 'warning' });
rmSync(entry);
const files = Object.keys(result.metafile.inputs).filter(f => f.startsWith('node_modules/'));
rmSync(out, { recursive: true, force: true });
const pkgs = new Set();
for (const f of files) {
  const rel = f.slice('node_modules/'.length);
  pkgs.add(rel.split('/')[0]);
  const dest = join(out, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(here, f), dest);
}
const versions = {};
for (const p of pkgs) {
  const pkg = JSON.parse(readFileSync(join(here, 'node_modules', p, 'package.json'), 'utf8'));
  versions[p] = pkg.version;
  for (const lic of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) if (existsSync(join(here, 'node_modules', p, lic))) { cpSync(join(here, 'node_modules', p, lic), join(out, p, lic)); break; }
}
writeFileSync(join(out, 'VERSIONS.json'), JSON.stringify(versions, null, 2) + '\n');
console.log(`${files.length} files from ${[...pkgs].map(p => `${p}@${versions[p]}`).join(', ')} -> ${relative(process.cwd(), out)}`);
