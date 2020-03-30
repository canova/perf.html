/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow

import { getThreadSelectors } from '../selectors/per-thread';
import { assertExhaustiveCheck } from '../utils/flow';
import { isMainThread } from './tracks';

import type { State } from '../types/state';
import type { ThreadIndex, Pid, Profile } from '../types/profile';
import type {
  GlobalTrack,
  LocalTrack,
  TrackIndex,
} from '../types/profile-derived';

import type { ScreenshotPayload } from '../types/markers';

/**
 * Take the global tracks and decide which one to hide during the active tab view.
 * Some global tracks are allowed, some tracks are not, and we have to do some
 * computations for some('process' type specifically).
 */
export function computeActiveTabHiddenGlobalTracks(
  globalTracks: GlobalTrack[],
  state: State
): Set<TrackIndex> {
  const activeTabHiddenGlobalTracks = new Set();

  for (let trackIndex = 0; trackIndex < globalTracks.length; trackIndex++) {
    const globalTrack: GlobalTrack = globalTracks[trackIndex];
    const trackType = globalTrack.type;

    switch (trackType) {
      case 'screenshots':
        // Do not hide screenshots.
        break;
      case 'visual-progress':
      case 'perceptual-visual-progress':
      case 'contentful-visual-progress':
        // Hide those global track types because we want to hide as much as
        // possible from web developers for now.
        activeTabHiddenGlobalTracks.add(trackIndex);
        break;
      case 'process': {
        // Do not display empty tracks if the tab filtered thread is empty.
        if (
          globalTrack.mainThreadIndex !== undefined &&
          globalTrack.mainThreadIndex !== null &&
          isTabFilteredThreadEmpty(globalTrack.mainThreadIndex, state)
        ) {
          // Thread is empty and we should hide it.
          activeTabHiddenGlobalTracks.add(trackIndex);
        }
        break;
      }
      default:
        throw assertExhaustiveCheck(trackType, `Unhandled GlobalTrack type.`);
    }
  }

  return activeTabHiddenGlobalTracks;
}

/**
 * Take the local tracks and decide which one to hide during the active tab view.
 * Some tracks are not allowed, and we have to do some computations for some('thread' type specifically).
 */
export function computeActiveTabHiddenLocalTracksByPid(
  localTracksByPid: Map<Pid, LocalTrack[]>,
  state: State
): Map<Pid, Set<TrackIndex>> {
  const activeTabHiddenLocalTracksByPid = new Map();

  for (const [pid, localTracks] of localTracksByPid) {
    // Pre-put the new Set here, because we should keep the whole processes even though they are empty.
    const currentLocalTracks = new Set();
    activeTabHiddenLocalTracksByPid.set(pid, currentLocalTracks);
    for (let trackIndex = 0; trackIndex < localTracks.length; trackIndex++) {
      const localTrack = localTracks[trackIndex];
      const trackType = localTrack.type;

      switch (trackType) {
        case 'network':
        case 'memory':
        case 'ipc': {
          // Hide those global track types because we want to hide as much as
          // possible from web developers for now.
          currentLocalTracks.add(trackIndex);
          break;
        }
        case 'thread': {
          // We don't want to display empty tracks if the tab filtered thread is empty.
          if (
            localTrack.threadIndex !== undefined &&
            localTrack.threadIndex !== null &&
            isTabFilteredThreadEmpty(localTrack.threadIndex, state)
          ) {
            // Thread is empty and we should hide it.
            currentLocalTracks.add(trackIndex);
          }
          break;
        }
        default:
          throw assertExhaustiveCheck(trackType, `Unhandled LocalTrack type.`);
      }
    }
  }

  return activeTabHiddenLocalTracksByPid;
}

/**
 * Checks whether the tab filtered thread is empty or not.
 * We take a look at the sample and marker data to determine that.
 */
function isTabFilteredThreadEmpty(
  threadIndex: ThreadIndex,
  state: State
): boolean {
  // Have to get the thread selectors to look if the thread is empty or not.
  const threadSelectors = getThreadSelectors(threadIndex);
  const tabFilteredThread = threadSelectors.getActiveTabFilteredThread(state);
  // Check the samples first to see if they are all empty or not.
  for (const stackIndex of tabFilteredThread.samples.stack) {
    if (stackIndex !== null) {
      // Samples are not empty. Do not hide that thread.
      // We don't have to look at the markers because samples are not empty.
      return false;
    }
  }

  const tabFilteredMarkers = threadSelectors.getActiveTabFilteredMarkerIndexesWithoutGlobals(
    state
  );
  if (tabFilteredMarkers.length > 0) {
    // Thread has some markers in it. Don't hide and skip to the next global track.
    return false;
  }

  return true;
}

/**
 * Take a profile and figure out what active tab GlobalTracks it contains.
 * The returned array should contain only one thread and screenshot tracks
 * TODO: add a type for the return value
 */
export function computeActiveTabGlobalTracks(
  profile: Profile,
  state: State
): {| globalTracks: GlobalTrack[], resourceTracks: LocalTrack[] |} {
  const globalTracks: GlobalTrack[] = [];
  const globalTrackCandidates = [];
  const globalTrackSampleCountByIdx: Map<number, number> = new Map();
  let globalTrackIdx = 0;
  const resourceTracks = [];

  for (
    let threadIndex = 0;
    threadIndex < profile.threads.length;
    threadIndex++
  ) {
    const thread = profile.threads[threadIndex];
    const { pid, markers, stringTable } = thread;

    if (isMainThread(thread)) {
      // This is a main thread, there is a possibility that it can be a global
      // track, check if the thread contains active tab data and add it to candidates if it does.

      const sampleCount = getThreadSampleCountOrNull(threadIndex, state);
      if (sampleCount !== null) {
        // This thread is not completly empty. Add it to the candidates.
        globalTrackCandidates[globalTrackIdx] = {
          type: 'process',
          pid,
          mainThreadIndex: threadIndex,
        };
        globalTrackSampleCountByIdx.set(globalTrackIdx, sampleCount);
        globalTrackIdx++;
      }
    } else {
      // This is not a main thread, it's not possible that this can be a global
      // track. Find out if that thread contains the active tab data, and add it
      // as a resource track if it does.
      if (!isTabFilteredThreadEmpty(threadIndex, state)) {
        resourceTracks.push({ type: 'thread', threadIndex });
      }
    }

    // Check for screenshots.
    const windowIDs: Set<string> = new Set();
    if (stringTable.hasString('CompositorScreenshot')) {
      const screenshotNameIndex = stringTable.indexForString(
        'CompositorScreenshot'
      );
      for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
        if (markers.name[markerIndex] === screenshotNameIndex) {
          // Coerce the payload to a screenshot one. Don't do a runtime check that
          // this is correct.
          const data: ScreenshotPayload = (markers.data[markerIndex]: any);
          windowIDs.add(data.windowID);
        }
      }
      for (const id of windowIDs) {
        globalTracks.push({ type: 'screenshots', id, threadIndex });
      }
    }
  }

  // Now we know the global track candidates, find the most crowded one and add it.
  let heaviestTrackIndex = -1;
  let heaviestTrackSampleCount = -1;
  for (const [trackIndex, sampleCount] of globalTrackSampleCountByIdx) {
    if (sampleCount > heaviestTrackSampleCount) {
      heaviestTrackIndex = trackIndex;
      heaviestTrackSampleCount = sampleCount;
    }
  }

  if (heaviestTrackIndex === -1) {
    throw new Error('Main global track could not found');
  }

  // Put the main global track to the last element since we want to display the screenshots first.
  globalTracks.push(globalTrackCandidates[heaviestTrackIndex]);
  // Put the other candidates under the resources
  globalTrackCandidates.splice(heaviestTrackIndex, 1);
  resourceTracks.unshift(
    ...globalTrackCandidates.map(track => ({
      type: 'thread',
      threadIndex: track.mainThreadIndex,
    }))
  );

  console.log('CANOVA GLOBAL RESOURCE: ', globalTracks, resourceTracks);

  return { globalTracks, resourceTracks };
}

/**
 * It's null if the thread is copletly empty, and a number if it's not.
 * !!!THIS FUNCTION IS VERY(BUT VEEERY) EXPENSIVE!!!
 */
function getThreadSampleCountOrNull(
  threadIndex: ThreadIndex,
  state: State
): number | null {
  // Have to get the thread selectors to look if the thread is empty or not.
  const threadSelectors = getThreadSelectors(threadIndex);
  const tabFilteredThread = threadSelectors.getActiveTabFilteredThread(state);
  let nonNullSampleCount = 0;
  // Check the samples first to see if they are all empty or not.
  for (const stackIndex of tabFilteredThread.samples.stack) {
    if (stackIndex !== null) {
      // Samples are not empty, increment the counter.
      nonNullSampleCount++;
    }
  }

  const tabFilteredMarkers = threadSelectors.getActiveTabFilteredMarkerIndexesWithoutGlobals(
    state
  );
  if (tabFilteredMarkers.length > 0) {
    // Thread has some markers in it. Don't hide and skip to the next global track.
    return nonNullSampleCount;
  }

  // There are no markers in this thread, check the samples and return null
  // if they are empty as well.
  return nonNullSampleCount === 0 ? null : nonNullSampleCount;
}
