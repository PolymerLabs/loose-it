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
import {ParsedJavaScriptDocument, PolymerElement} from 'polymer-analyzer';

import * as serialization from './serialization';

// To make sure names are still properly serialize to the browser, unroll the
// functions here instead of in the import
const {
  patchUpObserverArgCache,
  serializeRunTimeClosures,
  stripUnnecessaryEffectData,
  stripSerializedMetadata,
  serializeToScriptElement
} = serialization;

/**
 * Transform the computed effects metadata into a string, while minimizing its
 * total size and stripping away unnecessary data.
 *
 * @param prototype Prototype that contains the computed property effect
 * metadata
 */
export function serializeEffectsInBrowser(prototype: any): string {
  const preBuiltEffects: {[effectType: string]: any} = {};

  for (const effectType of Object.values(prototype.PROPERTY_EFFECT_TYPES)
           .concat(['__observerArgCache'])) {
    if (prototype[effectType]) {
      preBuiltEffects[effectType] = prototype[effectType];
      serializeRunTimeClosures(Object.values(prototype[effectType]));
    }
  }

  if (prototype.__computeEffects) {
    stripUnnecessaryEffectData(
        Object.values(prototype.__computeEffects), prototype);
  }

  if (prototype.__observeEffects) {
    stripUnnecessaryEffectData(
        Object.values(prototype.__observeEffects), prototype);
  }

  if (prototype.__observerArgCache) {
    patchUpObserverArgCache(
        prototype.__observerArgCache, prototype.context.map);
  }

  const serialized = stripSerializedMetadata(preBuiltEffects);
  return serialized.replace(
      /"Polymer.EFFECT_FUNCTIONS.(\w+)"/mg, 'Polymer.EFFECT_FUNCTIONS.$1');
}

/**
 * Process the properties of the element, retrieve its metadata from the
 * prototype and serialize the output to the dom module of the element.
 *
 * @param element The element to process element properties for
 * @param document The current document that contains the element
 * @param page The open browser page to evaluate scripts in
 */
export async function processElementProperties(
    element: PolymerElement, document: ParsedJavaScriptDocument, page: any) {
  const propertyEffects = await page.evaluate(`
    serializeEffectsInBrowser(ctor.prototype)
  `);
  serializeToScriptElement(
      'preBuiltEffects', element, document, propertyEffects);
  removePropertiesFromElementDefinition(element);
}

/**
 * Remove the property definitions from the Polymer element.
 * Can either be the hybrid version with an object call or a class definition.
 *
 * @param element Element to strip properties from
 */
function removePropertiesFromElementDefinition(element: PolymerElement) {
  // TODO(Tim): This is a lot of ASTNode traversal magic and the keys
  // decrementing is very confusing. Clean this code up such that AST traversal
  // is more straightforward and that removing ASTNodes does not require magic
  // decrementing of keys.
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