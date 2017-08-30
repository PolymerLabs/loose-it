import * as dom5 from 'dom5';
import * as estree from 'estree';
import {JSDOM} from 'jsdom';
import * as parse5 from 'parse5';
import * as path from 'path';
import {Analyzer, Document, ParsedHtmlDocument, PolymerElement} from 'polymer-analyzer';
import {FileMapUrlLoader} from 'polymer-build/lib/file-map-url-loader';
import {pathFromUrl, urlFromPath} from 'polymer-build/lib/path-transformers';
import {AsyncTransformStream} from 'polymer-build/lib/streams';
import {ProjectConfig} from 'polymer-project-config';

import File = require('vinyl');

// Patch up the global scope to be able to import Polymer code
class MutationObserver {
  observe() {}
  disconnect() {}
}

const dom = new JSDOM();
const window: any = dom.window;
Object.assign(global, {
  window: global,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  customElements: {define() {}},
  JSCompiler_renameProperty: () => {},
  document: window.document,
  MutationObserver,
  requestAnimationFrame: setTimeout,
  cancelAnimationFrame: clearTimeout
});

import {ElementMixin, finalizeProperties} from './polymerjs/mixins/element-mixin.js';
import {EFFECT_FUNCTIONS} from './polymerjs/mixins/effect-functions.js';

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
    const htmlFileUrls = [];

    // Map all files; pass-through all non-HTML files.
    for await (const file of files) {
      const fileUrl = urlFromPath(this._config.root, file.path);
      this.files.set(fileUrl, file);
      if (path.extname(file.path) !== '.html') {
        yield file;
      } else {
        htmlFileUrls.push(fileUrl);
      }
    }

    // Analyze each HTML file and add prefetch links.
    const analysis = await this._analyzer.analyze(htmlFileUrls);

    for (const documentUrl of htmlFileUrls) {
      const document = analysis.getDocument(documentUrl);
      if (!(document instanceof Document)) {
        const message = document && document.message;
        console.warn(`Unable to get document ${documentUrl}: ${message}`);
        continue;
      }

      const html = insertPreBuiltMetadata(document);
      const filePath = pathFromUrl(this._config.root, documentUrl);
      yield new File({contents: new Buffer(html, 'utf-8'), path: filePath});
    }
  }
}

/**
 * Pre-compute the binding and property effects metadata and insert them into
 * the original document. Also remove all bindings from the template and delete
 * the `properties` block.
 *
 * @param document The document that contains the Polymer elements
 */
function insertPreBuiltMetadata(document: Document): string {
  if (!(document.parsedDocument instanceof ParsedHtmlDocument)) {
    return document.parsedDocument.contents;
  }

  const elements = document.getFeatures({kind: 'polymer-element'});

  for (const element of elements) {
    const template =
        dom5.query(element.domModule, dom5.predicates.hasTagName('template'));
    // Create the instance for every element, to avoid that all element metadata
    // is installed on the same prototype
    const ElementMixinInstance = ElementMixin(class {});
    const domTemplate = parseElementTemplate(template, ElementMixinInstance);

    processElementProperties(element, ElementMixinInstance.prototype);

    removePropertiesFromElementDefinition(element.astNode);
    serializeBindingsToScriptElement(element, domTemplate._templateInfo);
    replaceOriginalTemplate(template, domTemplate.content);
  }

  // Use stringify to make sure that the modifications to the JS AST of the
  // Polymer element are properly passed on in the stream
  return document.stringify();
}

/**
 * Parse the template using the run time instance and construct the domTemplate
 * that contains the templateInfo.
 *
 * @param template Template of the polymer element
 * @param ElementMixinInstance Run time instance to invoke `_parseTemplate` on
 */
function parseElementTemplate(
    template: parse5.ASTNode, ElementMixinInstance: any) {
  const documentFragment =
      parse5.treeAdapters.default.getTemplateContent(template);
  // Use a div rather than a document fragment, as a document fragment can not
  // set innerHTML
  const div = dom.window.document.createElement('div');
  div.innerHTML = parse5.serialize(documentFragment);

  // Mimic a regular template for `_parseTemplate`
  const domTemplate = {
    content: div,
    hasAttribute() {
      return false;
    },
    _templateInfo: false
  };

  ElementMixinInstance._parseTemplate(domTemplate, {});

  return domTemplate;
}

/**
 * Process the properties of the element, retrieve its metadata from the
 * prototype and serialize the output to the dom module of the element.
 *
 * @param element Element that contains the properties
 * @param prototype Prototype that the effect metadata is computed on
 */
function processElementProperties(element: PolymerElement, prototype: any) {
  const properties: any = {};

  for (const [k, v] of element.properties.entries()) {
    properties[k] = v;
    if (v.observer) {
      v.observer = v.observer.substring(1, v.observer.length - 1);
    }
  }

  finalizeProperties(prototype, properties);
  serializePropertyEffectsToScriptElement(element, prototype);
}

/**
 * Append the serialized computed effects to the dom module of the element.
 *
 * @param element Element to serialize effects for
 * @param prototype Prototype that contains the computed effects
 */
function serializePropertyEffectsToScriptElement(
    element: PolymerElement, prototype: any) {
  const serialized = serializeEffects(prototype);

  const script = dom5.constructors.element('script');
  dom5.setTextContent(
      script,
      `Polymer.preBuiltEffects = Polymer.preBuiltEffects || {};
Polymer.preBuiltEffects['${element.tagName}'] = ${serialized};`);

  dom5.insertBefore(element.domModule, element.domModule.childNodes[0], script);
}

/**
 * Remove the property definitions from the Polymer element.
 * Can either be the hybrid version with an object call or a class definition.
 *
 * @param astNode Node that defines the Polymer element
 */
function removePropertiesFromElementDefinition(astNode: estree.Node) {
  if (astNode.type === 'CallExpression') {
    const argument = astNode.arguments[0];

    if (argument.type === 'ObjectExpression') {
      for (let i = 0; i < argument.properties.length; i++) {
        const property = argument.properties[i];

        if (property.key.type === 'Identifier' &&
            property.key.name === 'properties') {
          argument.properties.splice(i, 1);
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
    element: PolymerElement, _templateInfo: any) {
  const script = dom5.constructors.element('script');
  const serializedTemplateInfo = serializeBindings(_templateInfo);

  dom5.setTextContent(
      script,
      `Polymer.PreBuiltBindings = Polymer.PreBuiltBindings || {};
Polymer.PreBuiltBindings['${element.tagName}'] = ${serializedTemplateInfo};`);

  dom5.insertBefore(element.domModule, element.domModule.childNodes[0], script);
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
function replaceOriginalTemplate(template: parse5.ASTNode, content: Element) {
  const replacedAst = parse5.parse(content.innerHTML);
  dom5.removeFakeRootElements(replacedAst);
  // parse5 trims whitespace before and after the HTML tree.
  // To make sure that the indices still match up, insert a text node.
  dom5.insertBefore(
      replacedAst, replacedAst.childNodes[0], dom5.constructors.text(' '));

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

/**
 * Traverse all property effects and replace the closure by the String
 * representation of the closure.
 *
 * @param propertyEffects Computed effect metadata
 */
function serializeRunTimeClosures(propertyEffects: any[]) {
  for (const effects of propertyEffects) {
    for (const effect of effects) {
      for (const [name, func] of Object.entries(EFFECT_FUNCTIONS)) {
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
