# DSR Texture Editor

Edits Dark Souls Remastered's textures on the models that use them, shaded with the game's
material model, through parametric (non-destructive) layers. A Windows desktop app (a single exe).

## Install

Download `DSR-texture-editor.exe` from the
[latest release](https://github.com/crsayen/DSR-texture-editor/releases/latest) and run it. It
needs the Microsoft Edge WebView2 Runtime, which Windows 11 and up-to-date Windows 10 already
have (otherwise the app offers its download page). The game is found through Steam's library
list; change it under **Game** if yours is elsewhere.

## What it does

- **Models**: armour and weapons (`parts/`), objects (`obj/`) and characters (`chr/`), read
  straight from the game's files. Nothing else needs to be installed. If the game folder has a
  ModEngine2 setup, the "through its ModEngine2 mods" option reads the enabled mod folders first
  (in `config_darksoulsremastered.toml` order), so textures appear as those mods change them.
- **Materials**: each FLVER material with its MTD (`mtd/Mtd.mtdbnd.dcx`) parameters. The MTD
  decides the workflow and the colour multipliers.
- **Shading**: the game's `PackMaterial` (FRPG_FS_HemEnv.fx) converted to standard PBR maps, so
  raster and path traced views shade the same material:
  - metalness workflow: specular map R roughness, G metalness, B non-metal reflectance (x 1/5),
    A light power;
  - albedo times vertex colour times `lerp(g_DiffuseMapColor*Power, g_SpecularMapColor*Power, G)`.
- **Renderers**: Raster (three.js, environment lighting through PMREM) or Path traced
  (three-gpu-pathtracer, progressive). Lighting presets include a dark room lit only by emissive
  spheres, which the path tracer treats as real lights.
- **Views**: lit, base colour, roughness, metalness, non-metal reflectance and normal map.

## Layers

A texture's result is always recomputed from the original pixels, top layer first:

- **Change**: one channel (or RGB): raise/lower by an amount, multiply, or set to a value.
- **Where**: a list of conditions, each with its own **invert**, joined top to bottom by **and**
  (the smaller weight) or **or** (the larger). No conditions: the whole texture.
  - **Value**: a channel (or brightness) at or above / at or below a threshold, or between two.
    **Read from** picks the map the values come from: this texture, or another map of the same
    material (the albedo, specular or normal map), sampled at this texture's pixels. So a specular
    map can be changed where the albedo is bright, or where the normal map's green channel is
    low, in any combination. The **soft edge** ramps the effect in over that many values on the
    near side of the threshold, shaped by the **edge curve** (linear, S-curve, log, exp), so a
    pixel at 99 is changed almost as much as one at 100 when the threshold is 100. The histogram
    shows the chosen map's channel and the curve; click sets the threshold, shift-click the upper
    limit.
  - **Faces**: "Pick faces on the model", then click a face (shift adds, ctrl removes) or drag a box
    (only faces the camera sees, unless "include faces hidden behind others" is on). Right-drag
    orbits while picking; Esc ends it. The condition is the texture area under the picked faces,
    stored as their UV triangles (so it works without the model), with **grow** and **feather** in
    pixels. Mirrored parts that share that texture area are included.
  - **Paint**: "Paint on the texture image", then paint in the 2D texture view with a round brush
    (size in texture pixels, soft edge); the right button or Ctrl erases. The painted weights are
    kept in the layer as a small PNG. Each stroke is one undo step.
- A value condition selects from the original texture by default, so deleting or disabling any
  layer never changes what the others select; it can instead read the result of the layers above
  (or, for another map, that map's edited result).
- **Undo / redo**: Ctrl+Z, Ctrl+Shift+Z (or Ctrl+Y), or the arrows by "+ Layer": every change,
  face picks and brush strokes included; a run of slider drags is one step. Each texture keeps its
  history while its model is open.
- "Show the selected layer's region" paints it magenta in the 2D view and on the model; the
  active faces condition's own faces are orange (blue when inverted).

## Projects

Edits live in a **project**: a folder you choose (there is no default). **New…** asks for:

- the **game folder** to read from (any install works, so modders with several installs pick one
  per project), and whether to read it through the ModEngine2 mods it enables;
- the **project folder**, where `texture-editor.project.json` is created.

The project file records the game folder, the models you opened (the Project panel lists them;
opening a project reopens the last one) and every edited texture's layers, saved as you change
them. **Open…** lists recent projects, most recently edited first, with their last edit time and
texture counts, or browses for a folder with a project file. Changing the game folder while a
project is open changes that project's install. Closing the app with a project open reopens it,
and its last model, next time.

There are two exports. **Export to game…** is the one that puts edits in the game; **Export** is
the lossless intermediate it is built from.

**Export** writes the edited texture into the project folder as an uncompressed RGBA8 DDS with
mips, one file per id the game may give the original texture: `<id>.dds`, where the id is a 64-bit
hash of the texture's size, DXGI format and top mip, for the typeless, unorm and sRGB variants of
its format. The game does not read these; a mod DLL that replaces textures at runtime by content
hash can (the hash function is in `src/Dds.cs`). **Remove export** deletes the files (the layers
stay). A texture whose layers changed after its export shows "export outdated".

**Export to game…** (under the model's materials) rebuilds the model's archive (`.partsbnd.dcx`,
`.objbnd.dcx`, `.chrbnd.dcx` with its `.chrtpfbdt`) with every texture the project exports,
re-encoded in the texture's original DDS format (BC1/BC3/BC5/BC7 or uncompressed) and mip count,
and writes it in the game's folder layout to one of:

- the game folder itself: the unmodified game then loads it (the original file is kept beside it
  as `.orig` the first time; restore it before verifying game files in Steam);
- an enabled ModEngine2 mod folder, if the game folder has a ModEngine2 setup;
- the project folder, so it can serve as a ModEngine2 mod folder.

The archive is always rebuilt from the game's original (or another mod's copy), so removing a
texture's export and exporting again restores that texture. Textures whose layers changed are
exported first. Block compression is lossy; the RGBA8 exports in the project folder stay the
lossless copy.

Per-user settings (the default game folder, recent projects, the window position) are in
`%APPDATA%\DSR Texture Editor\settings.json`.

## Known gaps

- The meaning of `g_DiffuseMapColorPower` / `g_SpecularMapColorPower` (used here as direct
  multipliers) has not been checked against the game's constant buffer.
- Normal-map axis convention follows FRPG_Common.fxh (binormal * x + tangent * y); if bumps look
  inverted, use Display settings > flip/swap and report which.
- Map pieces (textures in `map/tx` and `.tpfbhd`) are not listed yet.
- Exports are uncompressed RGBA8 (large files); block-compressed exports are not offered yet.

## How it is built

The app is a web page (`src/wwwroot`: three.js, three-mesh-bvh and three-gpu-pathtracer, vendored
so it works offline) shown in a WebView2 window over a small in-process ASP.NET Core server that
reads the game files ([SoulsFormatsNEXT](https://github.com/soulsmods/SoulsFormatsNEXT),
[BCnEncoder.Net](https://github.com/Nominom/BCnEncoder.NET)) and writes the project. The server
listens on the loopback interface only, on a random port. The page is embedded in the exe.

```
git clone --recurse-submodules https://github.com/crsayen/DSR-texture-editor
cd DSR-texture-editor
dotnet run --project src                 # the window; the page is served from src\wwwroot, so JS edits only need F5
dotnet run --project src -- --serve      # no window: http://localhost:5199/ in any browser (--port changes it)
powershell -ExecutionPolicy Bypass -File scripts\publish.ps1    # one self-contained exe in dist\
```

Needs the .NET 6 SDK (and Node only to refresh the vendored libraries: `cd web-libs && npm install
&& npm run vendor`). `lib/SoulsFormats` compiles the SoulsFormatsNEXT submodule for .NET 6, since
upstream targets .NET 9. Right-click > Inspect in the window opens the DevTools.

- `src/Program.cs`: the server's routes and startup; `Window.cs` the WebView2 window and the native
  folder dialog; `GameFiles.cs` models, materials and textures through the ModEngine2 mods;
  `Project.cs` the project file and exports; `Dds.cs` DDS headers, the content hash and the writer.
- `src/wwwroot/js/app.js`: the page; `layers.js` the layer model and evaluation; `material.js`
  the game material to PBR conversion; `env.js` the lighting presets.

## Licence

GPL-3.0 (see `LICENSE`): the app links SoulsFormatsNEXT, which is GPL-3.0. The vendored browser
libraries are MIT (their licences are beside them under `src/wwwroot/vendor`).
