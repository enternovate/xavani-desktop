# Third-Party Notices — Xavani Desktop

**Xavani Desktop** is built and published by **Enternovate (Pty) Ltd**. The
repository (`package.json` → `"name": "xavani-desktop"`, `"productName":
"Xavani"`, `"author": "Enternovate"`) declares the **MIT License** and lives at
`github.com/enternovate/xavani-desktop`.

Xavani Desktop bundles the third-party components listed below. The notices are
reproduced to satisfy the license terms of each component. **They are a legal
requirement and must not be removed, shortened, or replaced to satisfy a
product-brand scan.**

Functional identifiers are not branding: provider ids, endpoint names, and
dependency package names stay as they are. Attribution of a third-party work is
not a claim that Enternovate wrote it, nor that the copyright holder sponsors
Xavani.

---

## 1. Vendored browser assets — `src/renderer/vendor/`

These files ship inside the app payload (`Resources/app/src/renderer/vendor/`)
and are loaded by `src/renderer/index.html`. Each entry records the notice
exactly as it appears in the vendored file.

| Component | Vendored file | Version | Notice line as it appears in the file |
| --- | --- | --- | --- |
| **marked** — markdown parser | `src/renderer/vendor/marked.min.js` | 15.0.12 | `Copyright (c) 2011-2025, Christopher Jeffrey. (MIT Licensed)` |
| **DOMPurify** — HTML sanitizer | `src/renderer/vendor/purify.min.js` | 3.4.14 | `(c) Cure53 and other contributors` |
| **xterm.js** — terminal renderer | `src/renderer/vendor/xterm.js` | 5.3.0 (see note) | no notice embedded in the bundle |
| **xterm addon-fit** — terminal fit addon | `src/renderer/vendor/xterm-addon-fit.js` | not embedded | no notice embedded in the bundle |
| **xterm.css** — terminal stylesheet | `src/renderer/vendor/xterm.css` | 5.3.0 (jsDelivr build) | no notice embedded; jsDelivr provenance header only |
| **monaco-editor** — code editor bundle | `src/renderer/vendor/monaco.bundle.js` | 0.56.0 (esbuild 0.28.2) | `Generated from monaco-editor 0.56.0 (MIT) - npm run build:monaco` |
| **monaco-editor** — editor stylesheet | `src/renderer/vendor/monaco.bundle.css` | 0.56.0 (esbuild 0.28.2) | no notice embedded (generated stylesheet) |
| **codicon** — icon font (part of monaco-editor) | `src/renderer/vendor/codicon-KP4OV2OO.ttf` | 0.56.0 (hashed font-subset name) | binary font; no text notice |

### 1.1 marked (MIT)

Verbatim header, `src/renderer/vendor/marked.min.js`:

```
marked v15.0.12 - a markdown parser
Copyright (c) 2011-2025, Christopher Jeffrey. (MIT Licensed)
https://github.com/markedjs/marked
```

License: **MIT**. Full text ships with the package as
`node_modules/marked/LICENSE.md` (see section 2).

### 1.2 DOMPurify (Apache-2.0 **and** MPL-2.0)

Verbatim header, `src/renderer/vendor/purify.min.js`:

```
! @license DOMPurify 3.4.14 | (c) Cure53 and other contributors | Released under the Apache license 2.0
  and Mozilla Public License 2.0 | github.com/cure53/DOMPurify/blob/3.4.14/LICENSE
```

DOMPurify is dual-licensed **Apache License 2.0** *or* **Mozilla Public License
2.0**. Both full license texts ship with the package as
`node_modules/dompurify/LICENSE` (Apache-2.0) and
`node_modules/dompurify/LICENSE-MPL` (MPL-2.0). The vendored bundle carries no
full license text, so those two files must stay in the package payload.

### 1.3 xterm.js and xterm addon-fit (MIT)

The vendored `xterm.js` and `xterm-addon-fit.js` bundles carry **no embedded
copyright or license line** — they begin directly with the minified IIFE. Their
provenance is recorded by the sibling stylesheet, whose header is the only
version evidence in the tree:

```
Minified by jsDelivr using clean-css v5.3.3.
Original file: /npm/xterm@5.3.0/css/xterm.css
```

So the xterm family is recorded here as **5.3.0** (fetched from
`cdn.jsdelivr.net/npm/xterm@5.3.0/`) and the addon as the
`xterm-addon-fit` bundle (the pre-rename package name, matching `xterm@5.3.0`).
Upstream projects: <https://github.com/xtermjs/xterm.js> and
<https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit>, both
**MIT** licensed.

The upstream license file (xterm.js tag `5.3.0`) carries these copyright
lines, reproduced verbatim:

```
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
```

The same MIT license text governs the addon-fit bundle. This is an
attribution obligation; it stays here.

### 1.4 Monaco Editor (MIT)

The editor surface (task 15) ships two bundles generated from the
`monaco-editor` npm package (0.56.0) plus its icon-font subset. The
JavaScript bundle carries this verbatim banner:

```
/* Generated from monaco-editor 0.56.0 (MIT) - npm run build:monaco */
```

The generated stylesheet and the font subset carry no notice text, so the
attribution is recorded here. The bundles are produced by
`npm run build:monaco` with **esbuild 0.28.2** (MIT) as the bundling tool;
esbuild itself is a build-time tool and its binary is not redistributed.

Upstream project: <https://github.com/microsoft/monaco-editor> — **MIT**.

The upstream license file carries this copyright line, reproduced
verbatim:

```
Copyright (c) 2016 - present Microsoft Corporation
```

MIT License text (monaco-editor):

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. Runtime dependencies that ship inside the package

`scripts/build-macos.sh` copies two dependency directories into the packaged app
at `Resources/app/node_modules/`. They are redistributed, so their own license
files travel with them and must not be stripped.

| Component | `package.json` range | Installed version | License | License file in the payload |
| --- | --- | --- | --- | --- |
| `marked` | `^15.0.0` | 15.0.12 | MIT | `node_modules/marked/LICENSE.md` |
| `dompurify` | `^3.2.0` | 3.4.14 | Apache-2.0 / MPL-2.0 | `node_modules/dompurify/LICENSE`, `LICENSE-MPL` |

The vendored browser bundles of these two libraries are byte-identical to the
installed package copies (verified by SHA-256):

- `src/renderer/vendor/marked.min.js` = `node_modules/marked/marked.min.js`
  — `3e7e7d7feb3e5d58cb6c804f68ab5c24cc7e5eb6270fd6e5cbb9124739217d0c`
- `src/renderer/vendor/purify.min.js` = `node_modules/dompurify/dist/purify.min.js`
  — `c2f26ea4fc0d88141c9aa430eb515ac86fce59418ceebd85fa475b87a8d6c3e6`

## 3. Electron runtime (devDependency, redistributed at build time)

`electron` is a **devDependency** in `package.json` (`^38.2.0`; 38.8.6
installed). It is not vendored source and is not a runtime dependency of the
app's JavaScript. It becomes a redistributed component at build time, because
`scripts/build-macos.sh` copies `node_modules/electron/dist/Electron.app` to form
`Xavani.app`.

The packaged app therefore redistributes:

- **Electron** — MIT, Copyright (c) Electron contributors; Copyright (c)
  2013-2020 GitHub Inc. Notice file: `node_modules/electron/dist/LICENSE`.
- **Chromium** — BSD-3-Clause and other licenses, Copyright (c) The Chromium
  Authors. Notice file: `node_modules/electron/dist/LICENSES.chromium.html`.
- **Node.js** — MIT, Copyright (c) Node.js contributors. Covered by the same
  Electron license file.

Both notice files sit at the **root of Electron's `dist/` directory, outside
`Electron.app`**, so copying `Electron.app` alone drops them. The macOS build
copies them into `Xavani.app/Contents/Resources/` for that reason. They must not
be deleted from the built app.

## 4. Bundled fonts

Two variable-font subsets ship as binary assets under `src/renderer/fonts/` and
are declared in `src/renderer/styles.css` via `@font-face`. A `.woff2` carries no
text notice, so the upstream projects and licenses are recorded here:

| Asset | Upstream project | License |
| --- | --- | --- |
| `inter-latin-wght-normal.woff2` | Inter — <https://github.com/rsms/inter> | SIL Open Font License 1.1 |
| `jetbrains-mono-latin-wght-normal.woff2` | JetBrains Mono — <https://github.com/JetBrains/JetBrainsMono> | SIL Open Font License 1.1 |

Bundled font copyright lines (from each project's `OFL.txt`):

```
Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)
```

The SIL OFL 1.1 license text applies to both fonts and is reproduced below in
full; it travels with this file in the packaged app.

```text
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

`src/renderer/assets/mark.png` is a first-party Enternovate brand asset, not a
third-party component.

## 5. Browser extension derivative (attribution is required)

`docs/browser-extension.md` carries the attribution wording for the Chrome/Edge
MV3 extension that ships with the Xavani browser integration:

> Derivative of an MIT-licensed upstream browser extension. Required
> copyright and permission notices are preserved upstream and in this
> repository's history. Built by Enternovate under the MIT License.

That wording is an attribution obligation, not marketing copy. It stays in
`docs/browser-extension.md` and is not to be removed during branding work.

## 6. Dependency inventory

JavaScript dependency names, versions, and integrity hashes are enumerated in
`package-lock.json`; the bundled engine's Python dependencies are enumerated in
the engine repository's `uv.lock` and installed into
`Resources/backend/runtime`. Each dependency carries its own license in its
distribution metadata. Dependency package names that resemble another project's
name are dependency metadata, not product branding.

---

## Keeping this file honest

What is **verified on every test run** (`tests/desktop/test_legal_notices.py`,
`tests/desktop/test_update_policy.js`):

- This file exists, is non-empty, and names the product (`Xavani`), the
  publisher (`Enternovate`), and the release repository
  (`enternovate/xavani-desktop`).
- Every vendored file named in section 1 exists in `src/renderer/vendor/`.
- The vendored copyright lines quoted above are still present in the files they
  are quoted from (`Christopher Jeffrey`, `Cure53`, `DOMPurify`, `marked`).
- The dual DOMPurify licensing and the MIT marked licensing are stated.
- The runtime dependencies in section 2 are still copied into the package by
  `scripts/build-macos.sh`, and this file is shipped with them.
- The browser-extension attribution wording in `docs/browser-extension.md` is
  intact.
- The About surface in `src/renderer/app.js` names Xavani and Enternovate, and
  update checks are user-triggered or explicitly opted in (no automatic
  startup check in `src/main.js`).

What is **not** verified automatically, and is a release-time obligation:

- Re-verify the xterm.js copyright lines and the OFL text (sections 1.3/4)
  if any vendored bundle or font is ever re-fetched at a different version.
- `LICENSE`: this repository declares MIT in `package.json` but does not yet
  carry a `LICENSE` file at its root. The full MIT text with the Enternovate
  copyright line lives in the Xavani Agent repository, which this app bundles.
  A root `LICENSE` must be added before a release is marked stable.

Run the checks with:

```sh
/Users/andilemushwana/.cache/xavani-r1-venv/bin/python -m pytest -o addopts= -q tests/desktop
node --test tests/desktop/test_update_policy.js
```

Exit code 0 means the product and legal boundary holds for what the tests cover.
It does not mean the three release-time obligations above are discharged.
