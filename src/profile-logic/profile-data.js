/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import memoize from 'memoize-immutable';
import MixedTupleMap from 'mixedtuplemap';
import {
  resourceTypes,
  getEmptyUnbalancedNativeAllocationsTable,
  getEmptyBalancedNativeAllocationsTable,
} from './data-structures';

import type {
  Profile,
  Thread,
  SamplesTable,
  StackTable,
  FrameTable,
  FuncTable,
  ResourceTable,
  CategoryList,
  IndexIntoCategoryList,
  IndexIntoSubcategoryListForCategory,
  IndexIntoFuncTable,
  IndexIntoSamplesTable,
  IndexIntoStackTable,
  IndexIntoResourceTable,
  ThreadIndex,
  Category,
  Counter,
  CounterSamplesTable,
  NativeAllocationsTable,
  InnerWindowID,
  BalancedNativeAllocationsTable,
  IndexIntoFrameTable,
  PageList,
  CallNodeInfo,
  CallNodeTable,
  CallNodePath,
  IndexIntoCallNodeTable,
  AccumulatedCounterSamples,
  SamplesLikeTable,
  SelectedState,
  ProfileFilterPageData,
  Milliseconds,
  StartEndRange,
  ImplementationFilter,
  CallTreeSummaryStrategy,
  EventDelayInfo,
  ThreadsKey,
} from 'firefox-profiler/types';

import { bisectionRight, bisectionLeft } from 'firefox-profiler/utils/bisect';
import {
  assertExhaustiveCheck,
  ensureExists,
  getFirstItemFromSet,
} from '../utils/flow';

import { timeCode } from '../utils/time-code';
import { hashPath } from '../utils/path';

import type { UniqueStringArray } from '../utils/unique-string-array';

/**
 * Various helpers for dealing with the profile as a data structure.
 * @module profile-data
 */

/**
 * Generate the CallNodeInfo which contains the CallNodeTable, and a map to convert
 * an IndexIntoStackTable to a IndexIntoCallNodeTable. This function runs through
 * a stackTable, and de-duplicates stacks that have frames that point to the same
 * function.
 *
 * See `src/types/profile-derived.js` for the type definitions.
 * See `docs-developer/call-trees.md` for a detailed explanation of CallNodes.
 */
export function getCallNodeInfo(
  stackTable: StackTable,
  frameTable: FrameTable,
  funcTable: FuncTable,
  defaultCategory: IndexIntoCategoryList
): CallNodeInfo {
  return timeCode('getCallNodeInfo', () => {
    const stackIndexToCallNodeIndex = new Uint32Array(stackTable.length);
    const funcCount = funcTable.length;
    // Maps can't key off of two items, so combine the prefixCallNode and the funcIndex
    // using the following formula: prefixCallNode * funcCount + funcIndex => callNode
    const prefixCallNodeAndFuncToCallNodeMap = new Map();

    // The callNodeTable components.
    const prefix: Array<IndexIntoCallNodeTable> = [];
    const func: Array<IndexIntoFuncTable> = [];
    const category: Array<IndexIntoCategoryList> = [];
    const subcategory: Array<IndexIntoSubcategoryListForCategory> = [];
    const innerWindowID: Array<InnerWindowID> = [];
    const depth: Array<number> = [];
    let length = 0;

    function addCallNode(
      prefixIndex: IndexIntoCallNodeTable,
      funcIndex: IndexIntoFuncTable,
      categoryIndex: IndexIntoCategoryList,
      subcategoryIndex: IndexIntoSubcategoryListForCategory,
      windowID: InnerWindowID
    ) {
      const index = length++;
      prefix[index] = prefixIndex;
      func[index] = funcIndex;
      category[index] = categoryIndex;
      subcategory[index] = subcategoryIndex;
      innerWindowID[index] = windowID;
      if (prefixIndex === -1) {
        depth[index] = 0;
      } else {
        depth[index] = depth[prefixIndex] + 1;
      }
    }

    // Go through each stack, and create a new callNode table, which is based off of
    // functions rather than frames.
    for (let stackIndex = 0; stackIndex < stackTable.length; stackIndex++) {
      const prefixStack = stackTable.prefix[stackIndex];
      // We know that at this point the following condition holds:
      // assert(prefixStack === null || prefixStack < stackIndex);
      const prefixCallNode =
        prefixStack === null ? -1 : stackIndexToCallNodeIndex[prefixStack];
      const frameIndex = stackTable.frame[stackIndex];
      const categoryIndex = stackTable.category[stackIndex];
      const subcategoryIndex = stackTable.subcategory[stackIndex];
      const windowID = frameTable.innerWindowID[frameIndex] || 0;
      const funcIndex = frameTable.func[frameIndex];
      const prefixCallNodeAndFuncIndex = prefixCallNode * funcCount + funcIndex;
      let callNodeIndex = prefixCallNodeAndFuncToCallNodeMap.get(
        prefixCallNodeAndFuncIndex
      );
      if (callNodeIndex === undefined) {
        callNodeIndex = length;
        addCallNode(
          prefixCallNode,
          funcIndex,
          categoryIndex,
          subcategoryIndex,
          windowID
        );
        prefixCallNodeAndFuncToCallNodeMap.set(
          prefixCallNodeAndFuncIndex,
          callNodeIndex
        );
      } else if (category[callNodeIndex] !== categoryIndex) {
        // Conflicting origin stack categories -> default category + subcategory.
        category[callNodeIndex] = defaultCategory;
        subcategory[callNodeIndex] = 0;
      } else if (subcategory[callNodeIndex] !== subcategoryIndex) {
        // Conflicting origin stack subcategories -> "Other" subcategory.
        subcategory[callNodeIndex] = 0;
      }
      stackIndexToCallNodeIndex[stackIndex] = callNodeIndex;
    }

    const callNodeTable: CallNodeTable = {
      prefix: new Int32Array(prefix),
      func: new Int32Array(func),
      category: new Int32Array(category),
      subcategory: new Int32Array(subcategory),
      innerWindowID: new Float64Array(innerWindowID),
      depth,
      length,
    };

    return { callNodeTable, stackIndexToCallNodeIndex };
  });
}

/**
 * Take a samples table, and return an array that contain indexes that point to the
 * leaf most call node, or null.
 */
export function getSampleIndexToCallNodeIndex(
  stacks: Array<IndexIntoStackTable | null>,
  stackIndexToCallNodeIndex: {
    [key: IndexIntoStackTable]: IndexIntoCallNodeTable,
  }
): Array<IndexIntoCallNodeTable | null> {
  return stacks.map(stack => {
    return stack === null ? null : stackIndexToCallNodeIndex[stack];
  });
}

/**
 * Go through the samples, and determine their current state.
 *
 * For samples that are neither 'FILTERED_OUT_*' nor 'SELECTED', this function compares
 * the sample's call node to the selected call node, in tree order. It uses the same
 * ordering as the function compareCallNodes in getTreeOrderComparator. But it does not
 * call compareCallNodes with the selected node for each sample's call node, because doing
 * so would recompute information about the selected call node on every call. Instead, it
 * has an equivalent implementation that is faster because it only computes information
 * about the selected call node's ancestors once.
 */
export function getSamplesSelectedStates(
  callNodeTable: CallNodeTable,
  sampleCallNodes: Array<IndexIntoCallNodeTable | null>,
  activeTabFilteredCallNodes: Array<IndexIntoCallNodeTable | null>,
  selectedCallNodeIndex: IndexIntoCallNodeTable | null
): SelectedState[] {
  const result = new Array(sampleCallNodes.length);

  // Precompute an array containing the call node indexes for the selected call
  // node and its parents up to the root.
  // The case of when we have no selected call node is a special case: we won't
  // use these values but we still compute them to make the code simpler later.
  const selectedCallNodeDepth =
    selectedCallNodeIndex === -1 || selectedCallNodeIndex === null
      ? 0
      : callNodeTable.depth[selectedCallNodeIndex];

  const selectedCallNodeAtDepth: IndexIntoCallNodeTable[] = new Array(
    selectedCallNodeDepth
  );

  for (
    let callNodeIndex = selectedCallNodeIndex, depth = selectedCallNodeDepth;
    depth >= 0 && callNodeIndex !== null;
    depth--, callNodeIndex = callNodeTable.prefix[callNodeIndex]
  ) {
    selectedCallNodeAtDepth[depth] = callNodeIndex;
  }

  /**
   * Take a call node, and compute its selected state.
   */
  function getSelectedStateFromCallNode(
    callNode: IndexIntoCallNodeTable | null,
    activeTabFilteredCallNode: IndexIntoCallNodeTable | null
  ): SelectedState {
    let callNodeIndex = callNode;
    if (callNodeIndex === null) {
      return activeTabFilteredCallNode === null
        ? // This sample was not part of the active tab.
          'FILTERED_OUT_BY_ACTIVE_TAB'
        : // This sample was filtered out in the transform pipeline.
          'FILTERED_OUT_BY_TRANSFORM';
    }

    // When there's no selected call node, we don't want to shadow everything
    // because everything is unselected. So let's decide this is as if
    // everything is selected so that anything not filtered out will be nicely
    // visible.
    if (selectedCallNodeIndex === null) {
      return 'SELECTED';
    }

    // Walk the call nodes toward the root, and get the call node at the depth
    // of the selected call node.
    let depth = callNodeTable.depth[callNodeIndex];
    while (depth > selectedCallNodeDepth) {
      callNodeIndex = callNodeTable.prefix[callNodeIndex];
      depth--;
    }

    if (callNodeIndex === selectedCallNodeIndex) {
      // This sample's call node at the depth matches the selected call node.
      return 'SELECTED';
    }

    // If we're here, it means that callNode is not selected, because it's not
    // an ancestor of selectedCallNodeIndex.
    // Determine if it's ordered "before" or "after" the selected call node,
    // in order to provide a stable ordering when rendering visualizations.
    // Walk the call nodes towards the root, until we find the common ancestor.
    // Once we've found the common ancestor, compare the order of the two
    // child nodes that we passed through, which are siblings.
    while (true) {
      const prevCallNodeIndex = callNodeIndex;
      callNodeIndex = callNodeTable.prefix[callNodeIndex];
      depth--;
      if (
        callNodeIndex === -1 ||
        callNodeIndex === selectedCallNodeAtDepth[depth]
      ) {
        // callNodeIndex is the lowest common ancestor of selectedCallNodeIndex
        // and callNode. Compare the order of the two children that we passed
        // through on the way up to the ancestor. These nodes are siblings, so
        // their order is defined by the numerical order of call node indexes.
        return prevCallNodeIndex <= selectedCallNodeAtDepth[depth + 1]
          ? 'UNSELECTED_ORDERED_BEFORE_SELECTED'
          : 'UNSELECTED_ORDERED_AFTER_SELECTED';
      }
    }

    // This code is unreachable, but Flow doesn't know that and thinks this
    // function could return undefined. So throw an error.
    /* eslint-disable no-unreachable */
    throw new Error('unreachable');
    /* eslint-enable no-unreachable */
  }

  // Go through each sample, and label its state.
  for (
    let sampleIndex = 0;
    sampleIndex < sampleCallNodes.length;
    sampleIndex++
  ) {
    result[sampleIndex] = getSelectedStateFromCallNode(
      sampleCallNodes[sampleIndex],
      activeTabFilteredCallNodes[sampleIndex]
    );
  }
  return result;
}

/**
 * This function returns the function index for a specific call node path. This
 * is the last element of this path, or the leaf element of the path.
 */
export function getLeafFuncIndex(path: CallNodePath): IndexIntoFuncTable {
  if (path.length === 0) {
    throw new Error("getLeafFuncIndex assumes that the path isn't empty.");
  }

  return path[path.length - 1];
}

export type JsImplementation =
  | 'interpreter'
  | 'blinterp'
  | 'baseline'
  | 'ion'
  | 'unknown';
export type StackImplementation = 'native' | JsImplementation;
export type BreakdownByImplementation = { [StackImplementation]: Milliseconds };
export type OneCategoryBreakdown = {|
  entireCategoryValue: Milliseconds,
  subcategoryBreakdown: Milliseconds[], // { [IndexIntoSubcategoryList]: Milliseconds }
|};
export type BreakdownByCategory = OneCategoryBreakdown[]; // { [IndexIntoCategoryList]: OneCategoryBreakdown }
type ItemTimings = {|
  selfTime: {|
    // time spent excluding children
    value: Milliseconds,
    breakdownByImplementation: BreakdownByImplementation | null,
    breakdownByCategory: BreakdownByCategory | null,
  |},
  totalTime: {|
    // time spent including children
    value: Milliseconds,
    breakdownByImplementation: BreakdownByImplementation | null,
    breakdownByCategory: BreakdownByCategory | null,
  |},
|};

export type TimingsForPath = {|
  // timings for this path
  forPath: ItemTimings,
  // timings for this func across the tree
  forFunc: ItemTimings,
  rootTime: Milliseconds, // time for all the samples in the current tree
|};

/**
 * This function is the same as getTimingsForPath, but accepts an IndexIntoCallNodeTable
 * instead of a CallNodePath.
 */
export function getTimingsForPath(
  needlePath: CallNodePath,
  callNodeInfo: CallNodeInfo,
  interval: Milliseconds,
  isInvertedTree: boolean,
  thread: Thread,
  unfilteredThread: Thread,
  sampleIndexOffset: number,
  categories: CategoryList,
  samples: SamplesLikeTable,
  unfilteredSamples: SamplesLikeTable
) {
  return getTimingsForCallNodeIndex(
    getCallNodeIndexFromPath(needlePath, callNodeInfo.callNodeTable),
    callNodeInfo,
    interval,
    isInvertedTree,
    thread,
    unfilteredThread,
    sampleIndexOffset,
    categories,
    samples,
    unfilteredSamples
  );
}

/**
 * This function returns the timings for a specific path. The algorithm is
 * adjusted when the call tree is inverted.
 * Note that the unfilteredThread should be the original thread before any filtering
 * (by range or other) happens. Also sampleIndexOffset needs to be properly
 * specified and is the offset to be applied on thread's indexes to access
 * the same samples in unfilteredThread.
 */
export function getTimingsForCallNodeIndex(
  needleNodeIndex: IndexIntoCallNodeTable | null,
  { callNodeTable, stackIndexToCallNodeIndex }: CallNodeInfo,
  interval: Milliseconds,
  isInvertedTree: boolean,
  thread: Thread,
  unfilteredThread: Thread,
  sampleIndexOffset: number,
  categories: CategoryList,
  samples: SamplesLikeTable,
  unfilteredSamples: SamplesLikeTable
): TimingsForPath {
  /* ------------ Variables definitions ------------*/

  // This is the data from the filtered thread that we'll loop over.
  const { stackTable, stringTable } = thread;

  // This is the data from the unfiltered thread that we'll use to gather
  // category and JS implementation information. Note that samples are offset by
  // `sampleIndexOffset` because of range filtering.
  const {
    stackTable: unfilteredStackTable,
    funcTable: unfilteredFuncTable,
    frameTable: unfilteredFrameTable,
  } = unfilteredThread;

  // This holds the category index for the JavaScript category, so that we can
  // use it to quickly check the category later on.
  const javascriptCategoryIndex = categories.findIndex(
    ({ name }) => name === 'JavaScript'
  );

  // This object holds the timings for the current call node path, specified by
  // needleNodeIndex.
  const pathTimings: ItemTimings = {
    selfTime: {
      value: 0,
      breakdownByImplementation: null,
      breakdownByCategory: null,
    },
    totalTime: {
      value: 0,
      breakdownByImplementation: null,
      breakdownByCategory: null,
    },
  };

  // This object holds the timings for the function (all occurrences) pointed by
  // the specified call node.
  const funcTimings: ItemTimings = {
    selfTime: {
      value: 0,
      breakdownByImplementation: null,
      breakdownByCategory: null,
    },
    totalTime: {
      value: 0,
      breakdownByImplementation: null,
      breakdownByCategory: null,
    },
  };

  // This holds the root time, it's incremented for all samples and is useful to
  // have an absolute value to compare the other values with.
  let rootTime = 0;

  /* -------- End of variable definitions ------- */

  /* ------------ Functions definitions --------- *
   * We define functions here so that they have easy access to the variables and
   * the algorithm's parameters. */

  /**
   * This function is called for native stacks. If the native stack has the
   * 'JavaScript' category, then we move up the call tree to find the nearest
   * ancestor that's JS and returns its JS implementation.
   */
  function getImplementationForNativeStack(
    unfilteredStackIndex: IndexIntoStackTable
  ): StackImplementation {
    const category = unfilteredStackTable.category[unfilteredStackIndex];
    if (category !== javascriptCategoryIndex) {
      return 'native';
    }

    for (
      let currentStackIndex = unfilteredStackIndex;
      currentStackIndex !== null;
      currentStackIndex = unfilteredStackTable.prefix[currentStackIndex]
    ) {
      const frameIndex = unfilteredStackTable.frame[currentStackIndex];
      const funcIndex = unfilteredFrameTable.func[frameIndex];
      const isJS = unfilteredFuncTable.isJS[funcIndex];
      if (isJS) {
        return getImplementationForJsStack(frameIndex);
      }
    }

    // No JS frame was found in the ancestors, this is weird but why not?
    return 'native';
  }

  /**
   * This function Returns the JS implementation information for a specific JS stack.
   */
  function getImplementationForJsStack(
    unfilteredFrameIndex: IndexIntoFrameTable
  ): JsImplementation {
    const jsImplementationStrIndex =
      unfilteredFrameTable.implementation[unfilteredFrameIndex];

    if (jsImplementationStrIndex === null) {
      return 'interpreter';
    }

    const jsImplementation = stringTable.getString(jsImplementationStrIndex);

    switch (jsImplementation) {
      case 'baseline':
      case 'blinterp':
      case 'ion':
        return jsImplementation;
      default:
        return 'unknown';
    }
  }

  function getImplementationForStack(
    thisSampleIndex: IndexIntoSamplesTable
  ): StackImplementation {
    const stackIndex =
      unfilteredSamples.stack[thisSampleIndex + sampleIndexOffset];
    if (stackIndex === null) {
      // This should not happen in the unfiltered thread.
      console.error('We got a null stack, this should not happen.');
      return 'native';
    }

    const frameIndex = unfilteredStackTable.frame[stackIndex];
    const funcIndex = unfilteredFrameTable.func[frameIndex];
    const implementation = unfilteredFuncTable.isJS[funcIndex]
      ? getImplementationForJsStack(frameIndex)
      : getImplementationForNativeStack(stackIndex);

    return implementation;
  }

  /**
   * This is a small utility function to more easily add data to breakdowns.
   * The funcIndex could be computed from the stackIndex but is provided as an
   * argument because it's been already computed when this function is called.
   */
  function accumulateDataToTimings(
    timings: {
      breakdownByImplementation: BreakdownByImplementation | null,
      breakdownByCategory: BreakdownByCategory | null,
      value: number,
    },
    sampleIndex: IndexIntoSamplesTable,
    stackIndex: IndexIntoStackTable,
    duration: Milliseconds
  ): void {
    // Step 1: increment the total value
    timings.value += duration;

    // Step 2: find the implementation value for this sample
    const implementation = getImplementationForStack(sampleIndex);

    // Step 3: increment the right value in the implementation breakdown
    if (timings.breakdownByImplementation === null) {
      timings.breakdownByImplementation = {};
    }
    if (timings.breakdownByImplementation[implementation] === undefined) {
      timings.breakdownByImplementation[implementation] = 0;
    }
    timings.breakdownByImplementation[implementation] += duration;

    // step 4: find the category value for this stack. We want to use the
    // category of the unfilteredThread.
    const unfilteredStackIndex =
      unfilteredSamples.stack[sampleIndex + sampleIndexOffset];
    if (unfilteredStackIndex !== null) {
      const categoryIndex = unfilteredStackTable.category[unfilteredStackIndex];
      const subcategoryIndex =
        unfilteredStackTable.subcategory[unfilteredStackIndex];

      // step 5: increment the right value in the category breakdown
      if (timings.breakdownByCategory === null) {
        timings.breakdownByCategory = categories.map(category => ({
          entireCategoryValue: 0,
          subcategoryBreakdown: Array(category.subcategories.length).fill(0),
        }));
      }
      timings.breakdownByCategory[
        categoryIndex
      ].entireCategoryValue += duration;
      timings.breakdownByCategory[categoryIndex].subcategoryBreakdown[
        subcategoryIndex
      ] += duration;
    }
  }
  /* ------------- End of function definitions ------------- */

  /* ------------ Start of the algorithm itself ------------ */
  if (needleNodeIndex === null) {
    // No index was provided, return empty timing information.
    return { forPath: pathTimings, forFunc: funcTimings, rootTime };
  }

  // This is the function index for this call node.
  const needleFuncIndex = callNodeTable.func[needleNodeIndex];

  // Loop over each sample and accumulate the self time, running time, and
  // the implementation breakdown.
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    const thisStackIndex = samples.stack[sampleIndex];
    if (thisStackIndex === null) {
      continue;
    }

    const weight = samples.weight ? samples.weight[sampleIndex] : 1;

    rootTime += Math.abs(weight);

    const thisNodeIndex = stackIndexToCallNodeIndex[thisStackIndex];
    const thisFunc = callNodeTable.func[thisNodeIndex];

    if (!isInvertedTree) {
      // For non-inverted trees, we compute the self time from the stacks' leaf nodes.
      if (thisNodeIndex === needleNodeIndex) {
        accumulateDataToTimings(
          pathTimings.selfTime,
          sampleIndex,
          thisStackIndex,
          weight
        );
      }

      if (thisFunc === needleFuncIndex) {
        accumulateDataToTimings(
          funcTimings.selfTime,
          sampleIndex,
          thisStackIndex,
          weight
        );
      }
    }

    // Use the stackTable to traverse the call node path and get various
    // measurements.
    // We don't use getCallNodePathFromIndex because we don't need the result
    // itself, and it's costly to get. Moreover we can break out of the loop
    // early if necessary.
    let funcFound = false;
    let pathFound = false;
    let nextStackIndex;
    for (
      let currentStackIndex = thisStackIndex;
      currentStackIndex !== null;
      currentStackIndex = nextStackIndex
    ) {
      const currentNodeIndex = stackIndexToCallNodeIndex[currentStackIndex];
      const currentFuncIndex = callNodeTable.func[currentNodeIndex];
      nextStackIndex = stackTable.prefix[currentStackIndex];

      if (currentNodeIndex === needleNodeIndex) {
        // One of the parents is the exact passed path.
        // For non-inverted trees, we can contribute the data to the
        // implementation breakdown now.
        // Note that for inverted trees, we need to traverse up to the root node
        // first, see below for this.
        if (!isInvertedTree) {
          accumulateDataToTimings(
            pathTimings.totalTime,
            sampleIndex,
            thisStackIndex,
            weight
          );
        }

        pathFound = true;
      }

      if (!funcFound && currentFuncIndex === needleFuncIndex) {
        // One of the parents' func is the same function as the passed path.
        // Note we could have the same function several times in the stack, so
        // we need a boolean variable to prevent adding it more than once.
        // The boolean variable will also be used to accumulate timings for
        // inverted trees below.
        if (!isInvertedTree) {
          accumulateDataToTimings(
            funcTimings.totalTime,
            sampleIndex,
            thisStackIndex,
            weight
          );
        }
        funcFound = true;
      }

      // When the tree isn't inverted, we don't need to move further up the call
      // node if we already found all the data.
      // But for inverted trees, the selfTime is counted on the root node so we
      // need to go on looping the stack until we find it.

      if (!isInvertedTree && funcFound && pathFound) {
        // As explained above, for non-inverted trees, we can break here if we
        // found everything already.
        break;
      }

      if (isInvertedTree && nextStackIndex === null) {
        // This is an inverted tree, and we're at the root node because its
        // prefix is `null`.
        if (currentNodeIndex === needleNodeIndex) {
          // This root node matches the passed call node path.
          // This is the only place where we don't accumulate timings, mainly
          // because this would be the same as for the total time.
          pathTimings.selfTime.value += weight;
        }

        if (currentFuncIndex === needleFuncIndex) {
          // This root node is the same function as the passed call node path.
          accumulateDataToTimings(
            funcTimings.selfTime,
            sampleIndex,
            currentStackIndex,
            weight
          );
        }

        if (pathFound) {
          // We contribute the implementation information if the passed path was
          // found in this stack earlier.
          accumulateDataToTimings(
            pathTimings.totalTime,
            sampleIndex,
            currentStackIndex,
            weight
          );
        }

        if (funcFound) {
          // We contribute the implementation information if the leaf function
          // of the passed path was found in this stack earlier.
          accumulateDataToTimings(
            funcTimings.totalTime,
            sampleIndex,
            currentStackIndex,
            weight
          );
        }
      }
    }
  }

  return { forPath: pathTimings, forFunc: funcTimings, rootTime };
}

// This function computes the time range for a thread, using both its samples
// and markers data. It's memoized and exported below, because it's called both
// here in getTimeRangeIncludingAllThreads, and in selectors when dealing with
// markers.
// Because `getTimeRangeIncludingAllThreads` is called in a reducer and it's
// quite complex to change this, the memoization happens here.
// When changing the signature, please accordingly check that the map class used
// for memoization is still the right one.
function _getTimeRangeForThread(
  { samples, markers, jsAllocations, nativeAllocations }: Thread,
  interval: Milliseconds
): StartEndRange {
  const result = { start: Infinity, end: -Infinity };

  if (samples.length) {
    const lastSampleIndex = samples.length - 1;
    result.start = samples.time[0];
    result.end = samples.time[lastSampleIndex] + interval;
  } else if (markers.length) {
    // Looking at the markers only if there are no samples in the profile.
    // We need to look at those because it can be a marker only profile(no-sampling mode).
    // Finding start and end times sadly requires looping through all markers :(
    for (let i = 0; i < markers.length; i++) {
      const startTime = markers.startTime[i];
      const endTime = markers.endTime[i];
      // The resulting range needs to adjust BOTH the start and end of the range, as
      // each marker type could adjust the total range beyond the current bounds.
      // Note the use of Math.min and Math.max are different for the start and end
      // of the markers.

      if (startTime !== null) {
        // This is either an Instant, IntervalStart, or Interval marker.
        result.start = Math.min(result.start, startTime);
        result.end = Math.max(result.end, startTime + interval);
      }
      if (endTime !== null) {
        // This is either an Interval or IntervalEnd marker.
        result.start = Math.min(result.start, endTime);
        result.end = Math.max(result.end, endTime + interval);
      }
    }
  }

  if (jsAllocations) {
    // For good measure, also check the allocations. This is mainly so that tests
    // will behave nicely.
    const lastIndex = jsAllocations.length - 1;
    result.start = Math.min(result.start, jsAllocations.time[0]);
    result.end = Math.max(result.end, jsAllocations.time[lastIndex] + interval);
  }

  if (nativeAllocations) {
    // For good measure, also check the allocations. This is mainly so that tests
    // will behave nicely.
    const lastIndex = nativeAllocations.length - 1;
    result.start = Math.min(result.start, nativeAllocations.time[0]);
    result.end = Math.max(
      result.end,
      nativeAllocations.time[lastIndex] + interval
    );
  }

  return result;
}

// We do a full memoization because it's called for several different threads.
// But it won't be called more than once per thread.
// Note that because MixedTupleMap internally uses a WeakMap, it should properly
// free the memory when we load another profile (for example when dealing with
// zip files).
const memoizedGetTimeRangeForThread = memoize(_getTimeRangeForThread, {
  // We use a MixedTupleMap because the function takes both primitive and
  // complex types.
  cache: new MixedTupleMap(),
});
export { memoizedGetTimeRangeForThread as getTimeRangeForThread };

export function getTimeRangeIncludingAllThreads(
  profile: Profile
): StartEndRange {
  const completeRange = { start: Infinity, end: -Infinity };
  profile.threads.forEach(thread => {
    const threadRange = memoizedGetTimeRangeForThread(
      thread,
      profile.meta.interval
    );
    completeRange.start = Math.min(completeRange.start, threadRange.start);
    completeRange.end = Math.max(completeRange.end, threadRange.end);
  });
  return completeRange;
}

export function defaultThreadOrder(threads: Thread[]): ThreadIndex[] {
  const threadOrder = threads.map((thread, i) => i);

  // Note: to have a consistent behavior independant of the sorting algorithm,
  // we need to be careful that the comparator function is consistent:
  // comparator(a, b) === - comparator(b, a)
  // and
  // comparator(a, b) === 0   if and only if   a === b
  threadOrder.sort((a, b) => {
    const nameA = threads[a].name;
    const nameB = threads[b].name;

    if (nameA === nameB) {
      return a - b;
    }

    // Put the compositor/renderer thread last.
    // Compositor will always be before Renderer, if both are present.
    if (nameA === 'Compositor') {
      return 1;
    }

    if (nameB === 'Compositor') {
      return -1;
    }

    if (nameA === 'Renderer') {
      return 1;
    }

    if (nameB === 'Renderer') {
      return -1;
    }

    // Otherwise keep the existing order. We don't return 0 to guarantee that
    // the sort is stable even if the sort algorithm isn't.
    return a - b;
  });
  return threadOrder;
}

export function toValidImplementationFilter(
  implementation: string
): ImplementationFilter {
  switch (implementation) {
    case 'cpp':
    case 'js':
      return implementation;
    default:
      return 'combined';
  }
}

export function toValidCallTreeSummaryStrategy(
  strategy: mixed
): CallTreeSummaryStrategy {
  switch (strategy) {
    case 'timing':
    case 'js-allocations':
    case 'native-retained-allocations':
    case 'native-allocations':
    case 'native-deallocations-sites':
    case 'native-deallocations-memory':
      return strategy;
    default:
      // Default to "timing" if the strategy is not recognized. This value can come
      // from a user-generated URL.
      // e.g. `profiler.firefox.com/public/hash/ctSummary=tiiming` (note the typo.)
      // This default branch will ensure we don't send values we don't understand to
      // the store.
      return 'timing';
  }
}

export function filterThreadByImplementation(
  thread: Thread,
  implementation: string,
  defaultCategory: IndexIntoCategoryList
): Thread {
  const { funcTable, stringTable } = thread;

  switch (implementation) {
    case 'cpp':
      return _filterThreadByFunc(
        thread,
        funcIndex => {
          // Return quickly if this is a JS frame.
          if (funcTable.isJS[funcIndex]) {
            return false;
          }
          // Regular C++ functions are associated with a resource that describes the
          // shared library that these C++ functions were loaded from. Jitcode is not
          // loaded from shared libraries but instead generated at runtime, so Jitcode
          // frames are not associated with a shared library and thus have no resource
          const locationString = stringTable.getString(
            funcTable.name[funcIndex]
          );
          const isProbablyJitCode =
            funcTable.resource[funcIndex] === -1 &&
            locationString.startsWith('0x');
          return !isProbablyJitCode;
        },
        defaultCategory
      );
    case 'js':
      return _filterThreadByFunc(
        thread,
        funcIndex => {
          return (
            funcTable.isJS[funcIndex] || funcTable.relevantForJS[funcIndex]
          );
        },
        defaultCategory
      );
    default:
      return thread;
  }
}

function _filterThreadByFunc(
  thread: Thread,
  filter: IndexIntoFuncTable => boolean,
  defaultCategory: IndexIntoCallNodeTable
): Thread {
  return timeCode('filterThread', () => {
    const { stackTable, frameTable } = thread;

    const newStackTable = {
      length: 0,
      frame: [],
      prefix: [],
      category: [],
      subcategory: [],
    };

    const oldStackToNewStack = new Map();
    const frameCount = frameTable.length;
    const prefixStackAndFrameToStack = new Map(); // prefixNewStack * frameCount + frame => newStackIndex

    function convertStack(stackIndex) {
      if (stackIndex === null) {
        return null;
      }
      let newStack = oldStackToNewStack.get(stackIndex);
      if (newStack === undefined) {
        const prefixNewStack = convertStack(stackTable.prefix[stackIndex]);
        const frameIndex = stackTable.frame[stackIndex];
        const funcIndex = frameTable.func[frameIndex];
        if (filter(funcIndex)) {
          const prefixStackAndFrameIndex =
            (prefixNewStack === null ? -1 : prefixNewStack) * frameCount +
            frameIndex;
          newStack = prefixStackAndFrameToStack.get(prefixStackAndFrameIndex);
          if (newStack === undefined) {
            newStack = newStackTable.length++;
            newStackTable.prefix[newStack] = prefixNewStack;
            newStackTable.frame[newStack] = frameIndex;
            newStackTable.category[newStack] = stackTable.category[stackIndex];
            newStackTable.subcategory[newStack] =
              stackTable.subcategory[stackIndex];
          } else if (
            newStackTable.category[newStack] !== stackTable.category[stackIndex]
          ) {
            // Conflicting origin stack categories -> default category + subcategory.
            newStackTable.category[newStack] = defaultCategory;
            newStackTable.subcategory[newStack] = 0;
          } else if (
            newStackTable.subcategory[stackIndex] !==
            stackTable.subcategory[stackIndex]
          ) {
            // Conflicting origin stack subcategories -> "Other" subcategory.
            newStackTable.subcategory[stackIndex] = 0;
          }
          oldStackToNewStack.set(stackIndex, newStack);
          prefixStackAndFrameToStack.set(prefixStackAndFrameIndex, newStack);
        } else {
          newStack = prefixNewStack;
        }
      }
      return newStack;
    }

    return updateThreadStacks(thread, newStackTable, convertStack);
  });
}

export function filterThreadToSearchStrings(
  thread: Thread,
  searchStrings: string[] | null
): Thread {
  return timeCode('filterThreadToSearchStrings', () => {
    if (!searchStrings || !searchStrings.length) {
      return thread;
    }

    return searchStrings.reduce(filterThreadToSearchString, thread);
  });
}

export function filterThreadToSearchString(
  thread: Thread,
  searchString: string
): Thread {
  if (!searchString) {
    return thread;
  }
  const lowercaseSearchString = searchString.toLowerCase();
  const {
    funcTable,
    frameTable,
    stackTable,
    stringTable,
    resourceTable,
  } = thread;

  function computeFuncMatchesFilter(func) {
    const nameIndex = funcTable.name[func];
    const nameString = stringTable.getString(nameIndex);
    if (nameString.toLowerCase().includes(lowercaseSearchString)) {
      return true;
    }

    const fileNameIndex = funcTable.fileName[func];
    if (fileNameIndex !== null) {
      const fileNameString = stringTable.getString(fileNameIndex);
      if (fileNameString.toLowerCase().includes(lowercaseSearchString)) {
        return true;
      }
    }

    const resourceIndex = funcTable.resource[func];
    const resourceNameIndex = resourceTable.name[resourceIndex];
    if (resourceNameIndex !== undefined) {
      const resourceNameString = stringTable.getString(resourceNameIndex);
      if (resourceNameString.toLowerCase().includes(lowercaseSearchString)) {
        return true;
      }
    }

    return false;
  }

  const funcMatchesFilterCache = new Map();
  function funcMatchesFilter(func) {
    let result = funcMatchesFilterCache.get(func);
    if (result === undefined) {
      result = computeFuncMatchesFilter(func);
      funcMatchesFilterCache.set(func, result);
    }
    return result;
  }

  const stackMatchesFilterCache = new Map();
  function stackMatchesFilter(stackIndex) {
    if (stackIndex === null) {
      return false;
    }
    let result = stackMatchesFilterCache.get(stackIndex);
    if (result === undefined) {
      const prefix = stackTable.prefix[stackIndex];
      if (stackMatchesFilter(prefix)) {
        result = true;
      } else {
        const frame = stackTable.frame[stackIndex];
        const func = frameTable.func[frame];
        result = funcMatchesFilter(func);
      }
      stackMatchesFilterCache.set(stackIndex, result);
    }
    return result;
  }

  return updateThreadStacks(thread, stackTable, stackIndex =>
    stackMatchesFilter(stackIndex) ? stackIndex : null
  );
}

/**
 * We have page data(innerWindowID) inside the JS frames. Go through each sample
 * and filter out the ones that don't include any JS frame with the relevant innerWindowID.
 * Please note that it also keeps native frames if that sample has a relevant JS
 * frame in any part of the stack. Also it doesn't mutate the stack itself, only
 * nulls the stack array elements of samples object. Therefore, it doesn't
 * invalidate transforms.
 * If we don't have any item in relevantPages, returns all the samples.
 */
export function filterThreadByTab(
  thread: Thread,
  relevantPages: Set<InnerWindowID>
): Thread {
  return timeCode('filterThreadByTab', () => {
    if (relevantPages.size === 0) {
      // Either there is no relevant page or "active tab only" view is not active.
      return thread;
    }

    const { frameTable, stackTable } = thread;

    // innerWindowID array lives inside the frameTable. Check that and decide
    // if we should keep that sample or not.
    const frameMatchesFilterCache: Map<
      IndexIntoFrameTable,
      boolean
    > = new Map();
    function frameMatchesFilter(frame) {
      const cache = frameMatchesFilterCache.get(frame);
      if (cache !== undefined) {
        return cache;
      }

      const innerWindowID = frameTable.innerWindowID[frame];
      const matches =
        innerWindowID && innerWindowID > 0
          ? relevantPages.has(innerWindowID)
          : false;
      frameMatchesFilterCache.set(frame, matches);
      return matches;
    }

    // Use the stackTable to navigate to frameTable and cache the result of it.
    const stackMatchesFilterCache: Map<
      IndexIntoStackTable,
      boolean
    > = new Map();
    function stackMatchesFilter(stackIndex) {
      if (stackIndex === null) {
        return false;
      }
      const cache = stackMatchesFilterCache.get(stackIndex);
      if (cache !== undefined) {
        return cache;
      }

      const prefix = stackTable.prefix[stackIndex];
      if (stackMatchesFilter(prefix)) {
        stackMatchesFilterCache.set(stackIndex, true);
        return true;
      }

      const frame = stackTable.frame[stackIndex];
      const matches = frameMatchesFilter(frame);
      stackMatchesFilterCache.set(stackIndex, matches);
      return matches;
    }

    // Update the stack array elements of samples object and make them null if
    // they don't include any relevant JS frame.
    // It doesn't mutate the stack itself.
    return updateThreadStacks(thread, stackTable, stackIndex =>
      stackMatchesFilter(stackIndex) ? stackIndex : null
    );
  });
}

/**
 * This function takes both a SamplesTable and can be used on CounterSamplesTable.
 */
export function getSampleIndexRangeForSelection(
  table: { time: Milliseconds[], length: number },
  rangeStart: number,
  rangeEnd: number
): [IndexIntoSamplesTable, IndexIntoSamplesTable] {
  const sampleStart = bisectionLeft(table.time, rangeStart);
  const sampleEnd = bisectionLeft(table.time, rangeEnd, sampleStart);
  return [sampleStart, sampleEnd];
}

export function filterThreadSamplesToRange(
  thread: Thread,
  rangeStart: number,
  rangeEnd: number
): Thread {
  const { samples, jsAllocations, nativeAllocations } = thread;
  const [beginSampleIndex, endSampleIndex] = getSampleIndexRangeForSelection(
    samples,
    rangeStart,
    rangeEnd
  );
  const newSamples: SamplesTable = {
    length: endSampleIndex - beginSampleIndex,
    time: samples.time.slice(beginSampleIndex, endSampleIndex),
    weight: samples.weight
      ? samples.weight.slice(beginSampleIndex, endSampleIndex)
      : null,
    weightType: samples.weightType,
    stack: samples.stack.slice(beginSampleIndex, endSampleIndex),
  };

  if (samples.eventDelay) {
    newSamples.eventDelay = samples.eventDelay.slice(
      beginSampleIndex,
      endSampleIndex
    );
  } else if (samples.responsiveness) {
    newSamples.responsiveness = samples.responsiveness.slice(
      beginSampleIndex,
      endSampleIndex
    );
  }

  if (samples.threadCPUDelta) {
    newSamples.threadCPUDelta = samples.threadCPUDelta.slice(
      beginSampleIndex,
      endSampleIndex
    );
  }

  const newThread: Thread = {
    ...thread,
    samples: newSamples,
  };

  if (jsAllocations) {
    const [startAllocIndex, endAllocIndex] = getSampleIndexRangeForSelection(
      jsAllocations,
      rangeStart,
      rangeEnd
    );
    newThread.jsAllocations = {
      time: jsAllocations.time.slice(startAllocIndex, endAllocIndex),
      className: jsAllocations.className.slice(startAllocIndex, endAllocIndex),
      typeName: jsAllocations.typeName.slice(startAllocIndex, endAllocIndex),
      coarseType: jsAllocations.coarseType.slice(
        startAllocIndex,
        endAllocIndex
      ),
      weight: jsAllocations.weight.slice(startAllocIndex, endAllocIndex),
      weightType: jsAllocations.weightType,
      inNursery: jsAllocations.inNursery.slice(startAllocIndex, endAllocIndex),
      stack: jsAllocations.stack.slice(startAllocIndex, endAllocIndex),
      length: endAllocIndex - startAllocIndex,
    };
  }

  if (nativeAllocations) {
    const [startAllocIndex, endAllocIndex] = getSampleIndexRangeForSelection(
      nativeAllocations,
      rangeStart,
      rangeEnd
    );
    const time = nativeAllocations.time.slice(startAllocIndex, endAllocIndex);
    const weight = nativeAllocations.weight.slice(
      startAllocIndex,
      endAllocIndex
    );
    const stack = nativeAllocations.stack.slice(startAllocIndex, endAllocIndex);
    const length = endAllocIndex - startAllocIndex;
    if (nativeAllocations.memoryAddress) {
      newThread.nativeAllocations = {
        time,
        weight,
        weightType: nativeAllocations.weightType,
        stack,
        memoryAddress: nativeAllocations.memoryAddress.slice(
          startAllocIndex,
          endAllocIndex
        ),
        threadId: nativeAllocations.threadId.slice(
          startAllocIndex,
          endAllocIndex
        ),
        length,
      };
    } else {
      newThread.nativeAllocations = {
        time,
        weight,
        weightType: nativeAllocations.weightType,
        stack,
        length,
      };
    }
  }

  return newThread;
}

export function filterCounterToRange(
  counter: Counter,
  rangeStart: number,
  rangeEnd: number
): Counter {
  const filteredGroups = counter.sampleGroups.map(sampleGroup => {
    const samples = sampleGroup.samples;
    let [sBegin, sEnd] = getSampleIndexRangeForSelection(
      samples,
      rangeStart,
      rangeEnd
    );

    // Include the samples just before and after the selection range, so that charts will
    // not be cut off at the edges.
    if (sBegin > 0) {
      sBegin--;
    }
    if (sEnd < samples.length) {
      sEnd++;
    }

    const count = samples.count.slice(sBegin, sEnd);
    const number = samples.number.slice(sBegin, sEnd);

    if (sBegin === 0) {
      // These lines zero out the first values of the counters, as they are unreliable. In
      // addition, there are probably some missed counts in the memory counters, so the
      // first memory number slowly creeps up over time, and becomes very unrealistic.
      // In order to not be affected by these platform limitations, zero out the first
      // counter values.
      //
      // "Memory counter in Gecko Profiler isn't cleared when starting a new capture"
      // https://bugzilla.mozilla.org/show_bug.cgi?id=1520587
      count[0] = 0;
      number[0] = 0;
    }

    return {
      ...sampleGroup,
      samples: {
        time: samples.time.slice(sBegin, sEnd),
        number,
        count,
        length: sEnd - sBegin,
      },
    };
  });

  return {
    ...counter,
    sampleGroups: filteredGroups,
  };
}

/**
 * The memory counter contains relative offsets of memory. In order to draw an interesting
 * graph, take the memory counts, and find the minimum and maximum values, by
 * accumulating them over the entire profile range. Then, map those values to the
 * accumulatedCounts array.
 */
export function accumulateCounterSamples(
  samplesArray: Array<CounterSamplesTable>
): Array<AccumulatedCounterSamples> {
  const accumulatedSamples = samplesArray.map(samples => {
    let minCount = 0;
    let maxCount = 0;
    let accumulated = 0;
    const accumulatedCounts = [];
    for (let i = 0; i < samples.length; i++) {
      accumulated += samples.count[i];
      minCount = Math.min(accumulated, minCount);
      maxCount = Math.max(accumulated, maxCount);
      accumulatedCounts[i] = accumulated;
    }
    const countRange = maxCount - minCount;

    return {
      minCount,
      maxCount,
      countRange,
      accumulatedCounts,
    };
  });

  return accumulatedSamples;
}

/**
 * Pre-processing of raw eventDelay values.
 *
 * We don't do 16ms event injection for responsiveness values anymore. Instead,
 * profiler records the time since running event blocked the input events. But
 * this value is not enough to calculate event delays by itself. We need to process
 * these values and turn them into event delays, which we can use for determining
 * responsiveness later.
 *
 * For every event that gets enqueued, the delay time will go up by the event's
 * running time at the time at which the event is enqueued. The delay function
 * will be a sawtooth of the following shape:
 *
 *              |\           |...
 *              | \          |
 *         |\   |  \         |
 *         | \  |   \        |
 *      |\ |  \ |    \       |
 *   |\ | \|   \|     \      |
 *   | \|              \     |
 *  _|                  \____|
 *
 * Calculate the delay of a new event added at time t: (run every sample)
 *
 *  TimeSinceRunningEventBlockedInputEvents = RunningEventDelay + (now - RunningEventStart);
 *  effective_submission = now - TimeSinceRunningEventBlockedInputEvents;
 *  delta = (now - last_sample_time);
 *  last_sample_time = now;
 *  for (t=effective_submission to now) {
 *     delay[t] += delta;
 *  }
 *
 * Note that TimeSinceRunningEventBlockedInputEvents is our eventDelay values in
 * the profile. So we don't have to calculate this. It's calculated in the gecko side already.
 *
 * This first algorithm is not efficient because we are running this loop for each sample.
 * Instead it can be reduced in overhead by:
 *
 *  TimeSinceRunningEventBlockedInputEvents = RunningEventDelay + (now - RunningEventStart);
 *  effective_submission = now - TimeSinceRunningEventBlockedInputEvents;
 *  if (effective_submission != last_submission) {
 *    delta = (now - last_submission);
 *    // this loop should be made to match each sample point in the range
 *    // intead of assuming 1ms sampling as this pseudocode does
 *    for (t=last_submission to effective_submission-1) {
 *       delay[t] += delta;
 *       delta -= 1; // assumes 1ms; adjust as needed to match for()
 *    }
 *    last_submission = effective_submission;
 *  }
 *
 * In this algorithm, we are running this only if effective submission is changed.
 * This reduces the calculation overhead a lot.
 * So we used the second algorithm in this function to make it faster.
 *
 * For instance the processed eventDelay values will be something like this:
 *
 *   [12 , 3, 42, 31, 22, 10, 3, 71, 65, 42, 23, 3, 33, 25, 5, 3]
 *         |___|              |___|              |___|
 *     A new event is    New event is enqueued   New event is enqueued
 *     enqueued
 *
 * A more realistic and minimal example:
 *  Unprocessed values
 *
 *   [0, 0, 1, 0, 0, 0, 0, 1, 2, 3, 4, 5, 0, 0, 0, 0]
 *          ^last submission           ^ effective submission
 *
 *  Will be converted to:
 *
 *   [0, 0, 5, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
 *
 * If you want to learn more about this eventDelay value on gecko side, see:
 * https://searchfox.org/mozilla-central/rev/3811b11b5773c1dccfe8228bfc7143b10a9a2a99/tools/profiler/core/platform.cpp#3000-3186
 */
export function processEventDelays(
  samples: SamplesTable,
  interval: Milliseconds
): EventDelayInfo {
  if (!samples.eventDelay) {
    throw new Error(
      'processEventDelays step should not be called for older profiles'
    );
  }

  const eventDelays = new Float32Array(samples.length);
  const rawEventDelays = ensureExists(
    samples.eventDelay,
    'eventDelays field is not present in this profile'
  );
  let lastSubmission = samples.time[0];
  let lastSubmissionIdx = 0;

  // Skipping the first element because we don't have any sample of its past.
  for (let i = 1; i < samples.length; i++) {
    const currentEventDelay = rawEventDelays[i];
    const nextEventDelay = rawEventDelays[i + 1] || 0; // it can be null or undefined (for the last element)
    const now = samples.time[i];
    if (currentEventDelay === null || currentEventDelay === undefined) {
      // Ignore anything that's not numeric. This can happen if there is no responsiveness
      // information, or if the sampler failed to collect a responsiveness value. This
      // can happen intermittently.
      //
      // See Bug 1506226.
      continue;
    }

    if (currentEventDelay < nextEventDelay) {
      // The submission is still ongoing, we should get the next event delay
      // value until the submission ends.
      continue;
    }

    // This is a new submission
    const sampleSinceBlockedEvents = Math.trunc(currentEventDelay / interval);
    const effectiveSubmission = now - currentEventDelay;
    const effectiveSubmissionIdx = i - sampleSinceBlockedEvents;

    if (effectiveSubmissionIdx < 0) {
      // Unfortunately submissions that were started before the profiler start
      // time are not reliable because we don't have any sample data for earlier.
      // Skipping it.
      lastSubmission = now;
      lastSubmissionIdx = i;
      continue;
    }

    if (lastSubmissionIdx === effectiveSubmissionIdx) {
      // Bail out early since there is nothing to do.
      lastSubmission = effectiveSubmission;
      lastSubmissionIdx = effectiveSubmissionIdx;
      continue;
    }

    let delta = now - lastSubmission;
    for (let j = lastSubmissionIdx + 1; j <= effectiveSubmissionIdx; j++) {
      eventDelays[j] += delta;
      delta -= samples.time[j + 1] - samples.time[j];
    }

    lastSubmission = effectiveSubmission;
    lastSubmissionIdx = effectiveSubmissionIdx;
  }

  // We are done with processing the delays.
  // Calculate min/max delay and delay range
  let minDelay = Number.MAX_SAFE_INTEGER;
  let maxDelay = 0;
  for (const delay of eventDelays) {
    if (delay) {
      minDelay = Math.min(delay, minDelay);
      maxDelay = Math.max(delay, maxDelay);
    }
  }
  const delayRange = maxDelay - minDelay;

  return {
    eventDelays,
    minDelay,
    maxDelay,
    delayRange,
  };
}

// --------------- CallNodePath and CallNodeIndex manipulations ---------------

// Returns a list of CallNodeIndex from CallNodePaths. This function uses a map
// to speed up the look-up process.
export function getCallNodeIndicesFromPaths(
  callNodePaths: CallNodePath[],
  callNodeTable: CallNodeTable
): Array<IndexIntoCallNodeTable | null> {
  // This is a Map<CallNodePathHash, IndexIntoCallNodeTable>. This map speeds up
  // the look-up process by caching every CallNodePath we handle which avoids
  // looking up parents again and again.
  const cache = new Map();
  return callNodePaths.map(path =>
    _getCallNodeIndexFromPathWithCache(path, callNodeTable, cache)
  );
}

// Returns a CallNodeIndex from a CallNodePath, using and contributing to the
// cache parameter.
function _getCallNodeIndexFromPathWithCache(
  callNodePath: CallNodePath,
  callNodeTable: CallNodeTable,
  cache: Map<string, IndexIntoCallNodeTable>
): IndexIntoCallNodeTable | null {
  const hashFullPath = hashPath(callNodePath);
  const result = cache.get(hashFullPath);
  if (result !== undefined) {
    // The cache already has the result for the full path.
    return result;
  }

  // This array serves as a map and stores the hashes of callNodePath's
  // parents to speed up the algorithm. First we'll follow the tree from the
  // bottom towards the top, pushing hashes as we compute them, and then we'll
  // move back towards the bottom popping hashes from this array.
  const sliceHashes = [hashFullPath];

  // Step 1: find whether we already computed the index for one of the path's
  // parents, starting from the closest parent and looping towards the "top" of
  // the tree.
  // If we find it for one of the parents, we'll be able to start at this point
  // in the following look up.
  let i = callNodePath.length;
  let index;
  while (--i > 0) {
    // Looking up each parent for this call node, starting from the deepest node.
    // If we find a parent this makes it possible to start the look up from this location.
    const subPath = callNodePath.slice(0, i);
    const hash = hashPath(subPath);
    index = cache.get(hash);
    if (index !== undefined) {
      // Yay, we already have the result for a parent!
      break;
    }
    // Cache the hashed value because we'll need it later, after resolving this path.
    // Note we don't add the hash if we found the parent in the cache, so the
    // last added element here will accordingly be the first popped in the next
    // algorithm.
    sliceHashes.push(hash);
  }

  // Step 2: look for the requested path using the call node table, starting at
  // the parent we already know if we found one, and looping down the tree.
  // We're contributing to the cache at the same time.

  // `index` is undefined if no parent was found in the cache. In that case we
  // start from the start, and use `-1` which is the prefix we use to indicate
  // the root node.
  if (index === undefined) {
    index = -1;
  }

  while (i < callNodePath.length) {
    // Resolving the index for subpath `callNodePath.slice(0, i+1)` given we
    // know the index for the subpath `callNodePath.slice(0, i)` (its parent).
    const func = callNodePath[i];
    const nextNodeIndex = _getCallNodeIndexFromParentAndFunc(
      index,
      func,
      callNodeTable
    );

    // We couldn't find this path into the call node table. This shouldn't
    // normally happen.
    if (nextNodeIndex === null) {
      return null;
    }

    // Contributing to the shared cache
    const hash = sliceHashes.pop();
    cache.set(hash, nextNodeIndex);

    index = nextNodeIndex;
    i++;
  }

  return index < 0 ? null : index;
}

// Returns the CallNodeIndex that matches the function `func` and whose parent's
// CallNodeIndex is `parent`.
function _getCallNodeIndexFromParentAndFunc(
  parent: IndexIntoCallNodeTable,
  func: IndexIntoFuncTable,
  callNodeTable: CallNodeTable
): IndexIntoCallNodeTable | null {
  // Node children always come after their parents in the call node table,
  // that's why we start looping at `parent + 1`.
  // Note that because the root parent is `-1`, we correctly start at `0` when
  // we look for a top-level item.
  for (
    let callNodeIndex = parent + 1; // the root parent is -1
    callNodeIndex < callNodeTable.length;
    callNodeIndex++
  ) {
    if (
      callNodeTable.prefix[callNodeIndex] === parent &&
      callNodeTable.func[callNodeIndex] === func
    ) {
      return callNodeIndex;
    }
  }

  return null;
}

// This function returns a CallNodeIndex from a CallNodePath, using the
// specified `callNodeTable`.
export function getCallNodeIndexFromPath(
  callNodePath: CallNodePath,
  callNodeTable: CallNodeTable
): IndexIntoCallNodeTable | null {
  const [result] = getCallNodeIndicesFromPaths([callNodePath], callNodeTable);
  return result;
}

// This function returns a CallNodePath from a CallNodeIndex.
export function getCallNodePathFromIndex(
  callNodeIndex: IndexIntoCallNodeTable | null,
  callNodeTable: CallNodeTable
): CallNodePath {
  if (callNodeIndex === null || callNodeIndex === -1) {
    return [];
  }

  const callNodePath = [];
  let fs = callNodeIndex;
  while (fs !== -1) {
    callNodePath.push(callNodeTable.func[fs]);
    fs = callNodeTable.prefix[fs];
  }
  callNodePath.reverse();
  return callNodePath;
}

/**
 * This function converts a stack information into a call node path structure.
 */
export function convertStackToCallNodePath(
  thread: Thread,
  stack: IndexIntoStackTable
): CallNodePath {
  const { stackTable, frameTable } = thread;
  const path = [];
  for (
    let stackIndex = stack;
    stackIndex !== null;
    stackIndex = stackTable.prefix[stackIndex]
  ) {
    path.push(frameTable.func[stackTable.frame[stackIndex]]);
  }
  return path.reverse();
}

/**
 * Compute maximum depth of call stack for a given thread.
 *
 * Returns the depth of the deepest call node, but with a one-based
 * depth instead of a zero-based.
 *
 * If no samples are found, 0 is returned.
 */
export function computeCallNodeMaxDepth(
  thread: Thread,
  callNodeInfo: CallNodeInfo
): number {
  if (
    thread.samples.length === 0 ||
    callNodeInfo.callNodeTable.depth.length === 0
  ) {
    return 0;
  }

  let max = 0;
  for (const depth of callNodeInfo.callNodeTable.depth) {
    max = Math.max(max, depth);
  }

  return max + 1;
}

export function invertCallstack(
  thread: Thread,
  defaultCategory: IndexIntoCategoryList
): Thread {
  return timeCode('invertCallstack', () => {
    const { stackTable, frameTable } = thread;

    const newStackTable = {
      length: 0,
      frame: [],
      category: [],
      subcategory: [],
      prefix: [],
    };
    // Create a Map that keys off of two values, both the prefix and frame combination
    // by using a bit of math: prefix * frameCount + frame => stackIndex
    const prefixAndFrameToStack = new Map();
    const frameCount = frameTable.length;

    // Returns the stackIndex for a specific frame (that is, a function and its
    // context), and a specific prefix. If it doesn't exist yet it will create
    // a new stack entry and return its index.
    function stackFor(prefix, frame, category, subcategory) {
      const prefixAndFrameIndex =
        (prefix === null ? -1 : prefix) * frameCount + frame;
      let stackIndex = prefixAndFrameToStack.get(prefixAndFrameIndex);
      if (stackIndex === undefined) {
        stackIndex = newStackTable.length++;
        newStackTable.prefix[stackIndex] = prefix;
        newStackTable.frame[stackIndex] = frame;
        newStackTable.category[stackIndex] = category;
        newStackTable.subcategory[stackIndex] = subcategory;
        prefixAndFrameToStack.set(prefixAndFrameIndex, stackIndex);
      } else if (newStackTable.category[stackIndex] !== category) {
        // If two stack nodes from the non-inverted stack tree with different
        // categories happen to collapse into the same stack node in the
        // inverted tree, discard their category and set the category to the
        // default category.
        newStackTable.category[stackIndex] = defaultCategory;
        newStackTable.subcategory[stackIndex] = 0;
      } else if (newStackTable.subcategory[stackIndex] !== subcategory) {
        // If two stack nodes from the non-inverted stack tree with the same
        // category but different subcategories happen to collapse into the same
        // stack node in the inverted tree, discard their subcategory and set it
        // to the "Other" subcategory.
        newStackTable.subcategory[stackIndex] = 0;
      }
      return stackIndex;
    }

    const oldStackToNewStack = new Map();

    // For one specific stack, this will ensure that stacks are created for all
    // of its ancestors, by walking its prefix chain up to the root.
    function convertStack(stackIndex) {
      if (stackIndex === null) {
        return null;
      }
      let newStack = oldStackToNewStack.get(stackIndex);
      if (newStack === undefined) {
        newStack = null;
        for (
          let currentStack = stackIndex;
          currentStack !== null;
          currentStack = stackTable.prefix[currentStack]
        ) {
          // Notice how we reuse the previous stack as the prefix. This is what
          // effectively inverts the call tree.
          newStack = stackFor(
            newStack,
            stackTable.frame[currentStack],
            stackTable.category[currentStack],
            stackTable.subcategory[currentStack]
          );
        }
        oldStackToNewStack.set(stackIndex, newStack);
      }
      return newStack;
    }

    return updateThreadStacks(thread, newStackTable, convertStack);
  });
}

/**
 * Sometimes we want to update the stacks for a thread, for instance while searching
 * for a text string, or doing a call tree transformation. This function abstracts
 * out the manipulation of the data structures so that we can properly update
 * the stack table and any possible allocation information.
 */
export function updateThreadStacks(
  thread: Thread,
  newStackTable: StackTable,
  convertStack: (IndexIntoStackTable | null) => IndexIntoStackTable | null
): Thread {
  const { jsAllocations, nativeAllocations, samples } = thread;

  const newSamples = {
    ...samples,
    stack: samples.stack.map(oldStack => convertStack(oldStack)),
  };

  const newThread = {
    ...thread,
    samples: newSamples,
    stackTable: newStackTable,
  };

  if (jsAllocations) {
    newThread.jsAllocations = {
      ...jsAllocations,
      stack: jsAllocations.stack.map(oldStack => convertStack(oldStack)),
    };
  }
  if (nativeAllocations) {
    newThread.nativeAllocations = {
      ...nativeAllocations,
      stack: nativeAllocations.stack.map(oldStack => convertStack(oldStack)),
    };
  }

  return newThread;
}

/**
 * When manipulating stack tables, the most common operation is to map from one
 * stack to a new stack using a Map. This function returns another function that
 * does this work. It is used in conjunction with updateThreadStacks().
 */
export function getMapStackUpdater(
  oldStackToNewStack: Map<
    null | IndexIntoStackTable,
    null | IndexIntoStackTable
  >
): (IndexIntoStackTable | null) => IndexIntoStackTable | null {
  return (oldStack: IndexIntoStackTable | null) => {
    if (oldStack === null) {
      return null;
    }
    const newStack = oldStackToNewStack.get(oldStack);
    if (newStack === undefined) {
      throw new Error(
        'Could not find a stack when converting from an old stack to new stack.'
      );
    }
    return newStack;
  };
}

export function getSampleIndexClosestToTime(
  samples: SamplesTable,
  time: number,
  interval: Milliseconds
): IndexIntoSamplesTable {
  // Bisect to find the index of the first sample after the provided time.
  const index = bisectionRight(samples.time, time);

  if (index === 0) {
    return 0;
  }

  if (index === samples.length) {
    return samples.length - 1;
  }

  // Check the distance between the provided time and the center of the bisected sample
  // and its predecessor.
  const previousIndex = index - 1;

  let weight = interval;
  let previousWeight = interval;
  if (samples.weight) {
    const samplesWeight = samples.weight;
    weight = Math.abs(samplesWeight[index]);
    previousWeight = Math.abs(samplesWeight[previousIndex]);
  }

  const distanceToThis = samples.time[index] + weight / 2 - time;
  const distanceToLast =
    time - (samples.time[previousIndex] + previousWeight / 2);
  return distanceToThis < distanceToLast ? index : index - 1;
}

/*
 * TODO:
 */
export function getSampleIndexClosestToAdjustedTime(
  samples: SamplesTable,
  time: number
): IndexIntoSamplesTable {
  // Bisect to find the index of the first sample after the provided time.
  const index = bisectionRight(samples.time, time);

  if (index === 0) {
    return 0;
  }

  if (index === samples.length) {
    return samples.length - 1;
  }

  // Check the distance between the provided time and the center of the bisected sample
  // and its predecessor.
  const previousIndex = index - 1;

  const distanceToThis = samples.time[index] - time;
  const distanceToLast = time - samples.time[previousIndex];
  return distanceToThis < distanceToLast ? index : index - 1;
}

export function getFriendlyThreadName(
  threads: Thread[],
  thread: Thread
): string {
  let label;

  switch (thread.name) {
    case 'GeckoMain': {
      if (thread.processName) {
        // If processName is present, use that as it should contain a friendly name.
        // We want to use that for the GeckoMain thread because it is shown as the
        // root of other threads in each process group.
        label = thread.processName;
        const homonymThreads = threads.filter(thread => {
          return thread.name === 'GeckoMain' && thread.processName === label;
        });
        if (homonymThreads.length > 1) {
          const index = 1 + homonymThreads.indexOf(thread);
          label += ` (${index}/${homonymThreads.length})`;
        }
      } else {
        switch (thread.processType) {
          case 'default':
            label = 'Parent Process';
            break;
          case 'gpu':
            label = 'GPU Process';
            break;
          case 'rdd':
            label = 'Remote Data Decoder';
            break;
          case 'tab': {
            const contentThreads = threads.filter(thread => {
              return (
                thread.name === 'GeckoMain' && thread.processType === 'tab'
              );
            });
            if (contentThreads.length > 1) {
              const index = 1 + contentThreads.indexOf(thread);
              label = `Content Process (${index}/${contentThreads.length})`;
            } else {
              label = 'Content Process';
            }
            break;
          }
          case 'plugin':
            label = 'Plugin Process';
            break;
          case 'socket':
            label = 'Socket Process';
            break;
          default:
          // should we throw here ?
        }
      }
      break;
    }
    default:
  }

  if (!label) {
    label = thread.name;
  }
  return label;
}

export function getThreadProcessDetails(thread: Thread): string {
  let label = `thread: "${thread.name}"`;
  if (thread.tid !== undefined) {
    label += ` (${thread.tid})`;
  }

  if (thread.processType) {
    label += `\nprocess: "${thread.processType}"`;
    if (thread.pid !== undefined) {
      label += ` (${thread.pid})`;
    }
  }

  return label;
}

/**
 * This function returns the source origin for a function. This can be:
 * - a filename (javascript or object file)
 * - a URL (if the source is a website)
 */
export function getOriginAnnotationForFunc(
  funcIndex: IndexIntoFuncTable,
  funcTable: FuncTable,
  resourceTable: ResourceTable,
  stringTable: UniqueStringArray
): string {
  const resourceIndex = funcTable.resource[funcIndex];
  const resourceNameIndex = resourceTable.name[resourceIndex];

  let origin;
  if (resourceNameIndex !== undefined) {
    origin = stringTable.getString(resourceNameIndex);
  }

  const fileNameIndex = funcTable.fileName[funcIndex];
  let fileName;
  if (fileNameIndex !== null) {
    fileName = stringTable.getString(fileNameIndex);
    const lineNumber = funcTable.lineNumber[funcIndex];
    if (lineNumber !== null) {
      fileName += ':' + lineNumber;
      const columnNumber = funcTable.columnNumber[funcIndex];
      if (columnNumber !== null) {
        fileName += ':' + columnNumber;
      }
    }
  }

  if (fileName) {
    // If the origin string is just a URL prefix that's part of the
    // filename, it doesn't add any useful information, so just return
    // the filename. If it's something else (e.g., an extension or
    // library name), prepend it to the filename.
    if (origin && !fileName.startsWith(origin)) {
      return `${origin}: ${fileName}`;
    }
    return fileName;
  }

  if (origin) {
    return origin;
  }

  return '';
}

/**
 * From a valid call node path, this function returns a list of information
 * about each function in this path: their names and their origins.
 */
export function getFuncNamesAndOriginsForPath(
  path: CallNodePath,
  thread: Thread
): Array<{ funcName: string, isFrameLabel: boolean, origin: string }> {
  const { funcTable, stringTable, resourceTable } = thread;

  return path.map(func => ({
    funcName: stringTable.getString(funcTable.name[func]),
    isFrameLabel: funcTable.resource[func] === -1,
    origin: getOriginAnnotationForFunc(
      func,
      funcTable,
      resourceTable,
      stringTable
    ),
  }));
}

/**
 * Return a function that can compare two samples' call nodes, and determine a sort order.
 *
 * The order is determined as follows:
 *  - Ancestor call nodes are ordered before their descendants.
 *  - Sibling call nodes are ordered by their call node index.
 * This order can be different than the order of the rows that are displayed in the
 * call tree, because it does not take any sample information into account. This
 * makes it independent of any range selection and cheaper to compute.
 */
export function getTreeOrderComparator(
  callNodeTable: CallNodeTable,
  sampleCallNodes: Array<IndexIntoCallNodeTable | null>
): (IndexIntoSamplesTable, IndexIntoSamplesTable) => number {
  /**
   * Determine the ordering of two non-null call nodes.
   */
  function compareCallNodes(
    callNodeA: IndexIntoCallNodeTable,
    callNodeB: IndexIntoCallNodeTable
  ): number {
    const initialDepthA = callNodeTable.depth[callNodeA];
    const initialDepthB = callNodeTable.depth[callNodeB];
    let depthA = initialDepthA;
    let depthB = initialDepthB;

    // Walk call tree towards the roots until the call nodes are at the same depth.
    while (depthA > depthB) {
      callNodeA = callNodeTable.prefix[callNodeA];
      depthA--;
    }
    while (depthB > depthA) {
      callNodeB = callNodeTable.prefix[callNodeB];
      depthB--;
    }

    // Sort the call nodes by the initial depth.
    if (callNodeA === callNodeB) {
      return initialDepthA - initialDepthB;
    }

    // The call nodes are at the same depth, walk towards the roots until a match is
    // is found, then sort them based on stack order.
    while (true) {
      const parentNodeA = callNodeTable.prefix[callNodeA];
      const parentNodeB = callNodeTable.prefix[callNodeB];
      if (parentNodeA === parentNodeB) {
        break;
      }
      callNodeA = parentNodeA;
      callNodeB = parentNodeB;
    }

    return callNodeA - callNodeB;
  }

  /**
   * Determine the ordering of (possibly null) call nodes for two given samples.
   * Returns a value < 0 if sampleA is ordered before sampleB,
   *                 > 0 if sampleA is ordered after sampleB,
   *                == 0 if there is no ordering between sampleA and sampleB.
   * Samples which are filtered out, i.e. for which sampleCallNodes[sample] is
   * null, are ordered *after* samples which are not filtered out.
   */
  return function treeOrderComparator(
    sampleA: IndexIntoSamplesTable,
    sampleB: IndexIntoSamplesTable
  ): number {
    const callNodeA = sampleCallNodes[sampleA];
    const callNodeB = sampleCallNodes[sampleB];

    if (callNodeA === null) {
      if (callNodeB === null) {
        // Both samples are filtered out
        return 0;
      }
      // A filtered out, B not filtered out. A goes after B.
      return 1;
    }
    if (callNodeB === null) {
      // B filtered out, A not filtered out. B goes after A.
      return -1;
    }
    return compareCallNodes(callNodeA, callNodeB);
  };
}

/**
 * This is the root-most call node for which, if selected, only the clicked category
 * is highlighted in the thread activity graph. In other words, it's the root-most call
 * node which only 'contains' samples whose sample category is the clicked category.
 */
export function findBestAncestorCallNode(
  callNodeInfo: CallNodeInfo,
  sampleCallNodes: Array<IndexIntoCallNodeTable | null>,
  sampleCategories: Array<IndexIntoCategoryList | null>,
  clickedCallNode: IndexIntoCallNodeTable,
  clickedCategory: IndexIntoCategoryList
): IndexIntoCallNodeTable {
  const { callNodeTable } = callNodeInfo;
  if (callNodeTable.category[clickedCallNode] !== clickedCategory) {
    return clickedCallNode;
  }

  // Compute the callNodesOnSameCategoryPath.
  // Given a call node path with some arbitrary categories, e.g. A, B, C
  //
  //     Categories: A -> A -> B -> B -> C -> C -> C
  //   Node Indexes: 0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6

  // This loop will select the leaf-most call nodes that match the leaf call-node's
  // category. Running the above path through this loop would produce the list:
  //
  //     Categories: [C, C, C]
  //   Node Indexes: [6, 5, 4]  (note the reverse order)
  const callNodesOnSameCategoryPath = [clickedCallNode];
  let callNode = clickedCallNode;
  while (true) {
    const parentCallNode = callNodeTable.prefix[callNode];
    if (parentCallNode === -1) {
      // The entire call path is just clickedCategory.
      return clickedCallNode; // TODO: is this a useful behavior?
    }
    if (callNodeTable.category[parentCallNode] !== clickedCategory) {
      break;
    }
    callNodesOnSameCategoryPath.push(parentCallNode);
    callNode = parentCallNode;
  }

  // Now find the callNode in callNodesOnSameCategoryPath with the lowest depth
  // such that selecting it will not highlight any samples whose unfiltered
  // category is different from clickedCategory. If no such callNode exists,
  // return clickedCallNode.

  const clickedDepth = callNodeTable.depth[clickedCallNode];
  // The handledCallNodes is used as a Map<CallNodeIndex, bool>.
  const handledCallNodes = new Uint8Array(callNodeTable.length);

  function limitSameCategoryPathToCommonAncestor(callNode) {
    // The callNode argument is the leaf call node of a sample whose sample category is a
    // different category than clickedCategory. If callNode's ancestor path crosses
    // callNodesOnSameCategoryPath, that implies that callNode would be highlighted
    // if we were to select the root-most node in callNodesOnSameCategoryPath.
    // If that is the case, we need to truncate callNodesOnSameCategoryPath in such
    // a way that the root-most node in that list is no longer an ancestor of callNode.
    const walkUpToDepth =
      clickedDepth - (callNodesOnSameCategoryPath.length - 1);
    let depth = callNodeTable.depth[callNode];

    // Go from leaf to root in the call nodes.
    while (depth >= walkUpToDepth) {
      if (handledCallNodes[callNode]) {
        // This call node was already handled. Stop checking.
        return;
      }
      handledCallNodes[callNode] = 1;
      if (depth <= clickedDepth) {
        // This call node's depth is less than the clicked depth, it needs to be
        // checked to see if the call node is in the callNodesOnSameCategoryPath.
        if (callNode === callNodesOnSameCategoryPath[clickedDepth - depth]) {
          // Remove some of the call nodes, as they are not on the same path.
          // This is done by shortening the array length. Keep in mind that this
          // array is in the opposite order of a CallNodePath, with the leaf-most
          // nodes first, and the root-most last.
          callNodesOnSameCategoryPath.length = clickedDepth - depth;
          return;
        }
      }
      callNode = callNodeTable.prefix[callNode];
      depth--;
    }
  }

  // Go through every sample and look at each sample's call node.
  for (let sample = 0; sample < sampleCallNodes.length; sample++) {
    if (
      sampleCategories[sample] !== clickedCategory &&
      sampleCallNodes[sample] !== null
    ) {
      // This sample's category is a different one than the one clicked. Make
      // sure to limit the callNodesOnSameCategoryPath to just the call nodes
      // that share the same common ancestor.
      limitSameCategoryPathToCommonAncestor(sampleCallNodes[sample]);
    }
  }

  if (callNodesOnSameCategoryPath.length > 0) {
    // The last call node in this list will be the root-most call node that has
    // the same category on the path as the clicked call node.
    return callNodesOnSameCategoryPath[callNodesOnSameCategoryPath.length - 1];
  }
  return clickedCallNode;
}

/**
 * Look at the leaf-most stack for every sample, and take its category.
 */
export function getSampleCategories(
  samples: SamplesTable,
  stackTable: StackTable
): Array<IndexIntoSamplesTable | null> {
  return samples.stack.map(s => (s !== null ? stackTable.category[s] : null));
}

export function getFriendlyStackTypeName(
  implementation: StackImplementation
): string {
  switch (implementation) {
    case 'interpreter':
      return 'JS interpreter';
    case 'blinterp':
    case 'baseline':
    case 'ion':
      return `JS JIT (${implementation})`;
    case 'native':
      return 'Native code';
    case 'unknown':
      return implementation;
    default:
      throw assertExhaustiveCheck(implementation);
  }
}

export function shouldDisplaySubcategoryInfoForCategory(
  category: Category
): boolean {
  // The first subcategory of every category is the "Other" subcategory.
  // For categories which only have the "Other" subcategory and no other
  // subcategories, don't display any subcategory information.
  return category.subcategories.length > 1;
}

export function getCategoryPairLabel(
  categories: CategoryList,
  categoryIndex: number,
  subcategoryIndex: number
): string {
  const category = categories[categoryIndex];
  return subcategoryIndex !== 0
    ? `${category.name}: ${category.subcategories[subcategoryIndex]}`
    : `${category.name}`;
}

/**
 * This function filters to only positive memory size values in the native allocations.
 * It removes all of the deallocation information.
 */
export function filterToAllocations(
  nativeAllocations: NativeAllocationsTable
): NativeAllocationsTable {
  let newNativeAllocations;
  if (nativeAllocations.memoryAddress) {
    newNativeAllocations = getEmptyBalancedNativeAllocationsTable();
    for (let i = 0; i < nativeAllocations.length; i++) {
      const weight = nativeAllocations.weight[i];
      if (weight > 0) {
        newNativeAllocations.time.push(nativeAllocations.time[i]);
        newNativeAllocations.stack.push(nativeAllocations.stack[i]);
        newNativeAllocations.weight.push(weight);
        newNativeAllocations.memoryAddress.push(
          nativeAllocations.memoryAddress[i]
        );
        newNativeAllocations.threadId.push(nativeAllocations.threadId[i]);
        newNativeAllocations.length++;
      }
    }
  } else {
    newNativeAllocations = getEmptyUnbalancedNativeAllocationsTable();
    for (let i = 0; i < nativeAllocations.length; i++) {
      const weight = nativeAllocations.weight[i];
      if (weight > 0) {
        newNativeAllocations.time.push(nativeAllocations.time[i]);
        newNativeAllocations.stack.push(nativeAllocations.stack[i]);
        newNativeAllocations.weight.push(weight);
        newNativeAllocations.length++;
      }
    }
  }
  return newNativeAllocations;
}

/**
 * This function filters to only negative memory size values in the native allocations.
 * It shows all of the memory frees.
 */
export function filterToDeallocationsSites(
  nativeAllocations: NativeAllocationsTable
): NativeAllocationsTable {
  let newNativeAllocations;
  if (nativeAllocations.memoryAddress) {
    newNativeAllocations = getEmptyBalancedNativeAllocationsTable();
    for (let i = 0; i < nativeAllocations.length; i++) {
      const weight = nativeAllocations.weight[i];
      if (weight < 0) {
        newNativeAllocations.time.push(nativeAllocations.time[i]);
        newNativeAllocations.stack.push(nativeAllocations.stack[i]);
        newNativeAllocations.weight.push(weight);
        newNativeAllocations.memoryAddress.push(
          nativeAllocations.memoryAddress[i]
        );
        newNativeAllocations.threadId.push(nativeAllocations.threadId[i]);
        newNativeAllocations.length++;
      }
    }
  } else {
    newNativeAllocations = getEmptyUnbalancedNativeAllocationsTable();
    for (let i = 0; i < nativeAllocations.length; i++) {
      const weight = nativeAllocations.weight[i];
      if (weight < 0) {
        newNativeAllocations.time.push(nativeAllocations.time[i]);
        newNativeAllocations.stack.push(nativeAllocations.stack[i]);
        newNativeAllocations.weight.push(weight);
        newNativeAllocations.length++;
      }
    }
  }
  return newNativeAllocations;
}

/**
 * This function filters to only negative memory size values in the native allocations.
 * It rewrites the stacks to point back to the stack of the allocation.
 */
export function filterToDeallocationsMemory(
  nativeAllocations: BalancedNativeAllocationsTable
): NativeAllocationsTable {
  // A-----D------A-------D
  type Address = number;
  type IndexIntoAllocations = number;
  const memoryAddressToAllocation: Map<
    Address,
    IndexIntoAllocations
  > = new Map();
  const stackOfOriginalAllocation: Array<IndexIntoAllocations | null> = [];
  for (
    let allocationIndex = 0;
    allocationIndex < nativeAllocations.length;
    allocationIndex++
  ) {
    const bytes = nativeAllocations.weight[allocationIndex];
    const memoryAddress = nativeAllocations.memoryAddress[allocationIndex];
    if (bytes >= 0) {
      // Handle the allocation.

      // Provide a map back to this index.
      memoryAddressToAllocation.set(memoryAddress, allocationIndex);
      stackOfOriginalAllocation[allocationIndex] = null;
    } else {
      // Lookup the previous allocation.
      const previousAllocationIndex = memoryAddressToAllocation.get(
        memoryAddress
      );
      if (previousAllocationIndex === undefined) {
        stackOfOriginalAllocation[allocationIndex] = null;
      } else {
        // This deallocation matches a previous allocation. Remove the allocation.
        stackOfOriginalAllocation[allocationIndex] = previousAllocationIndex;
        // There is a match, so delete this old association.
        memoryAddressToAllocation.delete(memoryAddress);
      }
    }
  }

  const newDeallocations = getEmptyBalancedNativeAllocationsTable();
  for (let i = 0; i < nativeAllocations.length; i++) {
    const duration = nativeAllocations.weight[i];
    const stackIndex = stackOfOriginalAllocation[i];
    if (stackIndex !== null) {
      newDeallocations.time.push(nativeAllocations.time[i]);
      newDeallocations.stack.push(stackIndex);
      newDeallocations.weight.push(duration);
      newDeallocations.memoryAddress.push(nativeAllocations.memoryAddress[i]);
      newDeallocations.threadId.push(nativeAllocations.threadId[i]);
      newDeallocations.length++;
    }
  }

  return newDeallocations;
}

/**
 * Currently the native allocations naively collect allocations and deallocations.
 * There is no attempt to match up the sampled allocations with the deallocations.
 * Because of this, if a calltree were to combine both allocations and deallocations,
 * then the summary would most likely lie and not misreport leaked or retained memory.
 * For now, filter to only showing allocations or deallocations.
 *
 * This function filters to only positive values.
 */
export function filterToRetainedAllocations(
  nativeAllocations: BalancedNativeAllocationsTable
): NativeAllocationsTable {
  // A-----D------A-------D
  type Address = number;
  type IndexIntoAllocations = number;
  const memoryAddressToAllocation: Map<
    Address,
    IndexIntoAllocations
  > = new Map();
  const retainedAllocation = [];
  for (
    let allocationIndex = 0;
    allocationIndex < nativeAllocations.length;
    allocationIndex++
  ) {
    const bytes = nativeAllocations.weight[allocationIndex];
    const memoryAddress = nativeAllocations.memoryAddress[allocationIndex];
    if (bytes >= 0) {
      // Handle the allocation.

      // Provide a map back to this index.
      memoryAddressToAllocation.set(memoryAddress, allocationIndex);
      retainedAllocation[allocationIndex] = true;
    } else {
      // Do not retain deallocations.
      retainedAllocation[allocationIndex] = false;

      // Lookup the previous allocation.
      const previousAllocationIndex = memoryAddressToAllocation.get(
        memoryAddress
      );
      if (previousAllocationIndex !== undefined) {
        // This deallocation matches a previous allocation. Remove the allocation.
        retainedAllocation[previousAllocationIndex] = false;
        // There is a match, so delete this old association.
        memoryAddressToAllocation.delete(memoryAddress);
      }
    }
  }

  const newNativeAllocations = getEmptyBalancedNativeAllocationsTable();
  for (let i = 0; i < nativeAllocations.length; i++) {
    const weight = nativeAllocations.weight[i];
    if (retainedAllocation[i]) {
      newNativeAllocations.time.push(nativeAllocations.time[i]);
      newNativeAllocations.stack.push(nativeAllocations.stack[i]);
      newNativeAllocations.weight.push(weight);
      newNativeAllocations.memoryAddress.push(
        nativeAllocations.memoryAddress[i]
      );
      newNativeAllocations.threadId.push(nativeAllocations.threadId[i]);
      newNativeAllocations.length++;
    }
  }

  return newNativeAllocations;
}

/**
 * Extract the hostname and favicon from the first page if we are in single tab
 * view. Currently we assume that we don't change the origin of webpages while
 * profiling in web developer preset. That's why we are simply getting the first
 * page we find that belongs to the active tab. Returns null if profiler is not
 * in the single tab view at the moment.
 */
export function extractProfileFilterPageData(
  pages: PageList | null,
  relevantPages: Set<InnerWindowID>
): ProfileFilterPageData | null {
  if (relevantPages.size === 0 || pages === null) {
    // Either we are not in single tab view, or we don't have pages array(which
    // is the case for older profiles). Return early.
    return null;
  }

  // Getting the first page's innerWindowID and then getting its url.
  const innerWindowID = [...relevantPages][0];
  const filteredPages = pages.filter(
    page => page.innerWindowID === innerWindowID
  );

  if (filteredPages.length !== 1) {
    // There should be only one page with the given innerWindowID, they are unique.
    console.error(`Expected one page but ${filteredPages.length} found.`);
    return null;
  }

  const pageUrl = filteredPages[0].url;
  try {
    const page = new URL(pageUrl);
    // FIXME(Bug 1620546): This is not ideal and we should get the favicon
    // either during profile capture or profile pre-process.
    const favicon = new URL('/favicon.ico', page.origin);
    if (favicon.protocol === 'http:') {
      // Upgrade http requests.
      favicon.protocol = 'https:';
    }
    return {
      origin: page.origin,
      hostname: page.hostname,
      favicon: favicon.href,
    };
  } catch (e) {
    console.error(
      'Error while extracing the hostname and favicon from the page url',
      pageUrl
    );
    return null;
  }
}

// Returns the resource index for a "url" or "webhost" resource which is created
// on demand based on the script URI.
export function getOrCreateURIResource(
  scriptURI: string,
  resourceTable: ResourceTable,
  stringTable: UniqueStringArray,
  originToResourceIndex: Map<string, IndexIntoResourceTable>
): IndexIntoResourceTable {
  // Figure out the origin and host.
  let origin;
  let host;
  try {
    const url = new URL(scriptURI);
    if (
      !(
        url.protocol === 'http:' ||
        url.protocol === 'https:' ||
        url.protocol === 'moz-extension:'
      )
    ) {
      throw new Error('not a webhost or extension protocol');
    }
    origin = url.origin;
    host = url.host;
  } catch (e) {
    origin = scriptURI;
    host = null;
  }

  let resourceIndex = originToResourceIndex.get(origin);
  if (resourceIndex !== undefined) {
    return resourceIndex;
  }

  resourceIndex = resourceTable.length++;
  const originStringIndex = stringTable.indexForString(origin);
  originToResourceIndex.set(origin, resourceIndex);
  if (host) {
    // This is a webhost URL.
    resourceTable.lib[resourceIndex] = undefined;
    resourceTable.name[resourceIndex] = originStringIndex;
    resourceTable.host[resourceIndex] = stringTable.indexForString(host);
    resourceTable.type[resourceIndex] = resourceTypes.webhost;
  } else {
    // This is a URL, but it doesn't point to something on the web, e.g. a
    // chrome url.
    resourceTable.lib[resourceIndex] = undefined;
    resourceTable.name[resourceIndex] = stringTable.indexForString(scriptURI);
    resourceTable.host[resourceIndex] = undefined;
    resourceTable.type[resourceIndex] = resourceTypes.url;
  }
  return resourceIndex;
}

/**
 * See the ThreadsKey type for an explanation.
 */
export function getThreadsKey(threadIndexes: Set<ThreadIndex>): ThreadsKey {
  if (threadIndexes.size === 1) {
    // Return the ThreadIndex directly if there is only one thread.
    // We know this value exists because of the size check, even if Flow doesn't.
    return ensureExists(getFirstItemFromSet(threadIndexes));
  }

  return [...threadIndexes].sort((a, b) => b - a).join(',');
}

/**
 * Checks if threadIndexesSet contains all the threads in the threadsKey.
 */
export function hasThreadKeys(
  threadIndexesSet: Set<ThreadIndex>,
  threadsKey: ThreadsKey
): boolean {
  const threadIndexes = ('' + threadsKey).split(',').map(n => +n);
  for (const threadIndex of threadIndexes) {
    if (!threadIndexesSet.has(threadIndex)) {
      return false;
    }
  }
  return true;
}

/**
 * TODO: write
 */
export function computeMaxThreadCPU(
  threads: Thread[],
  interval: Milliseconds
): number {
  let maxThreadCPU = 0;

  for (const thread of threads) {
    const { threadCPUDelta, time } = thread.samples;
    if (!threadCPUDelta) {
      // Don't have any ThreadCPU values.
      continue;
    }

    // First element of CPU delta is always null because back-end doesn't know
    // the delta since there is no previous sample.
    for (let i = 1; i < threadCPUDelta.length; i++) {
      const cpuDelta = threadCPUDelta[i] || 0;
      const realInterval = (time[i] - time[i - 1]) / interval;
      const currentCPUPerInterval = cpuDelta / realInterval;
      maxThreadCPU = Math.max(maxThreadCPU, currentCPUPerInterval);
    }
  }

  console.log('canova max thread cpu:', maxThreadCPU);
  return maxThreadCPU;
}
