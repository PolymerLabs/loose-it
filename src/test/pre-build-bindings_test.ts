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

/// <reference path="../../node_modules/@types/mocha/index.d.ts" />

import {assert} from 'chai';
import * as path from 'path';
import {PolymerProject} from 'polymer-build/lib/polymer-project';

import {PreBuildBindings} from '../pre-build-bindings';

import {emittedFiles} from './util';

const mergeStream = require('merge-stream');

const testProjectRoot = path.resolve('test-fixtures/pre-build-bindings');

suite('Prebuild bindings', function() {

  this.timeout(0);

  let project: PolymerProject;

  setup(() => {
    project =
        new PolymerProject({root: testProjectRoot, entrypoint: 'index.html'});
  });

  async function getContentFromFile(file: string) {
    const files = await emittedFiles(
        mergeStream(project.sources(), project.dependencies())
            .pipe(new PreBuildBindings(project.config)),
        project.config.root);

    return files.get(file).contents.toString();
  }

  test('removes bindings from the template', async () => {
    const html = await getContentFromFile('my-app.html');
    assert.notInclude(html, '[[');
    assert.notInclude(html, 'property=');
  });

  test('keeps literal parts in bindings', async () => {
    const html = await getContentFromFile('my-app.html');
    assert.include(html, '<div>My-element: </div>');
    // assert.include(html, 'property-with-literal="literal + "');
  });

  test(
      'replaces text content with empty space if there were no literals',
      async () => {
        const html = await getContentFromFile('my-app.html');
        assert.include(html, '<div id="text-binding"> </div>');
      });

  test(
      'removes properties from element definition with Object syntax',
      async () => {
        const html = await getContentFromFile('my-element.html');
        assert.notInclude(html, 'properties: {');
      });

  test(
      'removes properties from element definition with Class syntax',
      async () => {
        const html = await getContentFromFile('my-app.html');
        assert.notInclude(html, 'static get properties() {');
      });

  test('does not remove too many methods or properties', async () => {
    const html = await getContentFromFile('my-app.html');
    assert.include(html, '_propertyChanged(value, oldValue) {');
  });

  test('serializes preBuiltBindings', async () => {
    const html = await getContentFromFile('my-app.html');
    assert.include(html, 'Polymer.PreBuiltBindings');
  });

});
