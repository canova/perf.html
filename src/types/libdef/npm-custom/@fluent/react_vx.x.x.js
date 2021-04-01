/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow

import * as React from 'react';

declare module '@fluent/react/esm/with_localization' {
  declare type WithLocalizationProps = $ReadOnly<{|
    getString: (string, mixed) => string,
  |}>;

  declare module.exports: <Props: $ReadOnly<{ ...WithLocalizationProps }>>(
    Wrapped: React.ComponentType<Props>
  ) => $ReadOnly<$Diff<Props, WithLocalizationProps>>;
}
