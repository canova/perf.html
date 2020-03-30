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
import { assertExhaustiveCheck } from '../../utils/flow';
import {
  getSelectedThreadIndex,
  getSelectedTab,
} from '../../selectors/url-state';
import explicitConnect from '../../utils/connect';
import { getActiveTabResourceTrackName } from '../../selectors/profile';
import TrackThread from './TrackThread';
import type { TrackReference } from '../../types/actions';
import type { TrackIndex, LocalTrack } from '../../types/profile-derived';
import type { ConnectedProps } from '../../utils/connect';

type OwnProps = {|
  +localTrack: LocalTrack,
  +trackIndex: TrackIndex,
  +style?: Object /* This is used by Reorderable */,
  +setIsInitialSelectedPane: (value: boolean) => void,
|};

type StateProps = {|
  +trackName: string,
  +isSelected: boolean,
|};

type DispatchProps = {|
  +changeRightClickedTrack: typeof changeRightClickedTrack,
  +selectTrack: typeof selectTrack,
|};

type Props = ConnectedProps<OwnProps, StateProps, DispatchProps>;

class LocalTrackComponent extends PureComponent<Props> {
  _onLabelMouseDown = (event: MouseEvent) => {
    if (event.button === 0) {
      // Don't allow clicks on the threads list to steal focus from the tree view.
      event.preventDefault();
      this._onLineClick();
    } else if (event.button === 2) {
      // This is needed to allow the context menu to know what was right clicked without
      // actually changing the current selection.
      this.props.changeRightClickedTrack(this._getTrackReference());
    }
  };

  _getTrackReference(): TrackReference {
    const { trackIndex } = this.props;
    return { type: 'resource', trackIndex };
  }

  _onLineClick = () => {
    this.props.selectTrack(this._getTrackReference());
  };

  renderTrack() {
    const { localTrack, isSelected } = this.props;
    switch (localTrack.type) {
      case 'thread':
        return (
          <TrackThread
            threadIndex={localTrack.threadIndex}
            trackType={isSelected ? 'local' : 'resource'}
          />
        );
      case 'network':
      case 'memory':
      case 'ipc':
        throw new Error(
          'Local track type is not implemented for resource tracks'
        );
      default:
        console.error('Unhandled localTrack type', (localTrack: empty));
        return null;
    }
  }

  componentDidMount() {
    const { isSelected } = this.props;
    if (isSelected) {
      this.props.setIsInitialSelectedPane(true);
    }
  }

  render() {
    const { isSelected, trackName, style } = this.props;

    return (
      <li className="timelineTrack timelineTrackResource" style={style}>
        {/* This next div is used to mirror the structure of the TimelineGlobalTrack */}
        <div
          className={classNames('timelineTrackRow timelineTrackResourceRow', {
            selected: isSelected,
          })}
          onClick={this._onLineClick}
        >
          <div className="timelineTrackResourceLabel">
            <span>Frame:</span> {trackName}
          </div>
          <div className="timelineTrackTrack">{this.renderTrack()}</div>
        </div>
      </li>
    );
  }
}

export default explicitConnect<OwnProps, StateProps, DispatchProps>({
  mapStateToProps: (state, { localTrack, trackIndex }) => {
    // These get assigned based on the track type.
    let isSelected = false;

    // Run different selectors based on the track type.
    switch (localTrack.type) {
      case 'thread': {
        // Look up the thread information for the process if it exists.
        const threadIndex = localTrack.threadIndex;
        const selectedThreadIndex = getSelectedThreadIndex(state);
        const selectedTab = getSelectedTab(state);
        isSelected =
          threadIndex === selectedThreadIndex &&
          selectedTab !== 'network-chart';
        break;
      }
      case 'network':
      case 'memory':
      case 'ipc': {
        throw new Error(
          'Local track type is not implemented for resource tracks'
        );
      }
      default:
        throw assertExhaustiveCheck(localTrack, `Unhandled LocalTrack type.`);
    }

    return {
      trackName: getActiveTabResourceTrackName(state, trackIndex),
      isSelected,
    };
  },
  mapDispatchToProps: {
    changeRightClickedTrack,
    selectTrack,
  },
  component: LocalTrackComponent,
});
