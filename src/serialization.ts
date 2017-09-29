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
import * as espree from 'espree';
import {ParsedJavaScriptDocument, PolymerElement} from 'polymer-analyzer';

/**
 * Serialize the metadata in its corresponding namespace and insert it into the
 * document.
 *
 * @param namespace The namespace which contains the definitions of the
 * pre-built output
 * @param element The current polymer element metadat is pre-built for
 * @param document The current document to insert the metadata into
 * @param metadata The computed metadata
 */
export function serializeToScriptElement(
    namespace: string,
    element: PolymerElement,
    document: ParsedJavaScriptDocument,
    metadata: string) {
  const assignment =
      espree.parse(`Polymer.${namespace}['${element.tagName}'] = ${metadata};`)
          .body;

  document.ast.body = assignment.concat(document.ast.body);
}

// Declare here to not generate any Typescript error for not finding
// `Polymer.EFFECT_FUNCTIONS`
const Polymer: any = {};

/**
 * Traverse all property effects and replace the closure by the String
 * representation of the closure.
 *
 * @param propertyEffects Computed effect metadata
 */
export function serializeRunTimeClosures(propertyEffects: any[]) {
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
 * @param prototype The prototype that contains the context for cache generation
 * of cached methods
 */
export function stripUnnecessaryEffectData(effects: any[], prototype: any) {
  prototype.context || (prototype.context = {map: new Map(), index: 0});
  for (const propertyEffects of effects) {
    for (const effect of propertyEffects) {
      if (effect.trigger) {
        // effect.trigger sometimes shares the same object with effect.info
        // Most of the time, effect.trigger is necessary, but effect.info is not
        // Therefore, make a shallow copy such that modifications do not
        // adversely corrupt effect.trigger as well.
        effect.trigger = JSON.parse(JSON.stringify(effect.trigger));
        delete effect.trigger.rootProperty;
        !effect.trigger.structured && delete effect.trigger.structured;
        !effect.trigger.wildcard && delete effect.trigger.wildcard;
      }

      if (effect.info) {
        effect.info = JSON.parse(JSON.stringify(effect.info));
        if (effect.info.args) {
          for (const arg of effect.info.args) {
            !arg.structured && delete arg.structured;
            !arg.wildcard && delete arg.wildcard;
          }
        }
        !effect.info.methodInfo && delete effect.info.methodInfo;
        !effect.info.dynamicFn && delete effect.info.dynamicFn;
        if (effect.info.cacheName) {
          let mapping = prototype.context.map.get(effect.info.cacheName);
          if (mapping === undefined) {
            mapping = (prototype.context.index++).toString();
            prototype.context.map.set(effect.info.cacheName, mapping);
          }
          effect.info.cacheName = mapping;
        }

        if (effect.info.part) {
          delete effect.info.part;
        }
      }
    }
  }
}

/**
 * Remap all effects to the the shorter integer key, to minimize the amount of
 * serialized bytes, while still preserving uniqueness of cache name keys.
 *
 * @param effects All original effects referenced by unique but long cache name
 * @param map Mapping from original cachename to short integer key
 */
export function patchUpObserverArgCache(
    effects: any, map: Map<string, string>) {
  for (const [k, v] of Object.entries(effects)) {
    effects[map.get(k)] = v;
    delete effects[k];

    for (const arg of v) {
      !arg.structured && delete arg.structured;
      !arg.wildcard && delete arg.wildcard;
    }
  }
}

/**
 * Remove unnecessary characters from the serialization:
 *    * Remove quotes in object notation
 *
 * @param metadata Metadata object to serialize to a string
 */
export function stripSerializedMetadata(metadata: any): string {
  return JSON.stringify(metadata).replace(/"(\w+)":/g, '$1:');
}