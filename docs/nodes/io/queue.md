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

Messages that exceed the configured timeout are silently discarded with a warning in the node's log.

## Configuration Options

### Max Queue Size
- **Type**: Number (integer)
- **Default**: `0` (no limit)
- **Purpose**: Maximum number of messages that can be held. Additional messages are ignored once the queue is full.

### Interval (ms)
- **Type**: Number (integer)
- **Default**: `0` (no enforced delay)
- **Purpose**: Minimum time that must elapse between forwarded messages. If more time has already passed when a message arrives, it is sent immediately.

### Timeout (ms)
- **Type**: Number (integer)
- **Default**: `0` (no timeout)
- **Purpose**: Maximum time a message may remain in the queue. Messages that sit longer are dropped to keep data fresh.

## Behavior & Status

- Messages are processed in first-in-first-out order.
- The node emits messages immediately when the interval requirement has already been satisfied.
- If necessary, the node waits the remaining interval before releasing the next message.
- When messages expire due to timeout they are removed from the queue and a warning is logged.
- Node status indicates whether the queue is idle, holding messages, or actively sending.

## Best Practices

- Pair with Array nodes to control the rate of batch processing pipelines.
- Use timeouts to keep sensor readings or camera frames current.
- Combine with Catch or Status nodes to monitor when the queue reaches capacity or drops messages.

