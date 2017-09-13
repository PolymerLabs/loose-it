import * as dom5 from 'dom5';
import * as espree from 'espree';
import * as parse5 from 'parse5';
import * as path from 'path';
import {Analysis, Analyzer, Document, ParsedHtmlDocument, ParsedJavaScriptDocument, PolymerElement} from 'polymer-analyzer';
import {FileMapUrlLoader} from 'polymer-build/lib/file-map-url-loader';
import {pathFromUrl, urlFromPath} from 'polymer-build/lib/path-transformers';
import {AsyncTransformStream} from 'polymer-build/lib/streams';
import {ProjectConfig} from 'polymer-project-config';

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
        analysis,
        path.relative(this._config.root, this._config.entrypoint),
        set)
    for (const file of new Set(
             [...this.files.keys()].filter(i => !set.has(i)))) {
      yield this.files.get(file);
    }

    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    await page.goto(`file://${path.resolve(__dirname, '..', 'index.html')}`);

    await page.evaluate(`
      serializeRunTimeClosures = ${serializeRunTimeClosures.toString()};
      stripUnnecessaryEffectData = ${stripUnnecessaryEffectData.toString()};
      stripSerializedMetadata = ${stripSerializedMetadata.toString()};
      serializeBindings = ${serializeBindings.toString()};
      serializeEffects = ${serializeEffects.toString()};
    `)

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
        console.log(e);
      }
    }

    browser.close();
  }
}

function recursivelyObtainHTMLImports(
    analysis: Analysis, url: string, set: Set<string>) {
  const document = analysis.getDocument(url);

  if (!(document instanceof Document)) {
    const message = document && document.message;
    console.warn(`Unable to get document ${url}: ${message}`);
    return;
  }
  const imports = document.getFeatures({kind: 'html-import'});

  for (const himport of imports) {
    recursivelyObtainHTMLImports(analysis, himport.url, set)
  }
  set.add(url);
}

/**
 * Pre-compute the binding and property effects metadata and insert them into
 * the original document. Also remove all bindings from the template and delete
 * the `properties` block.
 *
 * @param document The document that contains the Polymer elements
 */
async function insertPreBuiltMetadata(
    analysis: Analysis, document: Document, page: any): Promise<string> {
  const scripts = document.getFeatures();
  for (const script of scripts) {
    // If any user error occurs, silently swallow it. Might be the case for any
    // imperative code in for example index.html, or an external dependency that
    // could not be found.
    try {
      if (script.kinds.has('js-document')) {
        const parsedDocument =
            (script as any).parsedDocument as ParsedJavaScriptDocument;

        await page.evaluate(parsedDocument.contents);
      } else if (script.kinds.has('html-script')) {
        const doc = analysis.getDocument((script as any).url) as any;

        await page.evaluate(doc.parsedDocument.contents);
      }
    } catch (e) {
      console.log(e.message)
    }
  }

  if (!(document.parsedDocument instanceof ParsedHtmlDocument)) {
    return document.parsedDocument.contents;
  }

  const elements = document.getFeatures({kind: 'polymer-element'});

  for (const element of elements) {
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

    let hasProperties = true;

    if (element.domModule) {
      const templateNode =
          dom5.query(element.domModule, dom5.predicates.hasTagName('template'));
      // To make sure that indices match up of `findTemplateNode` after
      // minification of unrelated nodes, we must strip both text nodes and
      // comments here.
      // However, text nodes should only be removed if they are empty. As such,
      // use the `strip-whitespace` option for that, while we can safely delete
      // all comments with dom5.
      dom5.setAttribute(templateNode, 'strip-whitespace', '');
      dom5.nodeWalkAll(
              templateNode,
              dom5.isCommentNode,
              [],
              dom5.childNodesIncludeTemplate)
          .forEach((node) => {
            dom5.remove(node);
          });
      const content = parse5.serialize(element.domModule);

      await page.evaluate(`
        domModule = document.createElement('div');
        domModule.innerHTML = \`<dom-module id="${element.tagName}">${
          content.replace(/`/g, '\\`')}</dom-module>\`;
        document.body.appendChild(domModule);
      `);

      // TODO(Tim): Figure out why _registered is not called by Polymer directly
      const newTemplate: string = await page.evaluate(`
        ctor = customElements.get('${element.tagName}');
        window.onerror = function(error) {
          window.lastError = error;
        }
        ctor.prototype._registered && ctor.prototype._registered();
        ctor.finalize();
        ctor.prototype._bindTemplate(ctor.prototype._template);
        window.lastError || ctor.prototype._template.innerHTML;
      `);

      const templateInfo: string = await page.evaluate(`
        serializeBindings(ctor.prototype._template._templateInfo)
      `);

      const template =
          dom5.query(element.domModule, dom5.predicates.hasTagName('template'));

      serializeBindingsToScriptElement(element, parsedDocument, templateInfo);
      replaceOriginalTemplate(template, newTemplate);
    } else {
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
      await processElementProperties(element, parsedDocument, page);
      removePropertiesFromElementDefinition(element);
    }
  }

  // Use stringify to make sure that the modifications to the JS AST of the
  // Polymer element are properly passed on in the stream
  return document.stringify();
}

/**
 * Process the properties of the element, retrieve its metadata from the
 * prototype and serialize the output to the dom module of the element.
 *
 * @param element Element that contains the properties
 * @param prototype Prototype that the effect metadata is computed on
 */
async function processElementProperties(
    element: PolymerElement, document: ParsedJavaScriptDocument, page: any) {
  const propertyEffects = await page.evaluate(`
    serializeEffects(ctor.prototype)
  `);
  serializePropertyEffectsToScriptElement(element, document, propertyEffects);
}

/**
 * Append the serialized computed effects to the dom module of the element.
 *
 * @param element Element to serialize effects for
 * @param prototype Prototype that contains the computed effects
 */
function serializePropertyEffectsToScriptElement(
    element: PolymerElement,
    document: ParsedJavaScriptDocument,
    propertyEffects: string) {
  const assignment =
      espree
          .parse(`Polymer.preBuiltEffects = Polymer.preBuiltEffects || {};
      Polymer.preBuiltEffects['${element.tagName}'] = ${propertyEffects};`)
          .body;

  document.ast.body = assignment.concat(document.ast.body);
}

/**
 * Remove the property definitions from the Polymer element.
 * Can either be the hybrid version with an object call or a class definition.
 *
 * @param astNode Node that defines the Polymer element
 */
function removePropertiesFromElementDefinition(element: PolymerElement) {
  const astNode = element.astNode;
  if (astNode.type === 'CallExpression') {
    const argument = astNode.arguments[0];

    if (argument.type === 'ObjectExpression') {
      for (let i = 0; i < argument.properties.length; i++) {
        const property = argument.properties[i];

        if (property.key.type === 'Identifier' &&
            property.key.name === 'properties' &&
            property.value.type === 'ObjectExpression') {
          for (let j = 0; j < property.value.properties.length; j++) {
            const propertyDefinition = property.value.properties[j];

            if (propertyDefinition.value.type === 'ObjectExpression') {
              const propertyConfigurations =
                  propertyDefinition.value.properties;

              for (let k = 0; k < propertyConfigurations.length; k++) {
                const propertyConfiguration = propertyConfigurations[k];

                if (propertyConfiguration.key.name !== 'value' &&
                    propertyConfiguration.key.name !== 'type') {
                  // Decrement k to make sure that the next property is iterated
                  // on
                  propertyConfigurations.splice(k--, 1);
                }
              }

              if (propertyConfigurations.length === 0) {
                property.value.properties.splice(j--, 1);
              }
            }
          }

          if (property.value.properties.length === 0) {
            argument.properties.splice(i, 1);
          }
          break;
        }
      }
    }
  } else if (
      astNode.type === 'ClassDeclaration' ||
      astNode.type === 'ClassExpression') {
    const properties = astNode.body.body;

    for (let i = 0; i < properties.length; i++) {
      const property = properties[i];

      if (property.type === 'MethodDefinition' &&
          property.key.type === 'Identifier' &&
          property.key.name === 'properties' && property.static &&
          property.kind === 'get') {
        properties.splice(i, 1);
        break;
      }
    }
  }
}

/**
 * Append the serialized computed bindings to the dom module of the element.
 *
 * @param element Element to serialize bindings for
 * @param _templateInfo The computed bindings metadata
 */
function serializeBindingsToScriptElement(
    element: PolymerElement,
    document: ParsedJavaScriptDocument,
    templateInfo: string) {
  const assignment =
      espree
          .parse(`Polymer.PreBuiltBindings = Polymer.PreBuiltBindings || {};
Polymer.PreBuiltBindings['${element.tagName}'] = ${templateInfo};`)
          .body;

  document.ast.body = assignment.concat(document.ast.body);
}

/**
 * Transform the computed bindings metadata into a string, while minimizing its
 * total size and stripping away unnecessary data.
 *
 * @param templateInfo Binding metadata to serialize
 */
function serializeBindings(templateInfo: any): string {
  let propertyEffects = templateInfo.propertyEffects &&
          Object.values(templateInfo.propertyEffects) ||
      [];
  let nodeInfos = Object.values(templateInfo.nodeInfoList);

  delete templateInfo.dynamicFns;
  !templateInfo.stripWhiteSpace && delete templateInfo.stripWhiteSpace;

  let i = 0;
  // Recursively loop over the nodeinfos and process the metadata
  while (i < nodeInfos.length) {
    const nodeInfo = nodeInfos[i++];

    // This is a template inside the outer template. Add it recursively to the
    // end of `nodeInfos`
    if (nodeInfo.templateInfo) {
      if (nodeInfo.templateInfo.propertyEffects) {
        propertyEffects = propertyEffects.concat(
            Object.values(nodeInfo.templateInfo.propertyEffects));
      }

      // Nested document fragments are not properly serialized by JSDOM and
      // instead stored in the `templateInfo` in the `nodeInfoList`. On
      // run-time, the `content` in the templateInfo must be a document fragment
      // again. Therefore, on load the HTML must be transformed using
      // `Polymer.stringToFrag`. The REGEX_MARKER is used to (after
      // serialization), remove the quotes, such that during load of the JSON
      // object, it is an actual function call instead of a string.
      const div = document.createElement('div');
      div.appendChild(nodeInfo.templateInfo.content.cloneNode(true));
      nodeInfo.templateInfo.content =
          `Polymer.stringToFrag('${div.innerHTML}')REGEX_MARKER`;

      nodeInfos = nodeInfos.concat(nodeInfo.templateInfo.nodeInfoList);
      delete nodeInfo.templateInfo.dynamicFns;
      !nodeInfo.templateInfo.stripWhiteSpace &&
          delete nodeInfo.templateInfo.stripWhiteSpace;
    }

    if (nodeInfo.bindings) {
      for (const binding of nodeInfo.bindings) {
        for (const part of binding.parts) {
          !part.event && delete part.event;
          if (part.signature) {
            if (part.signature.args) {
              for (const arg of part.signature.args) {
                !arg.structured && delete arg.structured;
                !arg.wildcard && delete arg.wildcard;
              }
            }
          } else {
            delete part.signature;
          }

          !part.customEvent && delete part.customEvent;
          !part.negate && delete part.negate;
          part.compoundIndex === 0 && delete part.compoundIndex;
        }

        !binding.listenerNegate && delete binding.listenerNegate;
        !binding.listenerEvent && delete binding.listenerEvent;
        !binding.isCompound && delete binding.isCompound;
        !binding.literal && delete binding.literal;
        !binding.kind && delete binding.kind;
      }
    }
  }

  serializeRunTimeClosures(propertyEffects);
  stripUnnecessaryEffectData(propertyEffects);

  const serialized = stripSerializedMetadata(templateInfo);
  return serialized.replace(
      /content:"Polymer.stringToFrag(.+?)REGEX_MARKER"/g,
      'content:Polymer.stringToFrag$1');
}

/**
 * Replace the original template in the dom module by the stripped content as a
 * result of `_parseTemplate`.
 *
 * @param template Original template in the dom module
 * @param content Templatecontent that contains the stripped content as a result
 * of
 * `_parseTemplate`
 */
function replaceOriginalTemplate(template: parse5.ASTNode, content: string) {
  const replacedAst = parse5.parse(content);
  dom5.removeFakeRootElements(replacedAst);

  const replacedTemplate = dom5.constructors.element('template');
  parse5.treeAdapters.default.setTemplateContent(replacedTemplate, replacedAst);

  dom5.replace(template, replacedTemplate);
}

/**
 * Transform the computed effects metadata into a string, while minimizing its
 * total size and stripping away unnecessary data.
 *
 * @param prototype Prototype that contains the computed property effect
 * metadata
 */
function serializeEffects(prototype: any): string {
  const preBuiltEffects: {[effectType: string]: any} = {};

  for (const effectType of Object.values(prototype.PROPERTY_EFFECT_TYPES)) {
    if (prototype[effectType]) {
      preBuiltEffects[effectType] = prototype[effectType];
      serializeRunTimeClosures(Object.values(prototype[effectType]));
    }
  }

  if (prototype.__computeEffects) {
    stripUnnecessaryEffectData(Object.values(prototype.__computeEffects));
  }

  if (prototype.__observeEffects) {
    stripUnnecessaryEffectData(Object.values(prototype.__observeEffects));
  }

  const serialized = stripSerializedMetadata(preBuiltEffects);
  return serialized.replace(
      /"Polymer.EFFECT_FUNCTIONS.(\w+)"/mg, 'Polymer.EFFECT_FUNCTIONS.$1');
}

// Declare here to not generate any Typescript error for not finding
// `Polymer.EFFECT_FUNCTIONS`
let Polymer: any = {};

/**
 * Traverse all property effects and replace the closure by the String
 * representation of the closure.
 *
 * @param propertyEffects Computed effect metadata
 */
function serializeRunTimeClosures(propertyEffects: any[]) {
  for (const effects of propertyEffects) {
    for (const effect of effects) {
      for (const [name, func] of Object.entries(Polymer.EFFECT_FUNCTIONS)) {
        if (func === effect.fn) {
          effect.fn = `Polymer.EFFECT_FUNCTIONS.${name}`;
        }
      }
    }
  }
}

/**
 * Remove unnecessary data from the effect metadata to minimize the size of the
 * serialization.
 *
 * @param effects Computed effect metadata
 */
function stripUnnecessaryEffectData(effects: any[]) {
  for (const propertyEffects of effects) {
    for (const effect of propertyEffects) {
      if (effect.trigger) {
        // effect.trigger sometimes shares the same object with effect.info
        // Most of the time, effect.trigger is necessary, but effect.info is not
        // Therefore, make a shallow copy such that modifications do not
        // adversely corrupt effect.trigger as well.
        effect.trigger = JSON.parse(JSON.stringify(effect.trigger));
        !effect.trigger.structured && delete effect.trigger.structured;
        delete effect.trigger.rootProperty;
        !effect.trigger.wildcard && delete effect.trigger.wildcard;
      }

      if (effect.info) {
        if (effect.info.args) {
          for (const arg of effect.info.args) {
            !arg.structured && delete arg.structured;
            !arg.wildcard && delete arg.wildcard;
          }
        }
        !effect.info.methodInfo && delete effect.info.methodInfo;
        !effect.info.dynamicFn && delete effect.info.dynamicFn;
      }
    }
  }
}

/**
 * Remove unnecessary characters from the serialization:
 *    * Remove quotes in object notation
 *
 * @param metadata Metadata object to serialize to a string
 */
function stripSerializedMetadata(metadata: any): string {
  return JSON.stringify(metadata).replace(/"(\w+)":/g, '$1:');
}
