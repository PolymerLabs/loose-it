import * as caseMap from '../utils/case-map.js';
import {get, root, translate} from '../utils/path.js';
import {sanitizeDOMValue} from '../utils/settings.js';

/** @const {Object} */
const CaseMap = caseMap;

const effectFunctions = {};

const TYPES =
    {
      COMPUTE: '__computeEffects',
      REFLECT: '__reflectEffects',
      NOTIFY: '__notifyEffects',
      PROPAGATE: '__propagateEffects',
      OBSERVE: '__observeEffects',
      READ_ONLY: '__readOnly'
    }

    /**
     * Transforms an "binding" effect value based on compound & negation
     * effect metadata, as well as handling for special-case properties
     *
     * @param {Node} node Node the value will be set to
     * @param {*} value Value to set
     * @param {!Binding} binding Binding metadata
     * @param {!BindingPart} part Binding part metadata
     * @return {*} Transformed value to set
     * @private
     */
    function computeBindingValue(node, value, binding, part) {
      if (binding.isCompound) {
        let storage = node.__dataCompoundStorage[binding.target];
        storage[part.compoundIndex || 0] = value;
        value = storage.join('');
      }
      if (binding.kind !== 'attribute') {
        // Some browsers serialize `undefined` to `"undefined"`
        if (binding.target === 'textContent' ||
            (node.localName == 'input' && binding.target == 'value')) {
          value = value == undefined ? '' : value;
        }
      }
      return value;
    }

    /**
     * Sets the value for an "binding" (binding) effect to a node,
     * either as a property or attribute.
     *
     * @param {!PropertyEffectsType} inst The instance owning the binding effect
     * @param {Node} node Target node for binding
     * @param {!Binding} binding Binding metadata
     * @param {!BindingPart} part Binding part metadata
     * @param {*} value Value to set
     * @private
     */
    function applyBindingValue(inst, node, binding, part, value) {
      value = computeBindingValue(node, value, binding, part);
      if (sanitizeDOMValue) {
        value = sanitizeDOMValue(value, binding.target, binding.kind, node);
      }
      if (binding.kind == 'attribute') {
        // Attribute binding
        inst._valueToNodeAttribute(
            /** @type {Element} */ (node), value, binding.target);
      } else {
        // Property binding
        let prop = binding.target;
        if (node.__dataHasAccessor && node.__dataHasAccessor[prop]) {
          if (!node[TYPES.READ_ONLY] || !node[TYPES.READ_ONLY][prop]) {
            if (node._setPendingProperty(prop, value)) {
              inst._enqueueClient(node);
            }
          }
        } else {
          inst._setUnmanagedPropertyToNode(node, prop, value);
        }
      }
    }
    /**
     * Implements the "binding" (property/path binding) effect.
     *
     * Note that binding syntax is overridable via `_parseBindings` and
     * `_evaluateBinding`.  This method will call `_evaluateBinding` for any
     * non-literal parts returned from `_parseBindings`.  However,
     * there is no support for _path_ bindings via custom binding parts,
     * as this is specific to Polymer's path binding syntax.
     *
     * @param {!PropertyEffectsType} inst The instance the effect will be run on
     * @param {string} path Name of property
     * @param {Object} props Bag of current property changes
     * @param {Object} oldProps Bag of previous values for changed properties
     * @param {?} info Effect metadata
     * @param {boolean} hasPaths True with `props` contains one or more paths
     * @param {Array} nodeList List of nodes associated with `nodeInfoList` template
     *   metadata
     * @private
     */
    function runBindingEffect(
        inst, path, props, oldProps, info, hasPaths, nodeList) {
      let node = nodeList[info.index];
      let binding = info.binding;
      let part = info.part;
      // Subpath notification: transform path and set to client
      // e.g.: foo="{{obj.sub}}", path: 'obj.sub.prop', set
      // 'foo.prop'=obj.sub.prop
      if (hasPaths && part.source && (path.length > part.source.length) &&
          (binding.kind === '') && !binding.isCompound &&
          node.__dataHasAccessor && node.__dataHasAccessor[binding.target]) {
        let value = props[path];
        path = translate(part.source, binding.target, path);
        if (node._setPendingPropertyOrPath(path, value, false, true)) {
          inst._enqueueClient(node);
        }
      } else {
        let value = inst.constructor._evaluateBinding(
            inst, part, path, props, oldProps, hasPaths);
        // Propagate value to child
        applyBindingValue(inst, node, binding, part, value);
      }
    } effectFunctions.runBindingEffect = runBindingEffect;

/**
 * Implements the "observer" effect.
 *
 * Calls the method with `info.methodName` on the instance, passing the
 * new and old values.
 *
 * @param {!PropertyEffectsType} inst The instance the effect will be run on
 * @param {string} property Name of property
 * @param {Object} props Bag of current property changes
 * @param {Object} oldProps Bag of previous values for changed properties
 * @param {?} info Effect metadata
 * @private
 */
function runObserverEffect(inst, property, props, oldProps, info) {
  let fn = inst[info.methodName];
  if (fn) {
    fn.call(inst, inst.__data[property], oldProps[property]);
  } else if (!info.dynamicFn) {
    console.warn('observer method `' + info.methodName + '` not defined');
  }
}
effectFunctions.runObserverEffect = runObserverEffect;

export const dispatchNotifyEvent = function dispatchNotifyEvent(
    inst, eventName, value, path) {
  let detail = {value, queueProperty: true};
  if (path) {
    detail.path = path;
  }
  /** @type {!HTMLElement} */ (inst).dispatchEvent(
      new CustomEvent(eventName, {detail}));
};

/**
 * Implements the "notify" effect.
 *
 * Dispatches a non-bubbling event named `info.eventName` on the instance
 * with a detail object containing the new `value`.
 *
 * @param {!PropertyEffectsType} inst The instance the effect will be run on
 * @param {string} property Name of property
 * @param {Object} props Bag of current property changes
 * @param {Object} oldProps Bag of previous values for changed properties
 * @param {?} info Effect metadata
 * @param {boolean} hasPaths True with `props` contains one or more paths
 * @private
 */
function runNotifyEffect(inst, property, props, oldProps, info, hasPaths) {
  let rootProperty = hasPaths ? root(property) : property;
  let path = rootProperty != property ? property : null;
  let value = path ? get(inst, path) : inst.__data[property];
  if (path && value === undefined) {
    value = props[property];  // specifically for .splices
  }
  const eventName = info.eventName ||
      (info.eventName = CaseMap.camelToDashCase(rootProperty) + '-changed');
  dispatchNotifyEvent(inst, eventName, value, path);
}
effectFunctions.runNotifyEffect = runNotifyEffect;

/**
 * Implements the "reflect" effect.
 *
 * Sets the attribute named `info.attrName` to the given property value.
 *
 * @param {!PropertyEffectsType} inst The instance the effect will be run on
 * @param {string} property Name of property
 * @param {Object} props Bag of current property changes
 * @param {Object} oldProps Bag of previous values for changed properties
 * @param {?} info Effect metadata
 * @private
 */
function runReflectEffect(inst, property, props, oldProps, info) {
  let value = inst.__data[property];
  const attrName =
      info.attrName || (info.attrName = CaseMap.camelToDashCase(property))
  if (sanitizeDOMValue) {
    value = sanitizeDOMValue(
        value, attrName, 'attribute', /** @type {Node} */ (inst));
  }
  inst._propertyToAttribute(property, attrName, value);
}
effectFunctions.runReflectEffect = runReflectEffect;

/**
 * Gather the argument values for a method specified in the provided array
 * of argument metadata.
 *
 * The `path` and `value` arguments are used to fill in wildcard descriptor
 * when the method is being called as a result of a path notification.
 *
 * @param {Object} data Instance data storage object to read properties from
 * @param {!Array<!MethodArg>} args Array of argument metadata
 * @param {string} path Property/path name that triggered the method effect
 * @param {Object} props Bag of current property changes
 * @return {Array<*>} Array of argument values
 * @private
 */
function marshalArgs(data, args, path, props) {
  let values = [];
  for (let i = 0, l = args.length; i < l; i++) {
    let arg = args[i];
    let name = arg.name || arg.rootProperty;
    let v;
    if (arg.literal) {
      v = arg.value;
    } else {
      if (arg.structured) {
        v = get(data, name);
        // when data is not stored e.g. `splices`
        if (v === undefined) {
          v = props[name];
        }
      } else {
        v = data[name];
      }
    }
    if (arg.wildcard) {
      // Only send the actual path changed info if the change that
      // caused the observer to run matched the wildcard
      let baseChanged = (name.indexOf(path + '.') === 0);
      let matches = (path.indexOf(name) === 0 && !baseChanged);
      values[i] = {
        path: matches ? path : name,
        value: matches ? props[path] : v,
        base: v
      };
    } else {
      values[i] = v;
    }
  }
  return values;
}

/**
 * Calls a method with arguments marshaled from properties on the instance
 * based on the method signature contained in the effect metadata.
 *
 * Multi-property observers, computed properties, and inline computing
 * functions call this function to invoke the method, then use the return
 * value accordingly.
 *
 * @param {!PropertyEffectsType} inst The instance the effect will be run on
 * @param {string} property Name of property
 * @param {Object} props Bag of current property changes
 * @param {Object} oldProps Bag of previous values for changed properties
 * @param {?} info Effect metadata
 * @return {*} Returns the return value from the method invocation
 * @private
 */
function runMethodEffect(inst, property, props, oldProps, info) {
  // Instances can optionally have a _methodHost which allows redirecting where
  // to find methods. Currently used by `templatize`.
  let context = inst._methodHost || inst;
  let fn = context[info.methodName];
  if (!info.args && info.cacheName) {
    info.args = inst.__observerArgCache[info.cacheName];
  }
  if (fn) {
    let args = marshalArgs(inst.__data, info.args, property, props);
    return fn.apply(context, args);
  } else if (!info.dynamicFn) {
    console.warn('method `' + info.methodName + '` not defined');
  }
}
effectFunctions.runMethodEffect = runMethodEffect;

/**
 * Implements the "computed property" effect by running the method with the
 * values of the arguments specified in the `info` object and setting the
 * return value to the computed property specified.
 *
 * @param {!PropertyEffectsType} inst The instance the effect will be run on
 * @param {string} property Name of property
 * @param {Object} props Bag of current property changes
 * @param {Object} oldProps Bag of previous values for changed properties
 * @param {?} info Effect metadata
 * @private
 */
function runComputedEffect(inst, property, props, oldProps, info) {
  let result = runMethodEffect(inst, property, props, oldProps, info);
  let computedProp = info.methodInfo;
  if (inst.__dataHasAccessor && inst.__dataHasAccessor[computedProp]) {
    inst._setPendingProperty(computedProp, result, true);
  } else {
    inst[computedProp] = result;
  }
}
effectFunctions.runComputedEffect = runComputedEffect;

export {effectFunctions as EFFECT_FUNCTIONS};