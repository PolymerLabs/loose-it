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
import * as parse5 from 'parse5';
import {ParsedJavaScriptDocument, PolymerElement} from 'polymer-analyzer';

import * as serialization from './serialization';

// To make sure names are still properly serialize to the browser, unroll the
// functions here instead of in the import
const {
  serializeRunTimeClosures,
  stripUnnecessaryEffectData,
  serializeToScriptElement,
  stripSerializedMetadata
} = serialization;

/**
 * Transform the computed bindings metadata into a string, while minimizing its
 * total size and stripping away unnecessary data.
 *
 * @param prototype Prototype that has the binding metadata to serialize
 */
export function serializeBindingsInBrowser(prototype: any): string {
  const templateInfo = prototype._template._templateInfo;
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
              for (const arg of part.dependencies) {
                !arg.structured && delete arg.structured;
                !arg.wildcard && delete arg.wildcard;
              }
              delete part.signature.args;
              delete part.signature.cacheName;
            }
          } else {
            delete part.signature;
          }
          if (part.mode) {
            binding.mode = part.mode;
            delete part.mode;
          }
          part.source === binding.target && delete part.source;

          !part.customEvent && delete part.customEvent;
          !part.negate && delete part.negate;
          part.compoundIndex === 0 && delete part.compoundIndex;
          part.signature && delete part.source;
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
  stripUnnecessaryEffectData(propertyEffects, prototype);

  const serialized = stripSerializedMetadata(templateInfo);
  return serialized.replace(
      /content:"Polymer.stringToFrag(.+?)REGEX_MARKER"/g,
      'content:Polymer.stringToFrag$1');
}

/**
 * Serialize all templates into a dom-module and append it to the document body
 * of the browser page. Then obtain the new template as output from Polymer core
 * and its corresponding templateInfo. Serialize the templateInfo to the script
 * element and replace the original template in the file stream.
 *
 * @param templateNodes All templates nodes to serialize in a dom-module
 * @param page The open browser page to evaluate scripts in
 * @param element Current element to evaluate and process template bindings for
 * @param parsedDocument The document content of this page
 */
export async function processTemplateBindings(
    templateNodes: parse5.ASTNode[],
    page: any,
    element: PolymerElement,
    parsedDocument: ParsedJavaScriptDocument) {
  const content = templateNodes.map(serializeTemplateNode).join('');

  await page.evaluate(`
    domModule = document.createElement('div');
    domModule.innerHTML = \`<dom-module id="${element.tagName}">${
      content}</dom-module>\`;
    document.body.appendChild(domModule);
  `);

  // TODO(Tim): Figure out why _registered is not called by Polymer
  // directly
  const newTemplate: string = await page.evaluate(`
    ctor = customElements.get('${element.tagName}');
    ctor.prototype._registered && ctor.prototype._registered();
    ctor.finalize();
    ctor.prototype._bindTemplate(ctor.prototype._template);
    ctor.prototype._template.innerHTML;
  `);

  const templateInfo: string = await page.evaluate(`
    serializeBindingsInBrowser(ctor.prototype);
  `);

  const template =
      dom5.query(element.domModule, dom5.predicates.hasTagName('template'));

  serializeToScriptElement(
      'PreBuiltBindings', element, parsedDocument, templateInfo);
  replaceOriginalTemplate(template, newTemplate);
}

/**
 * Serialize a template node. Strip all comments and whitespace and make it
 * referencable by id.
 *
 * @param templateNode Template node to serialize
 */
function serializeTemplateNode(templateNode: parse5.ASTNode) {
  // To make sure that indices match up of `findTemplateNode`
  // after
  // minification of unrelated nodes, we must strip both text
  // nodes and comments here. However, text nodes should only be
  // removed if they are empty. As such, use the
  // `strip-whitespace` option for that, while we can safely
  // delete all comments with dom5.
  dom5.nodeWalkAll(
          templateNode, dom5.isCommentNode, [], dom5.childNodesIncludeTemplate)
      .forEach((node) => {
        dom5.remove(node);
      });

  const serializedContent =
      parse5
          .serialize(
              parse5.treeAdapters.default.getTemplateContent(templateNode))
          .replace(/`/g, '\\`');
  const maybeId = dom5.getAttribute(templateNode, 'id');
  const templateId = maybeId ? ` id="${maybeId}"` : '';
  return `<template strip-whitespace${templateId}>${
      serializedContent}</template>`;
}

/**
 * Replace the original template in the dom module by the stripped content as a
 * result of `_parseTemplate`.
 *
 * @param template Original template in the dom module
 * @param content Templatecontent that contains the stripped content as a result
 * of `_parseTemplate`
 */
function replaceOriginalTemplate(template: parse5.ASTNode, content: string) {
  const replacedAst = parse5.parse(content);
  dom5.removeFakeRootElements(replacedAst);

  const replacedTemplate = dom5.constructors.element('template');
  parse5.treeAdapters.default.setTemplateContent(replacedTemplate, replacedAst);

  dom5.replace(template, replacedTemplate);
}
