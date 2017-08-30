import './boot.js';
import {calculateSplices} from './array-splice.js';
import {microTask} from './async.js';

/**
 * Returns true if `node` is a slot element
 * @param {HTMLElement} node Node to test.
 * @return {boolean} Returns true if the given `node` is a slot
 * @private
 */
function isSlot(node) {
  return (node.localName === 'slot');
}

/**
 * Class that listens for changes (additions or removals) to
 * "flattened nodes" on a given `node`. The list of flattened nodes consists
 * of a node's children and, for any children that are `<slot>` elements,
 * the expanded flattened list of `assignedNodes`.
 * For example, if the observed node has children `<a></a><slot></slot><b></b>`
 * and the `<slot>` has one `<div>` assigned to it, then the flattened
 * nodes list is `<a></a><div></div><b></b>`. If the `<slot>` has other
 * `<slot>` elements assigned to it, these are flattened as well.
 *
 * The provided `callback` is called whenever any change to this list
 * of flattened nodes occurs, where an addition or removal of a node is
 * considered a change. The `callback` is called with one argument, an object
 * containing an array of any `addedNodes` and `removedNodes`.
 *
 * Note: the callback is called asynchronous to any changes
 * at a microtask checkpoint. This is because observation is performed using
 * `MutationObserver` and the `<slot>` element's `slotchange` event which
 * are asynchronous.
 *
 * @memberof Polymer
 * @summary Class that listens for changes (additions or removals) to
 * "flattened nodes" on a given `node`.
 */
class FlattenedNodesObserver {
  /**
   * Returns the list of flattened nodes for the given `node`.
   * This list consists of a node's children and, for any children
   * that are `<slot>` elements, the expanded flattened list of `assignedNodes`.
   * For example, if the observed node has children
   * `<a></a><slot></slot><b></b>` and the `<slot>` has one `<div>` assigned to
   * it, then the flattened nodes list is `<a></a><div></div><b></b>`. If the
   * `<slot>` has other
   * `<slot>` elements assigned to it, these are flattened as well.
   *
   * @param {HTMLElement|HTMLSlotElement} node The node for which to return the list of flattened nodes.
   * @return {Array} The list of flattened nodes for the given `node`.
   */
  static getFlattenedNodes(node) {
    if (isSlot(node)) {
      return /** @type {HTMLSlotElement} */ (node).assignedNodes(
          {flatten: true});
    } else {
      return Array.from(node.childNodes)
          .map(node => {
            if (isSlot(node)) {
              return /** @type {HTMLSlotElement} */ (node).assignedNodes(
                  {flatten: true});
            } else {
              return [node];
            }
          })
          .reduce((a, b) => a.concat(b), []);
    }
  }

  /**
   * @param {Node} target Node on which to listen for changes.
   * @param {Function} callback Function called when there are additions
   * or removals from the target's list of flattened nodes.
   */
  constructor(target, callback) {
    /** @type {MutationObserver} */
    this._shadyChildrenObserver = null;
    /** @type {MutationObserver} */
    this._nativeChildrenObserver = null;
    this._connected = false;
    this._target = target;
    this.callback = callback;
    this._effectiveNodes = [];
    this._observer = null;
    this._scheduled = false;
    /** @type {function()} */
    this._boundSchedule = () => {
      this._schedule();
    } this.connect();
    this._schedule();
  }

  /**
   * Activates an observer. This method is automatically called when
   * a `FlattenedNodesObserver` is created. It should only be called to
   * re-activate an observer that has been deactivated via the `disconnect`
   * method.
   */
  connect() {
    if (isSlot(this._target)) {
      this._listenSlots([this._target]);
    } else {
      this._listenSlots(this._target.children);
      if (window.ShadyDOM) {
        this._shadyChildrenObserver =
            ShadyDOM.observeChildren(this._target, (mutations) => {
              this._processMutations(mutations);
            });
      } else {
        this._nativeChildrenObserver = new MutationObserver((mutations) => {
          this._processMutations(mutations);
        });
        this._nativeChildrenObserver.observe(this._target, {childList: true});
      }
    }
    this._connected = true;
  }

  /**
   * Deactivates the flattened nodes observer. After calling this method
   * the observer callback will not be called when changes to flattened nodes
   * occur. The `connect` method may be subsequently called to reactivate
   * the observer.
   */
  disconnect() {
    if (isSlot(this._target)) {
      this._unlistenSlots([this._target]);
    } else {
      this._unlistenSlots(this._target.children);
      if (window.ShadyDOM && this._shadyChildrenObserver) {
        ShadyDOM.unobserveChildren(this._shadyChildrenObserver);
        this._shadyChildrenObserver = null;
      } else if (this._nativeChildrenObserver) {
        this._nativeChildrenObserver.disconnect();
        this._nativeChildrenObserver = null;
      }
    }
    this._connected = false;
  }

  _schedule() {
    if (!this._scheduled) {
      this._scheduled = true;
      microTask.run(() => this.flush());
    }
  }

  _processMutations(mutations) {
    this._processSlotMutations(mutations);
    this.flush();
  }

  _processSlotMutations(mutations) {
    if (mutations) {
      for (let i = 0; i < mutations.length; i++) {
        let mutation = mutations[i];
        if (mutation.addedNodes) {
          this._listenSlots(mutation.addedNodes);
        }
        if (mutation.removedNodes) {
          this._unlistenSlots(mutation.removedNodes);
        }
      }
    }
  }

  /**
   * Flushes the observer causing any pending changes to be immediately
   * delivered the observer callback. By default these changes are delivered
   * asynchronously at the next microtask checkpoint.
   *
   * @return {boolean} Returns true if any pending changes caused the observer
   * callback to run.
   */
  flush() {
    if (!this._connected) {
      return false;
    }
    if (window.ShadyDOM) {
      ShadyDOM.flush();
    }
    if (this._nativeChildrenObserver) {
      this._processSlotMutations(this._nativeChildrenObserver.takeRecords());
    } else if (this._shadyChildrenObserver) {
      this._processSlotMutations(this._shadyChildrenObserver.takeRecords());
    }
    this._scheduled = false;
    let info = {target: this._target, addedNodes: [], removedNodes: []};
    let newNodes = this.constructor.getFlattenedNodes(this._target);
    let splices = calculateSplices(newNodes, this._effectiveNodes);
    // process removals
    for (let i = 0, s; (i < splices.length) && (s = splices[i]); i++) {
      for (let j = 0, n; (j < s.removed.length) && (n = s.removed[j]); j++) {
        info.removedNodes.push(n);
      }
    }
    // process adds
    for (let i = 0, s; (i < splices.length) && (s = splices[i]); i++) {
      for (let j = s.index; j < s.index + s.addedCount; j++) {
        info.addedNodes.push(newNodes[j]);
      }
    }
    // update cache
    this._effectiveNodes = newNodes;
    let didFlush = false;
    if (info.addedNodes.length || info.removedNodes.length) {
      didFlush = true;
      this.callback.call(this._target, info);
    }
    return didFlush;
  }

  _listenSlots(nodeList) {
    for (let i = 0; i < nodeList.length; i++) {
      let n = nodeList[i];
      if (isSlot(n)) {
        n.addEventListener('slotchange', this._boundSchedule);
      }
    }
  }

  _unlistenSlots(nodeList) {
    for (let i = 0; i < nodeList.length; i++) {
      let n = nodeList[i];
      if (isSlot(n)) {
        n.removeEventListener('slotchange', this._boundSchedule);
      }
    }
  }
}

export {FlattenedNodesObserver};
