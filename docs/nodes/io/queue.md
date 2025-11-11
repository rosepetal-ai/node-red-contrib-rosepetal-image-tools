# Queue Node

## Purpose & Use Cases

The `queue` node buffers incoming messages, enforces a minimum interval between outputs, and discards stale entries. It helps coordinate bursty producers with slower consumers by smoothing throughput and avoiding overload.

**Common Scenarios:**
- Throttle high-frequency image sources before storage or slow analysis stages
- Prevent downstream rate limits from being exceeded when batch processing arrays
- Provide simple back-pressure where only a fixed number of messages can be buffered
- Drop stale detections or frames that are no longer relevant after a timeout

## Input/Output Specification

### Inputs
- **Incoming Message**: Any Node-RED message to be enqueued.

### Outputs
- **Queued Message**: Messages are forwarded in FIFO order while respecting the configured interval.

When timeout mode is selected, messages that exceed the configured timeout are silently discarded with a warning in the node's log.

## Configuration Options

### Mode
- **Type**: Dropdown (`Queue Size Limit` / `Timeout`)
- **Default**: `Queue Size Limit`
- **Purpose**: Select whether the node enforces a hard buffer capacity or lets messages expire after a timeout; the controls shown below change depending on the selected mode.

### Queue Size Limit
- **Type**: Number (integer)
- **Default**: `0` (no limit)
- **Purpose**: Available only in queue-size mode. Controls how many messages may be enqueued before excess messages are ignored.

### Timeout (ms)
- **Type**: Number (integer)
- **Default**: `0` (no timeout)
- **Purpose**: Available only in timeout mode. Messages that stay longer than this duration are removed before they reach the output.

### Interval (ms)
- **Type**: Number (integer)
- **Default**: `0` (no enforced delay)
- **Purpose**: Minimum time that must elapse between forwarded messages. When set to 0, messages flow out as soon as they are available.

## Behavior & Status

- Messages are processed in first-in-first-out order.
- The node emits messages immediately when the interval requirement has already been satisfied.
- If necessary, the node waits the remaining interval before releasing the next message.
- When messages expire due to timeout (and timeout mode is active) they are removed from the queue and a warning is logged.
- Node status indicates whether the queue is idle, holding messages, or actively sending.

## Best Practices

- Pair with Array nodes to control the rate of batch processing pipelines.
- Use timeouts to keep sensor readings or camera frames current.
- Combine with Catch or Status nodes to monitor when the queue reaches capacity or drops messages.
