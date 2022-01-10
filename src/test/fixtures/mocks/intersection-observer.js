/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

// Call this function inside a `describe` block to automatically define the
// intersection observer.
export function autoMockIntersectionObserver(
  root: Element | null = null,
  rootMargin: string = '',
  thresholds: $ReadOnlyArray<number> = [],
  disconnect: () => null = () => null,
  observe: (target: Element) => null = () => null,
  takeRecords: () => IntersectionObserverEntry[] = () => [],
  unobserve: (target: Element) => null = () => null
) {
  beforeEach(() => {
    const observerCallbacks = [];
    class MockIntersectionObserver {
      root: Element | null = root;
      rootMargin: string = rootMargin;
      thresholds: $ReadOnlyArray<number> = thresholds;
      disconnect: () => null = disconnect;
      observe: (target: Element) => null = observe;
      takeRecords: () => IntersectionObserverEntry[] = takeRecords;
      unobserve: (target: Element) => null = unobserve;

      constructor(callback: () => void, _options) {
        console.log('constructing', callback);
        observerCallbacks.push(callback);
      }
    }

    Object.defineProperty((window: any), 'IntersectionObserver', {
      writable: true,
      configurable: true,
      value: MockIntersectionObserver,
    });

    Object.defineProperty((global: any), 'IntersectionObserver', {
      writable: true,
      configurable: true,
      value: MockIntersectionObserver,
    });

    console.log('canova beforeeach');
    (window: any).__flushIntersectionObserver = observerCallbacks;
  });
  afterEach(() => {
    console.log('canova aftereach');
    delete (window: any).__flushIntersectionObserver;
  });
}

export function flushIntersectionObserver() {
  console.log('canova flush', (window: any).__flushIntersectionObserver);
  // (window: any).__flushIntersectionObserver.forEach((a) => a());
  window.__flushIntersectionObserver[0]();
}
