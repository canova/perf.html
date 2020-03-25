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

import type { LocalTrack } from '../../types/profile-derived';
import type { ConnectedProps } from '../../utils/connect';

type OwnProps = {|
  +resourceTracks: LocalTrack[],
  +setIsInitialSelectedPane: (value: boolean) => void,
|};

type StateProps = {||};

type DispatchProps = {||};

type Props = {|
  ...SizeProps,
  ...ConnectedProps<OwnProps, StateProps, DispatchProps>,
|};

type State = {|
  // initialSelected: InitialSelectedTrackReference | null,
  isOpen: boolean,
|};

class Resources extends React.PureComponent<Props, State> {
  state = {
    // initialSelected: null,
    isOpen: false,
  };

  _togglePanel = () => {
    this.setState(prevState => {
      return { isOpen: !prevState.isOpen };
    });
  };

  render() {
    const { resourceTracks, setIsInitialSelectedPane } = this.props;
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
                localTrack={localTrack}
                trackIndex={trackIndex}
                setIsInitialSelectedPane={setIsInitialSelectedPane}
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
