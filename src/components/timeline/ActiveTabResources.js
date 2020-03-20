/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import * as React from 'react';
import classNames from 'classnames';
// import TimelineSelection from './Selection';
import explicitConnect from '../../utils/connect';
import ActiveTabResourceTrack from './ActiveTabResourceTrack';
import { withSize } from '../shared/WithSize';

import './ActiveTabResources.css';

import type { SizeProps } from '../shared/WithSize';

// import type {
//   InitialSelectedTrackReference,
// } from '../../types/profile-derived';
import type { ConnectedProps } from '../../utils/connect';

type OwnProps = {|
  +resourceTracks: LocalTracks[],
|};

type StateProps = {||};

type DispatchProps = {||};

type Props = {|
  ...SizeProps,
  ...ConnectedProps<OwnProps, StateProps, DispatchProps>,
|};

type State = {|
  // initialSelected: InitialSelectedTrackReference | null,
  isOpen: Boolean,
|};

class Resources extends React.PureComponent<Props, State> {
  state = {
    // initialSelected: null,
    isOpen: false,
  };

  /**
   * This method collects the initially selected track's HTMLElement. This allows the timeline
   * to scroll the initially selected track into view once the page is loaded.
   */
  // setInitialSelected = (el: InitialSelectedTrackReference) => {
  //   this.setState({ initialSelected: el });
  // };

  _togglePanel = () => {
    this.setState({ isOpen: !this.state.isOpen });
  };

  render() {
    const { resourceTracks } = this.props;
    const { isOpen } = this.state;
    return (
      <div className="timelineResources">
        <div
          onClick={this._togglePanel}
          className={classNames('timelineResourcesHeader', {
            opened: isOpen,
          })}
        >
          Resources ({resourceTracks.length})
        </div>
        {this.state.isOpen ? (
          <ol className="timelineResourceTracks">
            {resourceTracks.map((localTrack, trackIndex) => (
              <ActiveTabResourceTrack
                key={trackIndex}
                pid={0} // fixme: remove
                localTrack={localTrack}
                trackIndex={trackIndex}
                setIsInitialSelectedPane={this.setIsInitialSelectedPane}
              />
            ))}
          </ol>
        ) : null}
      </div>
    );
  }
}

export default explicitConnect<OwnProps, StateProps, DispatchProps>({
  // mapStateToProps: state => ({}),
  // mapDispatchToProps: {},
  component: withSize<Props>(Resources),
});
