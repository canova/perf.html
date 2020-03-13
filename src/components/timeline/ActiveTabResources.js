/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import * as React from 'react';
import ActiveTabGlobalTrack from './ActiveTabGlobalTrack';
import TimelineSelection from './Selection';
import OverflowEdgeIndicator from './OverflowEdgeIndicator';
import Reorderable from '../shared/Reorderable';
import { withSize } from '../shared/WithSize';
import explicitConnect from '../../utils/connect';

import './ActiveTabResources.css';

import type { SizeProps } from '../shared/WithSize';

import { changeGlobalTrackOrder } from '../../actions/profile-view';

// import type {
//   InitialSelectedTrackReference,
// } from '../../types/profile-derived';
import type { ConnectedProps } from '../../utils/connect';

type OwnProps = {||};

type StateProps = {||};

type DispatchProps = {||};

type Props = {|
  ...SizeProps,
  ...ConnectedProps<OwnProps, StateProps, DispatchProps>,
|};

type State = {|
  // initialSelected: InitialSelectedTrackReference | null,
|};

class Resources extends React.PureComponent<Props, State> {
  // state = {
  //   initialSelected: null,
  // };

  /**
   * This method collects the initially selected track's HTMLElement. This allows the timeline
   * to scroll the initially selected track into view once the page is loaded.
   */
  // setInitialSelected = (el: InitialSelectedTrackReference) => {
  //   this.setState({ initialSelected: el });
  // };

  render() {
    return <></>;
  }
}

export default explicitConnect<OwnProps, StateProps, DispatchProps>({
  // mapStateToProps: state => ({}),
  // mapDispatchToProps: {},
  component: withSize<Props>(Resources),
});
