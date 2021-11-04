/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import * as React from 'react';
import classNames from 'classnames';
import { IdleSearchField } from './IdleSearchField';

import './TrackSearch.css';

type Props = {|
  +className: string,
  +title: string,
  +currentSearchString: string,
  +onSearch: (string) => void,
|};

type State = {||};

export class TrackSearch extends React.PureComponent<Props, State> {
  _onSearchFieldIdleAfterChange = (value: string) => {
    this.props.onSearch(value);
  };

  render() {
    const { title, currentSearchString, className } = this.props;
    return (
      <div className={classNames('trackSearchField', className)}>
        <IdleSearchField
          className="trackSearchFieldInput"
          title={title}
          idlePeriod={200}
          defaultValue={currentSearchString}
          onIdleAfterChange={this._onSearchFieldIdleAfterChange}
          autoComplete="off"
        />
      </div>
    );
  }
}
