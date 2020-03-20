/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import * as React from 'react';
import ActiveTabGlobalTrack from './ActiveTabGlobalTrack';
import TimelineRuler from './Ruler';
import TimelineSelection from './Selection';
import OverflowEdgeIndicator from './OverflowEdgeIndicator';
import Reorderable from '../shared/Reorderable';
import { withSize } from '../shared/WithSize';
import explicitConnect from '../../utils/connect';
import { getPanelLayoutGeneration } from '../../selectors/app';
import {
  getCommittedRange,
  getZeroAt,
  getActiveTabGlobalTracks,
  getActiveTabGlobalTrackReferences,
} from '../../selectors/profile';

import './index.css';

import type { SizeProps } from '../shared/WithSize';
import type { BrowsingContextID } from '../../types/profile';
import type {
  TrackIndex,
  GlobalTrack,
  InitialSelectedTrackReference,
} from '../../types/profile-derived';
import type { GlobalTrackReference } from '../../types/actions';
import type { Milliseconds, StartEndRange } from '../../types/units';
import type { ConnectedProps } from '../../utils/connect';

type OwnProps = {|
  +showTabOnly: BrowsingContextID,
|};

type StateProps = {|
  +committedRange: StartEndRange,
  +globalTracks: GlobalTrack[],
  +globalTrackReferences: GlobalTrackReference[],
  +panelLayoutGeneration: number,
  +zeroAt: Milliseconds,
|};

type Props = {|
  ...SizeProps,
  ...ConnectedProps<OwnProps, StateProps, {||}>,
|};

type State = {|
  initialSelected: InitialSelectedTrackReference | null,
|};

class Timeline extends React.PureComponent<Props, State> {
  state = {
    initialSelected: null,
  };

  /**
   * This method collects the initially selected track's HTMLElement. This allows the timeline
   * to scroll the initially selected track into view once the page is loaded.
   */
  setInitialSelected = (el: InitialSelectedTrackReference) => {
    this.setState({ initialSelected: el });
  };

  render() {
    const {
      globalTracks,
      committedRange,
      zeroAt,
      width,
      globalTrackReferences,
      panelLayoutGeneration,
    } = this.props;

    return (
      <>
        <TimelineSelection
          width={width}
          style={{
            '--thread-label-column-width': `0px`,
          }}
        >
          <TimelineRuler
            zeroAt={zeroAt}
            rangeStart={committedRange.start}
            rangeEnd={committedRange.end}
            width={width}
          />
          <OverflowEdgeIndicator
            className="timelineOverflowEdgeIndicator"
            panelLayoutGeneration={panelLayoutGeneration}
            initialSelected={this.state.initialSelected}
          >
            {globalTracks.map((globalTrack, trackIndex) => (
              <ActiveTabGlobalTrack
                key={trackIndex}
                trackIndex={trackIndex}
                trackReference={globalTrackReferences[trackIndex]}
                setInitialSelected={this.setInitialSelected}
              />
            ))}
          </OverflowEdgeIndicator>
        </TimelineSelection>
      </>
    );
  }
}

export default explicitConnect<OwnProps, StateProps, {||}>({
  mapStateToProps: state => ({
    globalTracks: getActiveTabGlobalTracks(state),
    globalTrackReferences: getActiveTabGlobalTrackReferences(state),
    committedRange: getCommittedRange(state),
    zeroAt: getZeroAt(state),
    panelLayoutGeneration: getPanelLayoutGeneration(state),
  }),
  component: withSize<Props>(Timeline),
});
