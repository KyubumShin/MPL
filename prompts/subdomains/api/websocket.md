# Subdomain: API/WebSocket (WebSocket Real-Time Communication)

## Core Principles
- Explicitly handle all states in the connection lifecycle (open → message → error → close)
- Detect and clean up ghost connections with heartbeat (ping/pong)
- Apply exponential backoff + jitter strategy for client reconnection
- Serialize messages in an explicit structure that includes a type field (e.g., `{ type, payload, id }`)

## Cautions
- Account for memory/CPU cost proportional to connection count during broadcasts — isolate by room/channel
- Apply chunking or compression (permessage-deflate) for large messages
- Missing backpressure handling can cause buffer overflow and connection drops
- Validate auth tokens during the handshake at connection time — re-validation per message is unnecessary, but expiry handling is required

## Verification Points
- Do clients automatically reconnect after a server restart?
- Are connections without ping responses terminated within the configured timeout?
- Are messages in the same room delivered only to the relevant subscribers?
- Are server-side resources (event listeners, DB cursors, etc.) cleaned up on disconnect?
