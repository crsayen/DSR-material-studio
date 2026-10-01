// Lighting presets: an equirectangular environment (lights the raster view through PMREM and the
// path tracer directly) plus optional emissive objects (the glowing sacs) that both renderers see.
import * as THREE from 'three';

function equirect(w, h, fn) {
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const el = (y + .5) / h * Math.PI - Math.PI / 2;          // row 0 is the bottom in three.js (-90 .. +90)
    for (let x = 0; x < w; x++) {
      const az = (x + .5) / w * Math.PI * 2 - Math.PI;
      const d = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
      const c = fn(d, el, az), i = (y * w + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 1;
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.minFilter = t.magFilter = THREE.LinearFilter; t.colorSpace = THREE.LinearSRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

const softbox = (d, dir, size, power) => {
  const k = d.dot(dir); const c = Math.cos(size);
  return k > c ? power * Math.min(1, (k - c) / (1 - c) * 6) : 0;
};

const GLOW = 4;   // the spheres' radiance

export const PRESETS = {
  studio: {
    label: 'Studio softboxes',
    env: () => {
      const key = new THREE.Vector3(.6, .5, .6).normalize(), fill = new THREE.Vector3(-.8, .25, .4).normalize(), rim = new THREE.Vector3(-.2, .6, -.9).normalize();
      return equirect(512, 256, (d, el) => {
        const base = el > 0 ? .06 + .06 * el : .03;
        const v = base + softbox(d, key, .28, 9) + softbox(d, fill, .35, 2.5) + softbox(d, rim, .2, 7);
        return [v, v, v * .98];
      });
    },
  },
  overcast: {
    label: 'Overcast sky',
    env: () => equirect(512, 256, (d, el) => el > 0 ? [.85 + .3 * el, .9 + .3 * el, 1 + .35 * el] : [.18, .16, .14]),
  },
  sun: {
    label: 'Sun and sky',
    env: () => {
      const sun = new THREE.Vector3(.5, .55, .67).normalize();
      return equirect(1024, 512, (d, el) => {
        const sky = el > 0 ? [.25 + .2 * (1 - el), .45 + .2 * (1 - el), .9] : [.12, .1, .08];
        const k = d.dot(sun), s = k > .9995 ? 4000 : k > .995 ? 40 * (k - .995) / .0045 : 0;
        return [sky[0] + s, sky[1] + s * .95, sky[2] + s * .85];
      });
    },
  },
  sacs: {
    label: 'Dark room · glowing sacs',
    env: () => equirect(256, 128, () => [.002, .0015, .0012]),
    // Glowing spheres around the model: real emitters in the path tracer, and point lights plus a
    // reflection probe in the raster view.
    objects: (bounds) => {
      const g = new THREE.Group(), c = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
      const r = Math.max(size.x, size.y, size.z);
      const spots = [[1.0, .15, .45], [-1.05, .3, .35], [.15, .95, .2], [-.6, .45, -.9], [.75, -.1, -.8]];   // beside, above and behind: never between camera and model
      for (const [x, y, z] of spots) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(r * .09, 32, 16), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1, .38, .08), emissiveIntensity: GLOW }));
        m.position.set(c.x + x * r, c.y + y * r, c.z + z * r);
        m.userData.emitter = true;
        g.add(m);
        // A sphere of radiance L and radius p has intensity L * pi * p^2 (candela, three's units).
        const l = new THREE.PointLight(new THREE.Color(1, .38, .08), GLOW * Math.PI * (r * .09) ** 2, 0, 2);
        l.position.copy(m.position); l.userData.rasterOnly = true;
        g.add(l);
      }
      return g;
    },
  },
};
