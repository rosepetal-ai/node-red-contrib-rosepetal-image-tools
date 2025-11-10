# Block Detect Node

## Purpose & Use Cases

The `block-detect` node gives you a lightweight watchdog that keeps an eye on Node-RED's event loop. When long running synchronous work or runaway CPU usage blocks the event loop, flows become sluggish, timers fire late, and HTTP endpoints stall. Dropping this node anywhere in your workspace makes it easy to detect those situations without wiring any messages.

**Typical scenarios**

- **Production health checks** &mdash; raise a warning in the runtime log when flows or custom code keep the event loop busy for too long.
- **Profiling new nodes** &mdash; temporarily add the node next to experimental flows to confirm they remain non-blocking.
- **Shared environments** &mdash; monitor collaborative / multi-tenant Node-RED instances for noisy neighbours that block everyone else.

## How It Works

- The node samples the Node.js [`monitorEventLoopDelay`](https://nodejs.org/api/perf_hooks.html#perf_hooks_monitor_event_loop_delay_options) histogram every *N* milliseconds (default one second).
- When the measured delay exceeds the configured threshold for a number of consecutive samples, the node writes an alert to the runtime log (`warn`, `error`, or plain `log`) and changes its editor status to red.
- If `monitorEventLoopDelay` is unavailable (very old Node.js builds), it falls back to measuring timer drift, which still provides a useful signal with minimal CPU overhead.
- A cooldown timer prevents log flooding when the system stays blocked for longer periods.

## Configuration

| Option | Description |
|--------|-------------|
| **Threshold (ms)** | Maximum acceptable event loop delay. Samples above this value count as "blocking". Default: `120 ms`. |
| **Sample interval (ms)** | How often to collect a measurement. Smaller values react faster but use slightly more CPU. Default: `1000 ms`. |
| **Consecutive hits** | Number of back-to-back samples that must exceed the threshold before an alert fires. Helps filter out one-off spikes. Default: `1`. |
| **Cooldown (ms)** | Minimum time between alerts so your logs do not get spammed while a problem persists. Default: `30,000 ms`. |
| **Show live delay metrics** | When enabled (default) the node's status displays the latest average and max delay so you can watch it in real time. |

The node has no inputs or outputs and can sit anywhere in your flow.

> The watchdog internally samples `monitorEventLoopDelay` with a medium (20&nbsp;ms) resolution, which provides enough fidelity for alerts while keeping CPU overhead negligible.

Alerts are always emitted with `node.warn(...)` so they appear in the standard Node-RED log without additional configuration.

## Interpreting the Status

- **Green dot** &mdash; Event loop delay is within the safe range.
- **Yellow ring** &mdash; Recent samples exceeded the threshold but not enough to trigger an alert yet.
- **Red dot** &mdash; Blocking detected. Check the runtime log for details about the max/avg delay.

## Tips

- Run multiple watchdogs with different thresholds (for example *warn at 120&nbsp;ms*, *error at 500&nbsp;ms*) if you want layered alerting.
- Pair the node with system level monitoring (CPU, memory) to quickly confirm whether the blocking originated from Node-RED or external processes.
- Because the watchdog is passive and does not emit messages, it is safe to leave it deployed permanently even in large workspaces.
