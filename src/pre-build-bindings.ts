/**
 * @license
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
import * as dom5 from 'dom5';
import * as fs from 'fs';
import * as path from 'path';
import {Analysis, Analyzer, Document, InlineDocument, ParsedHtmlDocument, ParsedJavaScriptDocument} from 'polymer-analyzer';
import {ScriptTagImport} from 'polymer-analyzer/lib/html/html-script-tag';
import {FileMapUrlLoader} from 'polymer-build/lib/file-map-url-loader';
import {pathFromUrl, urlFromPath} from 'polymer-build/lib/path-transformers';
import {AsyncTransformStream} from 'polymer-build/lib/streams';
import {ProjectConfig} from 'polymer-project-config';

import * as bindings from './bindings';
import * as properties from './properties';
import * as serialization from './serialization';

// To make sure names are still properly serialize to the browser, unroll the
// functions here instead of in the import
const {
  patchUpObserverArgCache,
  serializeRunTimeClosures,
  stripUnnecessaryEffectData,
  stripSerializedMetadata
} = serialization;

const {serializeBindingsInBrowser, processTemplateBindings} = bindings;
const {processElementProperties, serializeEffectsInBrowser} = properties;

const puppeteer = require('puppeteer');

import File = require('vinyl');

/**
 * Process a file stream and compute binding and property effect metadata of
 * Polymer elements as defined in HTML files.
 */
export class PreBuildBindings extends AsyncTransformStream<File, File> {
  files: Map<string, File>;
  private _analyzer: Analyzer;
  constructor(private _config: ProjectConfig) {
    super({objectMode: true});

    this.files = new Map();
    this._analyzer =
        new Analyzer({urlLoader: new FileMapUrlLoader(this.files)});
  }

  protected async * _transformIter(files: AsyncIterable<File>) {
    // Map all files; pass-through all non-HTML files.
    for await (const file of files) {
      const fileUrl = urlFromPath(this._config.root, file.path);
      this.files.set(fileUrl, file);
    }

    const analysis =
        await this._analyzer.analyze(Array.from(this.files.keys()));
    const set = new Set<string>();

    recursivelyObtainHTMLImports(
        this._config.root,
        analysis,
        path.relative(this._config.root, this._config.entrypoint),
        set);

    // For all files not in the DFS set, yield the regular output. These are
    // usually configuration files like manifest.json
    for (const file of new Set(
             [...this.files.keys()].filter((i) => !set.has(i)))) {
      yield this.files.get(file);
    }

    const {browser, page} = await setupBrowserPage();

    for (const documentUrl of set) {
      const document = analysis.getDocument(documentUrl);
      if (!(document instanceof Document)) {
        const message = document && document.message;
        console.warn(`Unable to get document ${documentUrl}: ${message}`);
        continue;
      }

      try {
        const html = await insertPreBuiltMetadata(analysis, document, page);
        const filePath = pathFromUrl(this._config.root, documentUrl);
        yield new File({contents: new Buffer(html, 'utf-8'), path: filePath});
      } catch (e) {
        console.log(`Document "${documentUrl}" had error: ${e}`);
        fs.writeFileSync('foo.html', await page.content());
      }
    }

    await browser.close();
  }
}

/**
 * Recursively iterate through all HTML imports in the current document
 * referenced by the url.
 *
 * @param root The root of the project
 * @param analysis Analysis output from polymer-analyzer
 * @param url The current document url to consider
 * @param set The DFS set of all HTML imports
 */
function recursivelyObtainHTMLImports(
    root: string, analysis: Analysis, url: string, set: Set<string>) {
  const document = analysis.getDocument(url);

  if (!(document instanceof Document)) {
    const message = document && document.message;
    console.warn(`Unable to get document ${url}: ${message}`);
    return;
  }

  const imports = document.getFeatures({kind: 'html-import'});

  for (const himport of imports) {
    // Make sure that absolute url are correctly resolved relative to the root
    const pathUrl = path.relative(root, path.join(root, himport.url));
    recursivelyObtainHTMLImports(root, analysis, pathUrl, set);
  }

  set.add(url);
}

/**
 * Set up the browser and serialize all required functions into the browser.
 * These functions are defined in several files and are then send to the browser
 * page by evaluation in the global scope of the console.
 */
async function setupBrowserPage(): Promise<{browser: any, page: any}> {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  await page.goto(`file://${path.resolve(__dirname, '..', 'index.html')}`);

  await page.evaluate(`
    patchUpObserverArgCache = ${patchUpObserverArgCache.toString()};
    serializeRunTimeClosures = ${serializeRunTimeClosures.toString()};
    stripUnnecessaryEffectData = ${stripUnnecessaryEffectData.toString()};
    stripSerializedMetadata = ${stripSerializedMetadata.toString()};
    serializeBindingsInBrowser = ${serializeBindingsInBrowser.toString()};
    serializeEffectsInBrowser = ${serializeEffectsInBrowser.toString()};
  `);

  return {browser, page};
}

/**
 * Pre-compute the binding and property effects metadata and insert them into
 * the original document. Also remove all bindings from the template and delete
 * the `properties` block.
 *
 * @param analysis Analysis output from polymer-analyzer
 * @param document The current document to prebuilt metadata for
 * @param page The open browser page to evaluate scripts in
 */
async function insertPreBuiltMetadata(
    analysis: Analysis, document: Document, page: any): Promise<string> {
  await executeAllScripts(analysis, document, page);

  if (!(document.parsedDocument instanceof ParsedHtmlDocument)) {
    return document.parsedDocument.contents;
  }

  const elements = document.getFeatures({kind: 'polymer-element'});

  for (const element of elements) {
    // Element might not be a Polymer element, in this case continue to the next
    // one
    if (!element.tagName) {
      continue;
    }

    const jsDocument =
        analysis.getDocumentContaining(element.sourceRange, document);

    if (!(jsDocument.kinds.has('js-document'))) {
      continue;
    }
    const parsedDocument =
        jsDocument.parsedDocument as ParsedJavaScriptDocument;

    let hasProperties = true, processedTemplate = false;

    if (element.domModule) {
      // Make sure to query all templates, as paper-input defines more than one
      const templateNodes = dom5.queryAll(
          element.domModule, dom5.predicates.hasTagName('template'));

      if (templateNodes.length) {
        await processTemplateBindings(
            templateNodes, page, element, parsedDocument);

        processedTemplate = true;
      }
    }

    if (!processedTemplate) {
      hasProperties = await page.evaluate(`
        ctor = customElements.get('${element.tagName}');
        if (ctor.finalize) {
          ctor.finalize();
          true
        } else {
          false;
        }
      `);
    }

    if (hasProperties) {
      // TODO(Tim): Disabled processing properties for now, as it did not show
      // any performance improvement. To reenable this step, Polymer Core must
      // be factored such that there is no dependency on the properties block.
      // This means that defaults have to be pre-built as well as the cache for
      // all class properties.
      false && await processElementProperties(element, parsedDocument, page);
    }
  }

  // Use stringify to make sure that the modifications to the JS AST of the
  // Polymer element are properly passed on in the stream
  return document.stringify();
}

/**
 * Execute all scripts either inline or referenced by the current document.
 *
 * @param analysis Analysis output from polymner-analyzer
 * @param document Current document to execute all scripts for
 * @param page The open browser page to evaluate scripts in
 */
async function executeAllScripts(
    analysis: Analysis, document: Document, page: any) {
  const scripts = document.getFeatures();
  for (const script of scripts) {
    // If any user error occurs, swallow it. Might be the case for any
    // imperative code in for example index.html, or an external dependency that
    // could not be found.
    try {
      if (script.kinds.has('js-document')) {
        const JSDocument: InlineDocument = script as InlineDocument;
        const parsedDocument = JSDocument.parsedDocument;

        await page.evaluate(parsedDocument.contents);
      } else if (script.kinds.has('html-script')) {
        const htmlScript: ScriptTagImport = script as ScriptTagImport;
        const doc = analysis.getDocument(htmlScript.url);

        if (doc instanceof Document) {
          await page.evaluate(doc.parsedDocument.contents);
        } else {
          const message = doc && doc.message;
          console.warn(`Unable to get document ${htmlScript.url}: ${message}`);
        }
      }
    } catch (e) {
      console.log(`Document "${document.url}" had error: ${e}`);
    }
  }
}