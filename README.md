# stepstr landing pages

The pages at [start.stepstr.space](https://start.stepstr.space). Each shows a STEP file drawn live by
[stepstr](https://github.com/Gangleri42/stepstr)'s own viewer as the page scrolls: TheRobotStudio's SO-101 arm at `/`
and the SeedHammer II engraving machine at `/ii/`. `subjects.ts` lists the pages; `subjects/<id>/` holds each one's
pinned source file, its settled choices and its storyboard; `src/` is the page code they share.

stepstr is a git submodule, pinned to the commit the pages show. Its converter is not in either repository: build it
once with `stepstr/converter/build.sh` (Docker), or put a build at `stepstr/converter/dist/converter.wasm`. The
submodule's code reads its packages from this repository's `node_modules`:

```sh
git clone --recurse-submodules <this repository>
npm install
ln -s ../node_modules stepstr/node_modules
npm run model        # each page's STEP file, downloaded by sha256 and converted, into .cache/landing/<id>/model
npm run stills       # the pictures shown without WebGL, drawn by Playwright's Chromium
npm run dev          # http://127.0.0.1:5183/ and /ii/
npm run build        # model, stills and the pages, into dist/
npm run check        # svelte-check over the pages, tsc over the tools and tests
npm test             # vitest; the tests on the real models skip until `npm run model` has run
npm run test:e2e     # the built pages in Chromium, Firefox and WebKit
```

## License

The pages are in the public domain, see [LICENSE](LICENSE). The models are not in the repository: the build downloads
each from its source, converts and compresses it and ships it next to the page with its licence, the SO-101 under the
Apache License 2.0 with a notice of the changes, the SeedHammer II in the public domain under the Unlicense. The
wordmark is set in Space Grotesk, under the SIL Open Font License.
