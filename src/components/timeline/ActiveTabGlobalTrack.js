/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import React, { PureComponent } from 'react';
import classNames from 'classnames';
import {
  changeRightClickedTrack,
  selectTrack,
} from '../../actions/profile-view';
import {
  getSelectedThreadIndex,
  getSelectedTab,
} from '../../selectors/url-state';
import explicitConnect from '../../utils/connect';
import {
  getActiveTabGlobalTracks,
  getActiveTabResourceTracks,
  getProcessesWithMemoryTrack,
  getVisualProgress,
  getPerceptualSpeedIndexProgress,
  getContentfulSpeedIndexProgress,
} from '../../selectors/profile';
import './Track.css';
import TimelineTrackThread from './TrackThread';
import TimelineTrackScreenshots from './TrackScreenshots';
import ActiveTabResources from './ActiveTabResources';
import { TrackVisualProgress } from './TrackVisualProgress';
import { TRACK_PROCESS_BLANK_HEIGHT } from '../../app-logic/constants';

import type { TabSlug } from '../../app-logic/tabs-handling';
import type { GlobalTrackReference } from '../../types/actions';
import type { Pid, ProgressGraphData } from '../../types/profile';
import type {
  TrackIndex,
  GlobalTrack,
  LocalTrack,
  InitialSelectedTrackReference,
} from '../../types/profile-derived';
import type { ConnectedProps } from '../../utils/connect';

type OwnProps = {|
  +trackReference: GlobalTrackReference,
  +trackIndex: TrackIndex,
  +style?: Object /* This is used by Reorderable */,
  +setInitialSelected: (el: InitialSelectedTrackReference) => void,
|};

type StateProps = {|
  +globalTrack: GlobalTrack,
  +isSelected: boolean,
  +resourceTracks: LocalTrack[],
  +pid: Pid | null,
  +selectedTab: TabSlug,
  +processesWithMemoryTrack: Set<Pid>,
  +progressGraphData: ProgressGraphData[] | null,
|};

type DispatchProps = {|
  +changeRightClickedTrack: typeof changeRightClickedTrack,
  +selectTrack: typeof selectTrack,
|};

type Props = ConnectedProps<OwnProps, StateProps, DispatchProps>;

class GlobalTrackComponent extends PureComponent<Props> {
  _container: HTMLElement | null = null;
  _isInitialSelectedPane: boolean | null = null;
  _onLabelMouseDown = (event: MouseEvent) => {
    const { changeRightClickedTrack, trackReference } = this.props;

    if (event.button === 0) {
      // Don't allow clicks on the threads list to steal focus from the tree view.
      event.preventDefault();
      this._selectCurrentTrack();
    } else if (event.button === 2) {
      // This is needed to allow the context menu to know what was right clicked without
      // actually changing the current selection.
      changeRightClickedTrack(trackReference);
    }
  };

  _selectCurrentTrack = () => {
    const { selectTrack, trackReference } = this.props;
    selectTrack(trackReference);
  };

  renderTrack() {
    const {
      globalTrack,
      processesWithMemoryTrack,
      progressGraphData,
    } = this.props;
    switch (globalTrack.type) {
      case 'process': {
        const { mainThreadIndex } = globalTrack;
        console.log(
          'CANOVA render global track: ',
          globalTrack.type,
          mainThreadIndex,
          processesWithMemoryTrack
        );
        if (mainThreadIndex === null) {
          return (
            <div
              className="timelineTrackThreadBlank"
              style={{
                '--timeline-track-thread-blank-height': `${TRACK_PROCESS_BLANK_HEIGHT}px`,
              }}
            />
          );
        }
        return (
          <TimelineTrackThread
            threadIndex={mainThreadIndex}
            showMemoryMarkers={false}
            trackType="global"
          />
        );
      }
      case 'screenshots': {
        const { threadIndex, id } = globalTrack;
        return (
          <TimelineTrackScreenshots threadIndex={threadIndex} windowId={id} />
        );
      }
      case 'visual-progress': {
        if (!progressGraphData) {
          throw new Error('Progress Graph Data is null');
        }
        return (
          <TrackVisualProgress
            progressGraphData={progressGraphData}
            graphDotTooltipText=" visual completeness at this time"
            windowId={globalTrack.id}
          />
        );
      }
      case 'perceptual-visual-progress': {
        if (!progressGraphData) {
          throw new Error('Progress Graph Data is null');
        }
        return (
          <TrackVisualProgress
            progressGraphData={progressGraphData}
            graphDotTooltipText=" perceptual visual completeness at this time"
            windowId={globalTrack.id}
          />
        );
      }
      case 'contentful-visual-progress': {
        if (!progressGraphData) {
          throw new Error('Progress Graph Data is null');
        }
        return (
          <TrackVisualProgress
            progressGraphData={progressGraphData}
            graphDotTooltipText=" contentful visual completeness at this time"
            windowId={globalTrack.id}
          />
        );
      }
      default:
        console.error('Unhandled globalTrack type', (globalTrack: empty));
        return null;
    }
  }

  renderResourcesPanel() {
    const { resourceTracks } = this.props;
    if (resourceTracks.length === 0) {
      return null;
    }
    return (
      <ActiveTabResources
        resourceTracks={resourceTracks}
        setIsInitialSelectedPane={this.setIsInitialSelectedPane}
      />
    );
  }

  _takeContainerRef = (el: HTMLElement | null) => {
    const { isSelected } = this.props;
    this._container = el;

    if (isSelected) {
      this.setIsInitialSelectedPane(true);
    }
  };

  setIsInitialSelectedPane = (value: boolean) => {
    this._isInitialSelectedPane = value;
  };

  componentDidMount() {
    if (this._isInitialSelectedPane && this._container !== null) {
      this.props.setInitialSelected(this._container);
    }
  }

  render() {
    const { isSelected, style, resourceTracks, pid } = this.props;

    return (
      <li ref={this._takeContainerRef} className="timelineTrack" style={style}>
        <div
          className={classNames(
            'timelineTrackRow timelineTrackGlobalRow activeTab',
            {
              selected: isSelected,
            }
          )}
          onClick={this._selectCurrentTrack}
        >
          <div className="timelineTrackTrack">{this.renderTrack()}</div>
        </div>
        {resourceTracks.length > 0 && pid !== null
          ? this.renderResourcesPanel()
          : null}
      </li>
    );
  }
}

// Provide some empty lists, so that strict equality checks work for component updates.
const EMPTY_RESOURCE_TRACKS = [];

export default explicitConnect<OwnProps, StateProps, DispatchProps>({
  mapStateToProps: (state, { trackIndex }) => {
    const globalTracks = getActiveTabGlobalTracks(state);
    const globalTrack = globalTracks[trackIndex];
    const selectedTab = getSelectedTab(state);

    // These get assigned based on the track type.
    let threadIndex = null;
    let isSelected = false;

    let resourceTracks = EMPTY_RESOURCE_TRACKS;
    let pid = null;
    let progressGraphData = null;

    console.log('CANOVA: global track', globalTrack);
    // Run different selectors based on the track type.
    switch (globalTrack.type) {
      case 'process': {
        // Look up the thread information for the process if it exists.
        if (globalTrack.mainThreadIndex !== null) {
          threadIndex = globalTrack.mainThreadIndex;
          isSelected =
            threadIndex === getSelectedThreadIndex(state) &&
            selectedTab !== 'network-chart';
        }
        pid = globalTrack.pid;
        resourceTracks = getActiveTabResourceTracks(state);
        break;
      }
      case 'screenshots':
        break;
      case 'visual-progress':
        progressGraphData = getVisualProgress(state);
        break;
      case 'perceptual-visual-progress':
        progressGraphData = getPerceptualSpeedIndexProgress(state);
        break;
      case 'contentful-visual-progress':
        progressGraphData = getContentfulSpeedIndexProgress(state);
        break;
      default:
        throw new Error(`Unhandled GlobalTrack type ${(globalTrack: empty)}`);
    }

    return {
      globalTrack,
      isSelected,
      resourceTracks,
      pid,
      selectedTab,
      processesWithMemoryTrack: getProcessesWithMemoryTrack(state),
      progressGraphData,
    };
  },
  mapDispatchToProps: {
    changeRightClickedTrack,
    selectTrack,
  },
  component: GlobalTrackComponent,
});
