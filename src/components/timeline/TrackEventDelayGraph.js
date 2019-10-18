/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import * as React from 'react';
import { withSize } from '../shared/WithSize';
import explicitConnect from '../../utils/connect';
import { formatMilliseconds } from '../../utils/format-numbers';
import { getCommittedRange, getProfileInterval } from '../../selectors/profile';
import { getThreadSelectors } from '../../selectors/per-thread';
import { ORANGE_50 } from 'photon-colors';
import Tooltip from '../tooltip/Tooltip';
import EmptyThreadIndicator from './EmptyThreadIndicator';
import bisection from 'bisection';

import type { Thread, ThreadIndex } from '../../types/profile';
import type { Milliseconds, CssPixels, StartEndRange } from '../../types/units';
import type { SizeProps } from '../shared/WithSize';
import type { ConnectedProps } from '../../utils/connect';

import './TrackMemory.css';

/**
 * When adding properties to these props, please consider the comment above the component.
 */
type CanvasProps = {|
  +rangeStart: Milliseconds,
  +rangeEnd: Milliseconds,
  +interval: Milliseconds,
  +width: CssPixels,
  +height: CssPixels,
  +lineWidth: CssPixels,
  +eventDelays: Object,
|};

/**
 * This component controls the rendering of the canvas. Every render call through
 * React triggers a new canvas render. Because of this, it's important to only pass
 * in the props that are needed for the canvas draw call.
 */
class TrackEventDelayCanvas extends React.PureComponent<CanvasProps> {
  _canvas: null | HTMLCanvasElement = null;
  _requestedAnimationFrame: boolean = false;

  drawCanvas(canvas: HTMLCanvasElement): void {
    const {
      rangeStart,
      rangeEnd,
      height,
      width,
      lineWidth,
      interval,
      eventDelays,
    } = this.props;
    if (width === 0) {
      // This is attempting to draw before the canvas was laid out.
      return;
    }

    const ctx = canvas.getContext('2d');
    const devicePixelRatio = window.devicePixelRatio;
    const deviceWidth = width * devicePixelRatio;
    const deviceHeight = height * devicePixelRatio;
    const deviceLineWidth = lineWidth * devicePixelRatio;
    const deviceLineHalfWidth = deviceLineWidth * 0.5;
    const innerDeviceHeight = deviceHeight - deviceLineWidth;

    // Resize and clear the canvas.
    canvas.width = Math.round(deviceWidth);
    canvas.height = Math.round(deviceHeight);
    ctx.clearRect(0, 0, deviceWidth, deviceHeight);

    const { delays, delayRange, minTime } = eventDelays;

    if (delays.length === 0) {
      // There's no reason to draw the samples, there are none.
      return;
    }

    {
      // Draw the chart.
      const rangeLength = rangeEnd - rangeStart;
      ctx.lineWidth = deviceLineWidth;
      ctx.strokeStyle = ORANGE_50;
      ctx.fillStyle = '#ff940088'; // Orange 50 with transparency.
      ctx.beginPath();

      // The x and y are used after the loop.
      let x = 0;
      let y = 0;
      for (const [time, delay] of delays) {
        // Create a path for the top of the chart. This is the line that will have
        // a stroke applied to it.
        x = (deviceWidth * (time - rangeStart)) / rangeLength;
        // Add on half the stroke's line width so that it won't be cut off the edge
        // of the graph.
        // FIXME: what to do when there is no event delay data? Currently defaulted to 0.
        const unitGraphCount = (delay || 0) / delayRange;
        y =
          innerDeviceHeight -
          innerDeviceHeight * unitGraphCount +
          deviceLineHalfWidth;
        if (time === 0) {
          // This is the first iteration, only move the line.
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      // The samples range ends at the time of the last sample, plus the interval.
      // Draw this last bit.
      ctx.lineTo(x + interval, y);

      // Don't do the fill yet, just stroke the top line.
      ctx.stroke();

      // After doing the stroke, continue the path to complete the fill to the bottom
      // of the canvas.
      ctx.lineTo(x + interval, deviceHeight);
      ctx.lineTo(
        (deviceWidth * (minTime - rangeStart)) / rangeLength + interval,
        deviceHeight
      );
      ctx.fill();
    }
  }

  _scheduleDraw() {
    if (!this._requestedAnimationFrame) {
      this._requestedAnimationFrame = true;
      window.requestAnimationFrame(() => {
        this._requestedAnimationFrame = false;
        const canvas = this._canvas;
        if (canvas) {
          this.drawCanvas(canvas);
        }
      });
    }
  }

  _takeCanvasRef = (canvas: HTMLCanvasElement | null) => {
    this._canvas = canvas;
  };

  render() {
    this._scheduleDraw();

    return (
      <canvas className="timelineTrackMemoryCanvas" ref={this._takeCanvasRef} />
    );
  }
}

type OwnProps = {|
  +threadIndex: ThreadIndex,
  +lineWidth: CssPixels,
  +graphHeight: CssPixels,
|};

type StateProps = {|
  +threadIndex: ThreadIndex,
  +rangeStart: Milliseconds,
  +rangeEnd: Milliseconds,
  +interval: Milliseconds,
  +filteredThread: Thread,
  +unfilteredSamplesRange: StartEndRange | null,
  +eventDelays: Object,
|};

type DispatchProps = {||};

type Props = {|
  ...SizeProps,
  ...ConnectedProps<OwnProps, StateProps, DispatchProps>,
|};

type State = {|
  hoveredDelay: null | number,
  mouseX: CssPixels,
  mouseY: CssPixels,
|};

/**
 *
 */
class TrackEventDelayGraphImpl extends React.PureComponent<Props, State> {
  state = {
    hoveredDelay: null,
    mouseX: 0,
    mouseY: 0,
  };

  _onMouseLeave = () => {
    this.setState({ hoveredDelay: null });
  };

  _onMouseMove = (event: SyntheticMouseEvent<HTMLDivElement>) => {
    const { pageX: mouseX, pageY: mouseY } = event;
    // Get the offset from here, and apply it to the time lookup.
    const { left } = event.currentTarget.getBoundingClientRect();
    const { width, rangeStart, rangeEnd, interval, eventDelays } = this.props;
    const rangeLength = rangeEnd - rangeStart;
    const timeAtMouse = rangeStart + ((mouseX - left) / width) * rangeLength;
    const { delays, minTime } = eventDelays;
    const lastKey = delays.keys()[delays.length - 1];
    if (timeAtMouse < minTime || timeAtMouse > delays[lastKey] + interval) {
      // We are outside the range of the samples, do not display hover information.
      this.setState({ hoveredDelay: null });
    } else {
      const delayTimes = delays.map(d => d[0]);
      let hoveredDelay = bisection.right(delayTimes, timeAtMouse);
      if (hoveredDelay === delayTimes.length) {
        // When hovering the last sample, it's possible the mouse is past the time.
        // In this case, hover over the last sample. This happens because of the
        // ` + interval` line in the `if` condition above.
        hoveredDelay = delays.length - 1;
      }

      this.setState({
        mouseX,
        mouseY,
        hoveredDelay,
      });
    }
  };

  _renderTooltip(delayIndex: number): React.Node {
    const { delays, delayRange } = this.props.eventDelays;
    return (
      <div className="timelineTrackMemoryTooltip">
        <div className="timelineTrackMemoryTooltipLine">
          <span className="timelineTrackMemoryTooltipNumber">
            {formatMilliseconds(delays[delayIndex][1])}
          </span>
          {' event delay'}
        </div>
        <div className="timelineTrackMemoryTooltipLine">
          <span className="timelineTrackMemoryTooltipNumber">
            {formatMilliseconds(delayRange)}
          </span>
          {' delay range in graph'}
        </div>
      </div>
    );
  }

  /**
   * Create a div that is a dot on top of the graph representing the current
   * height of the graph.
   */
  _renderMemoryDot(delayIndex: number): React.Node {
    const {
      rangeStart,
      rangeEnd,
      graphHeight,
      width,
      lineWidth,
      eventDelays,
    } = this.props;
    const { delayRange, delays } = eventDelays;
    const rangeLength = rangeEnd - rangeStart;
    const left = (width * (delays[delayIndex][0] - rangeStart)) / rangeLength;

    const unitSampleCount = (delays[delayIndex][1] || 0) / delayRange;
    const innerTrackHeight = graphHeight - lineWidth / 2;
    const top =
      innerTrackHeight - unitSampleCount * innerTrackHeight + lineWidth / 2;

    return (
      <div style={{ left, top }} className="timelineTrackMemoryGraphDot" />
    );
  }

  render() {
    const { hoveredDelay, mouseX, mouseY } = this.state;
    const {
      filteredThread,
      interval,
      rangeStart,
      rangeEnd,
      unfilteredSamplesRange,
      graphHeight,
      width,
      lineWidth,
      eventDelays,
    } = this.props;

    return (
      <div
        className="timelineTrackMemoryGraph"
        onMouseMove={this._onMouseMove}
        onMouseLeave={this._onMouseLeave}
      >
        <TrackEventDelayCanvas
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          height={graphHeight}
          width={width}
          lineWidth={lineWidth}
          interval={interval}
          eventDelays={eventDelays}
        />
        {hoveredDelay === null ? null : (
          <>
            {this._renderMemoryDot(hoveredDelay)}
            <Tooltip mouseX={mouseX} mouseY={mouseY}>
              {this._renderTooltip(hoveredDelay)}
            </Tooltip>
          </>
        )}
        <EmptyThreadIndicator
          thread={filteredThread}
          interval={interval}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          unfilteredSamplesRange={unfilteredSamplesRange}
        />
      </div>
    );
  }
}

export const TrackEventDelayGraph = explicitConnect<
  OwnProps,
  StateProps,
  DispatchProps
>({
  mapStateToProps: (state, ownProps) => {
    const { threadIndex } = ownProps;
    const { start, end } = getCommittedRange(state);
    const selectors = getThreadSelectors(threadIndex);
    return {
      threadIndex: threadIndex,
      rangeStart: start,
      rangeEnd: end,
      interval: getProfileInterval(state),
      filteredThread: selectors.getFilteredThread(state),
      unfilteredSamplesRange: selectors.unfilteredSamplesRange(state),
      eventDelays: selectors.getEventDelays(state),
    };
  },
  component: withSize<Props>(TrackEventDelayGraphImpl),
});
