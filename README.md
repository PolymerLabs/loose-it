# loose-it
This repository contains loose-it, a tool to pre-built Polymer metadata.
The tool can be integrated in the existing Polymer tooling build line.
It relies on [a custom version of Polymer](https://github.com/Polymer/polymer/pull/4782) that can work a minimized serialized representation of Polymer metadata.

**:warning: :warning: Note: This tool is not ready for production :warning: :warning:**

## Integration in existing Polymer tooling pipeline
Integration requires direct interaction with the Polymer tooling pipeline using [gulp](https://gulpjs.com/).
Example integration with Gulp is shown in [custom-build](https://github.com/PolymerElements/generator-polymer-init-custom-build/blob/9fd5c873e75c7dafd0a86ce652959abc72cff814/generators/app/gulpfile.js).

Updates to the gulpFile are as follows:

Add the following import:
```js
const looseIt = require('loose-it').PreBuildBindings;
```
Update the integration with the `sources` and `dependencies` streams.
```js
// Let's start by getting your source files. These are all the
// files in your `src/` directory, or those that match your
// polymer.json "sources"  property if you provided one.
let sourcesStream = polymerProject.sources()
// Similarly, you can get your dependencies seperately and perform
// any dependency-only optimizations here as well.
let dependenciesStream = polymerProject.dependencies();

let buildStream = mergeStream(sourcesStream, dependenciesStream)
    // Apply the tool
    .pipe(new looseIt(polymerProject.config))

    .pipe(sourcesStreamSplitter.split())
    
    .pipe(gulpif(/\.js$/, babili()))
    .pipe(gulpif(/\.css$/, cssSlam()))
    .pipe(gulpif(/\.html$/, cssSlam()))
    .pipe(gulpif(/\.html$/, htmlMinify()))

    // Remember, you need to rejoin any split inline code when you're done.
    .pipe(sourcesStreamSplitter.rejoin())
    .once('data', () => {
        console.log('Analyzing build dependencies...');
    });
```
As you can see in the above snippet, instead of processing the streams separately, they have to be pre-emptively merged.
The tool then hooks into this stream directly and analyzes it using the configuration of `polymerProject`.
At last, the stream is split to apply modifications such as minification.

## High-level implementation
1. Read in all files.
1. Analyze the files with [polymer-analyzer](https://github.com/polymer/polymer-analyzer)
1. Based on the analysis, obtain DFS traversal of HTML imports
    1. All files that were in the stream but not in the traversal, yield back in the stream
1. Launch [Chrome Headless](https://chromium.googlesource.com/chromium/src/+/lkgr/headless/README.md) using [Puppeteer](https://github.com/GoogleChrome/puppeteer)
1. For all documents of the DFS traversal:
    1. Execute all scripts in the document
    1. For all defined elements in the document:
        1. Define dom-module in the browser
        1. Obtain metadata (bindings, property-effects) from browser
        1. Write binding metadata in front of JS ASTNode of element
    1. Serialize all AST’s in the document back into a file
1. Yield potentially modified content from the file back in the stream
