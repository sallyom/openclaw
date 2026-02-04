# MLflow Instrumentation Summary

## Overview

We added comprehensive MLflow observability to OpenClaw to track:
- **Traces** - Full request/response lifecycles with Session/User grouping
- **Spans** - LLM calls, tool usage, and agent lifecycle events
- **Metrics** - Token usage, costs, latency
- **Prompts** - User inputs for agent evaluation

## What We Instrumented

### 1. Core Diagnostic Events (`src/infra/diagnostic-events.ts`)
**Added:** `prompt` field to `DiagnosticUsageEvent`
- **Why:** Capture user messages for MLflow Prompt column (needed for agent evals)
- **Where:** Line 17 - Added optional `prompt?: string` field
- **Impact:** No breaking changes, purely additive

### 2. Agent Runner (`src/auto-reply/reply/agent-runner.ts`)
**Added:** Prompt data to diagnostic event emission
- **Why:** Pass user's message from `followupRun.prompt` to observability layer
- **Where:** Line 449 - Added `prompt: followupRun.prompt` to `emitDiagnosticEvent`
- **Flow:** User message → FollowupRun → DiagnosticEvent → MLflow trace inputs

### 3. Plugin Loader (`src/plugins/loader.ts`)
**Added:** Native `require()` for pre-built plugins (dual package hazard fix)
- **Why:** Prevent jiti-loaded plugins from getting separate module instances
- **Where:** Lines 298-313 - Check for `dist/index.js`, use native require() instead of jiti
- **Impact:** Critical for diagnostic event listeners to work correctly
- **Evidence:** Before fix: `listeners=0`, After fix: `listeners=1`

### 4. MLflow Plugin (`extensions/diagnostics-mlflow/`)

#### Files Created:
- `index.ts` - Plugin entry point
- `src/service.ts` - Main instrumentation logic
- `tsconfig.json` - Build configuration
- `openclaw.plugin.json` - Plugin manifest

#### Key Features Implemented:

**A. Trace Lifecycle Management**
```
message.queued → Create root span
model.usage   → Create LLM child span (with prompt!)
message.processed → End span, flush, set tags
```

**B. Session/User Grouping**
- Initially tried: `updateCurrentTrace()` with tags/metadata
- **Problem:** Only sets span attributes, not trace-level tags
- **Solution:** REST API calls to `PATCH /api/2.0/mlflow/traces/{trace_id}/tags`
- Sets: `mlflow.trace.session` and `mlflow.trace.user` tags
- **Why these specific keys:** MLflow UI Session/User columns specifically look for these trace-level tags

**C. Prompt Capture**
- Added to LLM span inputs: `{ prompt: evt.prompt }`
- Displays in MLflow UI "Prompt" column
- Critical for agent evaluation workflows

**D. Deduplication**
- Added `tagsSet` flag to prevent duplicate tag-setting
- Gracefully ignores duplicate key errors (HTTP 400)

### 5. Docker Build (`Dockerfile`)
**Added:** Extension build step
- **Why:** Pre-compile plugins for K8s/OpenShift deployment
- **Where:** Lines 33-40 - Build all extensions with `pnpm build`
- **Impact:** Avoids dual package hazard in production
- **Flow:** Docker build → `pnpm build` → dist/index.js → native require()

## Architecture Decisions

### Why Event-Driven vs Direct Instrumentation?
OpenClaw is a **multi-tenant messaging gateway**, not a simple agent script:
- Handles multiple concurrent sessions across different channels
- Async message queuing with non-deterministic timing
- Plugin system with module boundaries
- No automatic context propagation

**Direct instrumentation (autologger)** would require:
- Wrapping every LLM call site
- Thread-local storage (doesn't work across async boundaries)
- Tight coupling to agent internals

**Event-driven approach** allows:
- ✅ Separation of concerns (observability is a plugin)
- ✅ No coupling to agent implementation
- ✅ Support for multiple concurrent sessions
- ✅ Works across async/queue boundaries
- ✅ Can be disabled without code changes

### Why REST API Calls for Tags?
TypeScript SDK `updateCurrentTrace()` limitations:
- ❌ Only sets **span attributes** (visible in Attributes tab)
- ❌ Does NOT set **trace-level tags** (Session/User columns empty)

MLflow UI Session/User columns specifically require **trace-level tags**:
- Must use PATCH `/api/2.0/mlflow/traces/{trace_id}/tags`
- Confirmed via MLflow protos (service.proto)
- Python autologger does this automatically, TypeScript SDK v0.1.2 doesn't

## Key Challenges Solved

### 1. Dual Package Hazard
**Problem:** Jiti-loaded plugin got separate `diagnostic-events` module instance
- Plugin subscribed: `listeners.add()` → Set A
- Core emitted: `listeners` → Set B (empty!)
- Events never reached plugin

**Solution:** Use native `require()` for pre-built `dist/index.js`
- Same module graph as gateway
- Single Set instance shared between core and plugin

**Evidence:**
```
Before: [diagnostic-events] EMIT type=model.usage listeners=0
After:  [diagnostic-events] EMIT type=model.usage listeners=1
```

### 2. Trace Tag Persistence
**Problem:** Tags visible in span attributes but not in Session/User columns

**Root Cause:** `updateCurrentTrace({ tags: {...} })` doesn't create trace-level tags

**Solution:** REST API PATCH calls after flush
```typescript
await flushTracesIfNeeded(); // Persist trace to database first
await client.patch(`/api/2.0/mlflow/traces/${traceId}/tags`, {
  key: "mlflow.trace.session",
  value: sessionKey
});
```

### 3. Duplicate Tag Errors
**Problem:** Two `message.processed` events per trace → duplicate PATCH calls

**Solution:**
- Add `tagsSet` flag to ActiveTrace
- Only call PATCH if `!trace.tagsSet`
- Gracefully ignore 400 duplicate key errors

## Current State

### What Works ✅
- Traces appear in MLflow UI
- Prompt data captured in LLM span inputs
- Session/User tags set via REST API (pending final deployment)
- Cost, latency, token usage metrics tracked
- Duplicate handling implemented

### What's Pending ⏳
- Final deployment with REST API tag-setting fix
- Verification that Session/User columns populate
- Removal of debug console.log statements

### Known Limitations ⚠️
- TypeScript SDK v0.1.2 lacks Python autologger features
- Must manually set trace-level tags via REST API
- Two REST API calls per trace (session + user tags)
- Requires pre-built plugins (`dist/index.js`) in production

## Files Modified

### Core OpenClaw
1. `src/infra/diagnostic-events.ts` - Added prompt field
2. `src/auto-reply/reply/agent-runner.ts` - Emit prompt in usage events
3. `src/plugins/loader.ts` - Native require() for pre-built plugins
4. `Dockerfile` - Build extensions at image build time

### MLflow Extension
1. `extensions/diagnostics-mlflow/index.ts` - Plugin entry point
2. `extensions/diagnostics-mlflow/src/service.ts` - Main instrumentation
3. `extensions/diagnostics-mlflow/tsconfig.json` - Build config
4. `extensions/diagnostics-mlflow/openclaw.plugin.json` - Manifest

### Documentation
1. `docs/observability/instrumentation-complexity.md` - Why it's complex
2. `docs/observability/mlflow-instrumentation-summary.md` - This document

## Debug Logging to Clean Up

The following debug logs should be removed or converted to proper logger calls once verified working:

1. **`src/infra/diagnostic-events.ts`**
   - Line 164: `console.log('[diagnostic-events] EMIT ...')`
   - Line 175: `console.log('[diagnostic-events] SUBSCRIBE ...')`

2. **`src/plugins/loader.ts`**
   - Line 303: `console.log('[plugins] ... using pre-built ...')`
   - Line 309-311: `console.log('[plugins] ... dist/index.js not found ...')`

3. **`extensions/diagnostics-mlflow/src/service.ts`**
   - Line 288: `console.log('[MLflow] ABOUT TO SUBSCRIBE ...')`
   - Line 293: `console.log('[MLflow] Diagnostic event received ...')`
   - Line 580: `console.log('[MLflow] SUCCESSFULLY SUBSCRIBED ...')`

These were added during debugging the dual package hazard and should be removed once Session/User columns are confirmed working.

## Next Steps

1. **Deploy latest code** with REST API tag-setting
2. **Verify in MLflow UI:**
   - Session column populated
   - User column populated
   - Prompt column showing messages
   - Tag filters work
3. **Clean up debug logging** (remove console.log statements)
4. **Performance testing** - Measure overhead of REST API calls
5. **Consider** - Batching multiple tag updates in single API call if performance is an issue

---

*Last updated: 2026-02-04*
*MLflow TypeScript SDK version: 0.1.2*
*OpenClaw version: 2026.2.1*
