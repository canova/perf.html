/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import React, { PureComponent } from 'react';
import { ContextMenu, MenuItem } from 'react-contextmenu';
import { Localized } from '@fluent/react';

import './TrackContextMenu.css';
import {
  hideGlobalTrack,
  showAllTracks,
  showGlobalTrack,
  isolateProcess,
  isolateLocalTrack,
  isolateProcessMainThread,
  isolateScreenshot,
  hideLocalTrack,
  showLocalTrack,
  changeTrackSearchString,
  showProvidedTracks,
} from 'firefox-profiler/actions/profile-view';
import explicitConnect from 'firefox-profiler/utils/connect';
import { ensureExists } from 'firefox-profiler/utils/flow';
import {
  getThreads,
  getRightClickedTrack,
  getGlobalTracks,
  getRightClickedThreadIndex,
  getLocalTrackNamesByPid,
  getGlobalTrackNames,
  getLocalTracksByPid,
  getSearchFilteredGlobalTracks,
  getSearchFilteredLocalTracksByPid,
} from 'firefox-profiler/selectors/profile';
import {
  getGlobalTrackOrder,
  getHiddenGlobalTracks,
  getHiddenLocalTracksByPid,
  getLocalTrackOrderByPid,
  getTrackSearchString,
} from 'firefox-profiler/selectors/url-state';
import { TrackSearchField } from 'firefox-profiler/components/shared/TrackSearchField';
import classNames from 'classnames';

import type {
  Thread,
  ThreadIndex,
  Pid,
  TrackIndex,
  GlobalTrack,
  LocalTrack,
  State,
  TrackReference,
} from 'firefox-profiler/types';

import type { ConnectedProps } from 'firefox-profiler/utils/connect';

type StateProps = {|
  +threads: Thread[],
  +globalTrackOrder: TrackIndex[],
  +hiddenGlobalTracks: Set<TrackIndex>,
  +hiddenLocalTracksByPid: Map<Pid, Set<TrackIndex>>,
  +localTrackOrderByPid: Map<Pid, TrackIndex[]>,
  +rightClickedTrack: TrackReference | null,
  +globalTracks: GlobalTrack[],
  +rightClickedThreadIndex: ThreadIndex | null,
  +globalTrackNames: string[],
  +localTracksByPid: Map<Pid, LocalTrack[]>,
  +localTrackNamesByPid: Map<Pid, string[]>,
  +searchString: string,
  +searchFilteredGlobalTracks: Set<TrackIndex> | null,
  +searchFilteredLocalTracksByPid: Map<Pid, Set<TrackIndex>> | null,
|};

type DispatchProps = {|
  +hideGlobalTrack: typeof hideGlobalTrack,
  +showAllTracks: typeof showAllTracks,
  +showGlobalTrack: typeof showGlobalTrack,
  +isolateProcess: typeof isolateProcess,
  +hideLocalTrack: typeof hideLocalTrack,
  +showLocalTrack: typeof showLocalTrack,
  +isolateLocalTrack: typeof isolateLocalTrack,
  +isolateProcessMainThread: typeof isolateProcessMainThread,
  +isolateScreenshot: typeof isolateScreenshot,
  +changeTrackSearchString: typeof changeTrackSearchString,
  +showProvidedTracks: typeof showProvidedTracks,
|};

type Props = ConnectedProps<{||}, StateProps, DispatchProps>;

class TimelineTrackContextMenuImpl extends PureComponent<Props> {
  _trackSearchFieldElem: {| current: TrackSearchField | null |} =
    React.createRef();

  _showAllTracks = (): void => {
    const { showAllTracks } = this.props;
    showAllTracks();
  };

  _showProvidedTracks = (): void => {
    const {
      showProvidedTracks,
      searchFilteredGlobalTracks,
      searchFilteredLocalTracksByPid,
    } = this.props;
    if (
      searchFilteredGlobalTracks === null ||
      searchFilteredLocalTracksByPid === null
    ) {
      // This shouldn't happen!
      return;
    }
    showProvidedTracks(
      searchFilteredGlobalTracks,
      searchFilteredLocalTracksByPid
    );
  };

  _toggleGlobalTrackVisibility = (
    _,
    data: { trackIndex: TrackIndex }
  ): void => {
    const { trackIndex } = data;
    const { hiddenGlobalTracks, hideGlobalTrack, showGlobalTrack } = this.props;
    if (hiddenGlobalTracks.has(trackIndex)) {
      showGlobalTrack(trackIndex);
    } else {
      hideGlobalTrack(trackIndex);
    }
  };

  _toggleLocalTrackVisibility = (
    _,
    data: { pid: Pid, trackIndex: TrackIndex, globalTrackIndex: TrackIndex }
  ): void => {
    const { trackIndex, pid, globalTrackIndex } = data;
    const {
      hiddenLocalTracksByPid,
      hideLocalTrack,
      showLocalTrack,
      hiddenGlobalTracks,
      showGlobalTrack,
      localTrackOrderByPid,
    } = this.props;
    const hiddenLocalTracks = ensureExists(
      hiddenLocalTracksByPid.get(pid),
      'Expected to find hidden local tracks for the given pid'
    );

    if (hiddenGlobalTracks.has(globalTrackIndex)) {
      // When the parent global track is hidden, instead of simply
      // toggling, we'll just unhide the global track and this
      // particular local track. Other local tracks should be hidden.
      showGlobalTrack(globalTrackIndex);
      const localTrackOrder = ensureExists(
        localTrackOrderByPid.get(pid),
        'Expected to find local tracks for the given pid'
      );
      localTrackOrder.forEach((index) => {
        if (index === trackIndex) {
          showLocalTrack(pid, trackIndex);
        } else {
          hideLocalTrack(pid, index);
        }
      });
    } else {
      // When the global track is not hidden, we'll just go ahead and
      // toggle this local track.
      if (hiddenLocalTracks.has(trackIndex)) {
        showLocalTrack(pid, trackIndex);
      } else {
        hideLocalTrack(pid, trackIndex);
      }
    }
  };

  _isolateProcess = () => {
    const { isolateProcess, rightClickedTrack } = this.props;
    if (rightClickedTrack === null) {
      throw new Error(
        'Attempted to isolate the process with no right clicked track.'
      );
    }
    if (rightClickedTrack.type === 'local') {
      throw new Error(
        'Attempting to isolate a process track with a local track is selected.'
      );
    }
    isolateProcess(rightClickedTrack.trackIndex);
  };

  _isolateScreenshot = () => {
    const { isolateScreenshot, rightClickedTrack } = this.props;
    if (rightClickedTrack === null) {
      throw new Error(
        'Attempted to isolate the screenshot with no right clicked track.'
      );
    }
    if (rightClickedTrack.type !== 'global') {
      throw new Error(
        'Attempting to isolate a screenshot track with a local track is selected.'
      );
    }
    isolateScreenshot(rightClickedTrack.trackIndex);
  };

  _isolateProcessMainThread = () => {
    const { isolateProcessMainThread, rightClickedTrack } = this.props;
    if (rightClickedTrack === null) {
      throw new Error(
        'Attempted to isolate the process main thread with no right clicked track.'
      );
    }

    if (rightClickedTrack.type === 'local') {
      throw new Error(
        'Attempting to isolate a process track with a local track is selected.'
      );
    }
    isolateProcessMainThread(rightClickedTrack.trackIndex);
  };

  _isolateLocalTrack = () => {
    const { isolateLocalTrack, rightClickedTrack } = this.props;
    if (rightClickedTrack === null) {
      throw new Error(
        'Attempted to isolate the local track with no right clicked track.'
      );
    }

    if (rightClickedTrack.type === 'global') {
      throw new Error(
        'Attempting to isolate a local track with a global track is selected.'
      );
    }
    const { pid, trackIndex } = rightClickedTrack;
    isolateLocalTrack(pid, trackIndex);
  };

  // Check if the global track has a local track that also matches the filter.
  // We should still show the global tracks that have them.
  _globalTrackHasSearchFilterMatchedChildren(track: GlobalTrack): boolean {
    const { searchFilteredLocalTracksByPid } = this.props;
    if (!track.pid || searchFilteredLocalTracksByPid === null) {
      return false;
    }

    const searchFilteredLocalTracks = searchFilteredLocalTracksByPid.get(
      track.pid
    );
    if (!searchFilteredLocalTracks) {
      // This should not happen, but fail with a false if it does.
      return false;
    }
    return searchFilteredLocalTracks.size !== 0;
  }

  renderGlobalTrack(trackIndex: TrackIndex) {
    const {
      hiddenGlobalTracks,
      globalTrackNames,
      globalTracks,
      searchFilteredGlobalTracks,
    } = this.props;
    const isHidden = hiddenGlobalTracks.has(trackIndex);
    const track = globalTracks[trackIndex];
    const hasSearchFilterMatchedChildren =
      this._globalTrackHasSearchFilterMatchedChildren(track);
    const isHiddenBySearch =
      searchFilteredGlobalTracks && !searchFilteredGlobalTracks.has(trackIndex);

    if (isHiddenBySearch && !hasSearchFilterMatchedChildren) {
      // This means that both search filter doesn't match this global track, and
      // it doesn't have any local track that matches to the filter. In this
      // case, don't show it.
      return null;
    }

    // If a global track is explicitly filtered by search, we should show all of
    // its children.
    const skipSearchFilterInChildren =
      searchFilteredGlobalTracks !== null && !isHiddenBySearch;

    let title = `${globalTrackNames[trackIndex]}`;
    if (track.type === 'process') {
      title += ` (Process ID: ${track.pid})`;
    }

    return (
      <React.Fragment>
        <MenuItem
          key={trackIndex}
          preventClose={true}
          data={{ trackIndex }}
          onClick={this._toggleGlobalTrackVisibility}
          attributes={{
            className: classNames('timelineTrackContextMenuItem', {
              checkable: true,
              checked: !isHidden,
            }),
            title,
          }}
        >
          <span>{globalTrackNames[trackIndex]}</span>
          <span className="timelineTrackContextMenuSpacer" />
          {track.type === 'process' && (
            <span className="timelineTrackContextMenuPid">({track.pid})</span>
          )}
        </MenuItem>
        {track.type === 'process'
          ? this.renderLocalTracks(
              trackIndex,
              track.pid,
              skipSearchFilterInChildren
            )
          : null}
      </React.Fragment>
    );
  }

  renderLocalTracks(
    globalTrackIndex: TrackIndex,
    pid: Pid,
    skipSearchFilter: boolean
  ) {
    const {
      hiddenLocalTracksByPid,
      localTrackOrderByPid,
      localTrackNamesByPid,
      hiddenGlobalTracks,
      localTracksByPid,
      searchFilteredLocalTracksByPid,
    } = this.props;

    const isGlobalTrackHidden = hiddenGlobalTracks.has(globalTrackIndex);
    const localTrackOrder = localTrackOrderByPid.get(pid);
    const hiddenLocalTracks = hiddenLocalTracksByPid.get(pid);
    const localTrackNames = localTrackNamesByPid.get(pid);
    const localTracks = localTracksByPid.get(pid);
    let searchFilteredLocalTracks = null;
    if (searchFilteredLocalTracksByPid !== null && !skipSearchFilter) {
      searchFilteredLocalTracks = searchFilteredLocalTracksByPid.get(pid);
    }

    if (
      localTrackOrder === undefined ||
      hiddenLocalTracks === undefined ||
      localTrackNames === undefined ||
      localTracks === undefined
    ) {
      console.error(
        'Unable to find local track information for the given pid:',
        pid
      );
      return null;
    }

    const localTrackMenuItems = [];
    for (const trackIndex of localTrackOrder) {
      if (
        searchFilteredLocalTracks &&
        !searchFilteredLocalTracks.has(trackIndex)
      ) {
        // Search filter doesn't match this track, skip it.
        continue;
      }

      localTrackMenuItems.push(
        <MenuItem
          key={trackIndex}
          preventClose={true}
          data={{ pid, trackIndex, globalTrackIndex }}
          onClick={this._toggleLocalTrackVisibility}
          attributes={{
            className: classNames('checkable indented', {
              checked:
                !hiddenLocalTracks.has(trackIndex) && !isGlobalTrackHidden,
            }),
          }}
        >
          {localTrackNames[trackIndex]}
        </MenuItem>
      );
    }

    return localTrackMenuItems;
  }

  getRightClickedTrackName(rightClickedTrack: TrackReference): string {
    const { globalTrackNames, localTrackNamesByPid } = this.props;

    if (rightClickedTrack.type === 'global') {
      return globalTrackNames[rightClickedTrack.trackIndex];
    }
    const localTrackNames = localTrackNamesByPid.get(rightClickedTrack.pid);
    if (localTrackNames === undefined) {
      console.error('Expected to find a local track name for the given pid.');
      return 'Unknown Track';
    }
    return localTrackNames[rightClickedTrack.trackIndex];
  }

  renderIsolateProcess() {
    const {
      rightClickedTrack,
      globalTracks,
      globalTrackOrder,
      hiddenGlobalTracks,
      hiddenLocalTracksByPid,
      localTracksByPid,
    } = this.props;

    if (rightClickedTrack === null) {
      return null;
    }

    if (rightClickedTrack.type !== 'global' || globalTracks.length === 1) {
      // This is not a valid candidate for isolating.
      return null;
    }

    const track = globalTracks[rightClickedTrack.trackIndex];
    if (track.type !== 'process') {
      // Only process tracks can be isolated.
      return null;
    }

    // Disable this option if there is only one left global track left.
    let isDisabled = hiddenGlobalTracks.size === globalTrackOrder.length - 1;

    if (!isDisabled && track.mainThreadIndex === null) {
      // Ensure there is a valid thread index in the local tracks to isolate, otherwise
      // disable this track.
      const localTracks = localTracksByPid.get(track.pid);
      const hiddenLocalTracks = hiddenLocalTracksByPid.get(track.pid);
      if (localTracks === undefined || hiddenLocalTracks === undefined) {
        console.error('Local track information for the given pid.');
        return null;
      }
      let hasVisibleLocalTrackWithMainThread = false;
      for (let trackIndex = 0; trackIndex < localTracks.length; trackIndex++) {
        const localTrack = localTracks[trackIndex];
        if (
          localTrack.type === 'thread' &&
          !hiddenLocalTracks.has(trackIndex)
        ) {
          hasVisibleLocalTrackWithMainThread = true;
          break;
        }
      }
      if (!hasVisibleLocalTrackWithMainThread) {
        // The process has no main thread, and there are no visible local tracks
        // with a thread index, do not offer to isolate in this case, but just disable
        // this button in case some threads become visible while the menu is open.
        isDisabled = true;
      }
    }

    return (
      <MenuItem onClick={this._isolateProcess} disabled={isDisabled}>
        <Localized id="TrackContextMenu--only-show-this-process-group">
          Only show this process group
        </Localized>
      </MenuItem>
    );
  }

  renderIsolateProcessMainThread() {
    const {
      rightClickedTrack,
      globalTracks,
      hiddenGlobalTracks,
      hiddenLocalTracksByPid,
      localTrackOrderByPid,
    } = this.props;

    if (rightClickedTrack === null) {
      return null;
    }

    if (rightClickedTrack.type !== 'global') {
      // This is not a valid candidate for isolating. Either there are not
      // enough threads, or the right clicked track didn't have an associated thread
      // index.
      return null;
    }

    const track = globalTracks[rightClickedTrack.trackIndex];
    if (track.type !== 'process' || track.mainThreadIndex === null) {
      // Only process tracks with a main thread can be isolated.
      return null;
    }

    // Look up the local track information.
    const hiddenLocalTracks = hiddenLocalTracksByPid.get(track.pid);
    const localTrackOrder = localTrackOrderByPid.get(track.pid);
    if (hiddenLocalTracks === undefined || localTrackOrder === undefined) {
      console.error(
        'Expected to find local track information for the given pid.'
      );
      return null;
    }

    const isDisabled =
      // Does it have no visible local tracks?
      hiddenLocalTracks.size === localTrackOrder.length &&
      // Is there only one visible global track?
      globalTracks.length - hiddenGlobalTracks.size === 1;

    const rightClickedTrackName =
      this.getRightClickedTrackName(rightClickedTrack);

    return (
      <MenuItem onClick={this._isolateProcessMainThread} disabled={isDisabled}>
        <Localized
          id="TrackContextMenu--only-show-track"
          vars={{ trackName: rightClickedTrackName }}
        >
          <>Only show {`“${rightClickedTrackName}”`}</>
        </Localized>
      </MenuItem>
    );
  }

  renderIsolateLocalTrack() {
    const {
      rightClickedTrack,
      globalTracks,
      hiddenGlobalTracks,
      hiddenLocalTracksByPid,
      localTrackOrderByPid,
    } = this.props;

    if (rightClickedTrack === null) {
      return null;
    }

    if (rightClickedTrack.type === 'global') {
      return null;
    }

    // Select the local track info.
    const hiddenLocalTracks = hiddenLocalTracksByPid.get(rightClickedTrack.pid);
    const localTrackOrder = localTrackOrderByPid.get(rightClickedTrack.pid);
    if (hiddenLocalTracks === undefined || localTrackOrder === undefined) {
      console.error(
        'Expected to find local track information for the given pid.'
      );
      return null;
    }

    const isDisabled =
      // Is there only one global track visible?
      globalTracks.length - hiddenGlobalTracks.size === 1 &&
      // Is there only one local track left?
      localTrackOrder.length - hiddenLocalTracks.size === 1;

    const rightClickedTrackName =
      this.getRightClickedTrackName(rightClickedTrack);

    return (
      <MenuItem onClick={this._isolateLocalTrack} disabled={isDisabled}>
        <Localized
          id="TrackContextMenu--only-show-track"
          vars={{ trackName: rightClickedTrackName }}
        >
          <>Only show {`“rightClickedTrackName}”`}</>
        </Localized>
      </MenuItem>
    );
  }

  getVisibleScreenshotTracks(): GlobalTrack[] {
    const { globalTracks, hiddenGlobalTracks } = this.props;
    const visibleScreenshotTracks = globalTracks.filter(
      (globalTrack, trackIndex) =>
        globalTrack.type === 'screenshots' &&
        !hiddenGlobalTracks.has(trackIndex)
    );
    return visibleScreenshotTracks;
  }

  renderIsolateScreenshot() {
    const { rightClickedTrack, globalTracks } = this.props;

    if (rightClickedTrack === null) {
      return null;
    }

    if (rightClickedTrack.type !== 'global') {
      // This is not a valid candidate for isolating.
      return null;
    }

    const track = globalTracks[rightClickedTrack.trackIndex];
    if (track.type !== 'screenshots') {
      // Only process screenshot tracks
      return null;
    }

    // We check that it's less or equal to 1 (instead of just equal to 1)
    // because we want to also leave the item disabled when we hide the last
    // screenshot track while the menu is open.
    const isDisabled = this.getVisibleScreenshotTracks().length <= 1;
    return (
      <MenuItem onClick={this._isolateScreenshot} disabled={isDisabled}>
        <Localized id="TrackContextMenu--hide-other-screenshots-tracks">
          Hide other Screenshots tracks
        </Localized>
      </MenuItem>
    );
  }

  renderHideTrack() {
    const { rightClickedTrack } = this.props;
    if (rightClickedTrack === null) {
      return null;
    }
    const trackIndex = rightClickedTrack.trackIndex;
    const rightClickedTrackName =
      this.getRightClickedTrackName(rightClickedTrack);

    if (rightClickedTrack.type === 'global') {
      return (
        <MenuItem
          key={trackIndex}
          preventClose={false}
          data={rightClickedTrack}
          onClick={this._toggleGlobalTrackVisibility}
        >
          <Localized
            id="TrackContextMenu--hide-track"
            vars={{ trackName: rightClickedTrackName }}
          >
            <>Hide {`“${rightClickedTrackName}”`}</>
          </Localized>
        </MenuItem>
      );
    }
    return (
      <MenuItem
        key={trackIndex}
        preventClose={false}
        data={rightClickedTrack}
        onClick={this._toggleLocalTrackVisibility}
      >
        <Localized
          id="TrackContextMenu--hide-track"
          vars={{ trackName: rightClickedTrackName }}
        >
          <>Hide {`“${rightClickedTrackName}”`}</>
        </Localized>
      </MenuItem>
    );
  }

  renderShowAllTracks() {
    const { rightClickedTrack } = this.props;
    if (rightClickedTrack !== null) {
      return null;
    }
    const hiddenLocalTracksCount = [
      ...this.props.hiddenLocalTracksByPid.values(),
    ].reduce((total, set) => total + set.size, 0);
    const isDisabled =
      hiddenLocalTracksCount + this.props.hiddenGlobalTracks.size === 0;

    return (
      <React.Fragment>
        <MenuItem onClick={this._showAllTracks} disabled={isDisabled}>
          <Localized id="TrackContextMenu--show-all-tracks">
            Show all tracks
          </Localized>
        </MenuItem>
        <div className="react-contextmenu-separator" />
      </React.Fragment>
    );
  }

  renderShowProvidedTracks() {
    const { rightClickedTrack } = this.props;
    if (rightClickedTrack !== null) {
      return null;
    }

    return (
      <React.Fragment>
        <MenuItem onClick={this._showProvidedTracks}>
          <Localized id="TrackContextMenu--show-all-tracks-below">
            Show all tracks below
          </Localized>
        </MenuItem>
        <div className="react-contextmenu-separator" />
      </React.Fragment>
    );
  }

  renderTrackSearchField() {
    const { rightClickedTrack, searchString } = this.props;
    if (rightClickedTrack !== null) {
      // This option should only be visible in the top context menu and not when
      // user right clicks.
      return null;
    }

    return (
      <React.Fragment>
        <Localized id="TrackContextMenu--track-filter" attrs={{ title: true }}>
          <TrackSearchField
            className="trackContextMenuSearchField"
            title="Only display tracks that match a certain text"
            currentSearchString={searchString}
            onSearch={this._onSearch}
            ref={this._trackSearchFieldElem}
          />
        </Localized>
        <div className="react-contextmenu-separator" />
      </React.Fragment>
    );
  }

  _onSearch = (value: string) => {
    this.props.changeTrackSearchString(value);
  };

  _onShow = () => {
    if (
      // We need to focus the track search filter. But we can't use autoFocus
      // property because this context menu is already rendered and hidden during
      // the load of the web page. So, when user clicks on the track context menu
      // button, focus will be moved to that component and search filter will not
      // be focused anymore. To fix this, we are manually calling the focus.
      this._trackSearchFieldElem.current &&
      this._trackSearchFieldElem.current.idleSearchField.current
    ) {
      this._trackSearchFieldElem.current.idleSearchField.current.focus();
    }
  };

  render() {
    const { globalTrackOrder, globalTracks, rightClickedTrack, searchString } =
      this.props;
    const isolateProcessMainThread = this.renderIsolateProcessMainThread();
    const isolateProcess = this.renderIsolateProcess();
    const isolateLocalTrack = this.renderIsolateLocalTrack();
    const isolateScreenshot = this.renderIsolateScreenshot();
    const hideTrack = this.renderHideTrack();
    const showAllTracksMenu = this.renderShowAllTracks();
    const showProvidedTracksMenu = this.renderShowProvidedTracks();
    const trackSearch = this.renderTrackSearchField();
    const separator =
      isolateProcessMainThread ||
      isolateProcess ||
      isolateLocalTrack ||
      isolateScreenshot ? (
        <div className="react-contextmenu-separator" />
      ) : null;

    return (
      <ContextMenu
        id="TimelineTrackContextMenu"
        className="timelineTrackContextMenu"
        onShow={this._onShow}
      >
        {
          // The menu items header items to isolate tracks may or may not be
          // visible depending on the current state.
        }
        {trackSearch}
        {searchString ? showProvidedTracksMenu : showAllTracksMenu}
        {isolateProcessMainThread}
        {isolateProcess}
        {isolateLocalTrack}
        {isolateScreenshot}
        {hideTrack}
        {separator}
        {globalTrackOrder.map((globalTrackIndex) => {
          const globalTrack = globalTracks[globalTrackIndex];
          if (rightClickedTrack === null) {
            return (
              <div key={globalTrackIndex}>
                {this.renderGlobalTrack(globalTrackIndex)}
              </div>
            );
          } else if (
            rightClickedTrack.type === 'global' &&
            rightClickedTrack.trackIndex === globalTrackIndex
          ) {
            return (
              <div key={globalTrackIndex}>
                {this.renderGlobalTrack(globalTrackIndex)}
              </div>
            );
          } else if (
            rightClickedTrack.type === 'local' &&
            globalTrack.type === 'process'
          ) {
            if (rightClickedTrack.pid === globalTrack.pid) {
              return (
                <div key={globalTrackIndex}>
                  {this.renderGlobalTrack(globalTrackIndex)}
                </div>
              );
            }
          }
          return null;
        })}
      </ContextMenu>
    );
  }
}

export const TimelineTrackContextMenu = explicitConnect<
  {||},
  StateProps,
  DispatchProps
>({
  mapStateToProps: (state: State) => ({
    threads: getThreads(state),
    globalTrackOrder: getGlobalTrackOrder(state),
    hiddenGlobalTracks: getHiddenGlobalTracks(state),
    rightClickedTrack: getRightClickedTrack(state),
    globalTracks: getGlobalTracks(state),
    hiddenLocalTracksByPid: getHiddenLocalTracksByPid(state),
    localTrackOrderByPid: getLocalTrackOrderByPid(state),
    rightClickedThreadIndex: getRightClickedThreadIndex(state),
    globalTrackNames: getGlobalTrackNames(state),
    localTracksByPid: getLocalTracksByPid(state),
    localTrackNamesByPid: getLocalTrackNamesByPid(state),
    searchString: getTrackSearchString(state),
    searchFilteredGlobalTracks: getSearchFilteredGlobalTracks(state),
    searchFilteredLocalTracksByPid: getSearchFilteredLocalTracksByPid(state),
  }),
  mapDispatchToProps: {
    hideGlobalTrack,
    showAllTracks,
    showGlobalTrack,
    isolateProcess,
    isolateLocalTrack,
    isolateProcessMainThread,
    isolateScreenshot,
    hideLocalTrack,
    showLocalTrack,
    changeTrackSearchString,
    showProvidedTracks,
  },
  component: TimelineTrackContextMenuImpl,
});
