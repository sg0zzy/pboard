/**
 * Live Debug Bridge instrumentation SDK — public surface.
 *
 * Production posture: everything here is inert unless (a) the bundle was
 * built with `VITE_PBOARD_DIAGNOSTICS=1`, or (b) a development build, and
 * (c) the per-profile setting enables the bridge channel (`configureDebug`).
 * `emit` with the bus disabled costs one boolean test.
 */

export { DEBUG_SCHEMA_VERSION, DEBUG_COMPONENTS, DEBUG_SEVERITIES, DEBUG_EVENTS, DEBUG_LIMITS, CARD_OPERATION_TRACE_STAGES } from "./schema.ts";
export type { DebugComponent, DebugSeverity, DebugEvent, DebugEventInput, DebugEventFilter, ValidationResult, TraceView, TraceStage } from "./schema.ts";
export { validateDebugEvent, eventMatchesFilter, isValidEventName, approxEventBytes } from "./schema.ts";
export { emit, configureDebugBus, resetDebugBus, debugBusEnabled, debugDropReport, flushDebugBus, pendingEventCount } from "./bus.ts";
export type { DebugTransport, DebugBusOptions, DebugIdentity, DebugDropReport } from "./bus.ts";
export { resolveClientId, resolveSessionId, newDebugId } from "./ids.ts";
export { HttpBridgeTransport, isSafeBridgeEndpoint, DEFAULT_BRIDGE_URL, BRIDGE_PROTOCOL_VERSION } from "./bridgeTransport.ts";
export type { BridgeTransportOptions, PendingInspection } from "./bridgeTransport.ts";
export { configureDebugForContext, debugBridgeSettingsKey, readDebugBridgeSettings } from "./browser.ts";
export type { DebugContext, DebugBridgeSettings, DebugRuntimeHandle } from "./browser.ts";
export { ConnectionRegistry, registryFromEvents } from "./connectionRegistry.ts";
export type { ConnectionEntry, ConnectionState, ConnectionFinding } from "./connectionRegistry.ts";
export { BRIDGE_DEFAULT_PORT, BRIDGE_DEFAULT_HOST, parseEventFilter } from "./protocol.ts";
export type {
  IngestEnvelope, IngestResponse, StoredDebugEvent, BridgeClientInfo, BridgeMode,
  BridgeStatus, EventQuery, EventQueryResult, TraceCaptureFile, ClientStateSnapshot, BoardStateEntry,
} from "./protocol.ts";
export { buildTraceView, correlateTraces } from "./trace.ts";
export type { TraceIndex } from "./trace.ts";
export { registerDebugSnapshotProvider, attachDebugInspector } from "./inspect.ts";
export { collectDebugSnapshot } from "./stateSnapshot.ts";
export type { SnapshotSources, RoomView } from "./stateSnapshot.ts";
export { registerDebugStateInspection, roomViewSource } from "./stateInspection.ts";
