# CLAW-SPEC-0001: Claw Interoperability Core

Status: Draft

Author: working draft

Last updated: 2026-03-19

## 1. Problem

Multiple Claw implementations are appearing with overlapping goals:

- local and remote agent runtimes
- portable skills
- channel integrations
- plugins and extensions
- IDE and client bridges

These projects do not need identical internals, but the ecosystem benefits if:

- a skill can declare portable metadata once
- a host can load portable extension metadata
- a channel adapter can advertise supported behaviors
- a client or plugin can negotiate capabilities with a host

Without a shared contract, each runtime creates its own packaging, discovery, and transport conventions. That fragments the ecosystem and raises the cost of sharing tools, skills, extensions, and operational knowledge.

## 2. Scope

This draft defines a small family of interoperable contracts:

1. AgentSkills adoption profile for Claw hosts
2. Extension manifest metadata
3. Channel message and event envelope
4. Capability discovery document

This draft does not define:

- a replacement for AgentSkills
- internal runtime APIs
- prompt format
- model orchestration semantics
- session persistence format
- a universal security policy model

## 3. Design Principles

### 3.1 Portable artifacts first

The first interoperability target is portable metadata and event formats, not portable source-level SDKs.

### 3.2 Capability negotiation over forced parity

Implementations may support different features. They should advertise capabilities explicitly and degrade predictably.

### 3.3 Stable core, optional extensions

The core should be small enough that OpenClaw-style, ZeroClaw-style, and smaller embedded variants can realistically implement it.

### 3.4 Reuse existing standards

When possible:

- skill packaging should use AgentSkills-style `SKILL.md` as the canonical portable format
- editor/client interoperability should align with ACP where relevant
- tool interoperability should align with MCP where relevant

This spec should complement those standards, not replace them.

### 3.5 AgentSkills first

For skills, the preferred path is:

- adopt AgentSkills as-is where possible
- define a Claw adoption profile for fields and behaviors that need clearer interoperability
- use Claw-specific metadata only for additive host/runtime concerns

If a Claw host can consume a normal AgentSkills package without modification, that is preferred over any Claw-specific wrapper.

## 4. Core Terms

### 4.1 Host

A Claw runtime that loads skills, extensions, channel adapters, or client bridges.

### 4.2 Skill

A portable instruction package, usually centered on a `SKILL.md` file plus optional metadata and assets.

### 4.3 Extension

A package that adds runtime behavior such as:

- channels
- providers
- tools
- setup flows
- observability or policy hooks

### 4.4 Channel

A messaging transport integration that converts platform-native traffic into canonical Claw message events and can emit outbound actions.

### 4.5 Capability Document

A machine-readable declaration of supported protocol versions, feature flags, limits, and optional modules.

## 5. Artifact Model

### 5.1 Skill Package

A portable Claw-compatible skill package SHOULD first be a valid AgentSkills package centered on `SKILL.md`.

Claw-specific metadata, when used, MUST be additive and MUST NOT require replacing the AgentSkills package layout.

An optional Claw skill interop manifest MAY provide:

- `kind: "claw.skill"`
- `name`
- `version`
- `description`
- a `skillEntry`, normally `SKILL.md`
- `baseSkillFormat`, which SHOULD be `agentskills.v1`

The interop manifest MAY provide:

- compatibility information
- requirements for binaries, env vars, or host config
- optional assets
- optional declared tools or slash commands

Hosts SHOULD be able to derive this interop manifest from plain AgentSkills metadata when possible rather than requiring a separate file.

### 5.2 Extension Manifest

An extension manifest MUST provide:

- `kind: "claw.extension"`
- `id`
- `version`
- `extensionKind`
- one or more declared compatibility targets

An extension MAY provide:

- setup entrypoints
- runtime entrypoints
- config schema references
- permission hints
- channel metadata
- capabilities

### 5.3 Channel Envelope

All interoperable channel traffic SHOULD map to a common envelope for:

- inbound message events
- outbound message requests
- delivery lifecycle updates
- typing indicators
- reactions
- message pinning
- thread references

### 5.4 Capability Discovery

A capability document SHOULD allow a host, client, or extension to ask:

- which versions of Claw specs are implemented
- which artifact kinds are supported
- which optional features are available
- what size or rate limits exist
- which external standards are bridged

## 6. Versioning

Each spec family version is independent.

Examples:

- `claw.skill.v1`
- `claw.extension.v1`
- `claw.channel.v1`
- `claw.discovery.v1`

Implementations SHOULD advertise exact supported versions and MAY also advertise compatibility ranges.

Breaking changes require a new major version.

## 7. Compatibility Strategy

### 7.1 Required behavior

An implementation claiming support for a given version MUST:

- accept documents conforming to the corresponding schema
- reject malformed required fields
- ignore unknown optional fields unless the field is in a reserved namespace with stricter rules

### 7.2 Optional behavior

Optional behaviors MUST be declared via capabilities, not inferred.

Examples:

- `channel.typing`
- `channel.draft_updates`
- `channel.reactions`
- `channel.pinning`
- `skill.user_invocable`
- `extension.setup_flow`

### 7.3 Reserved namespaces

The following top-level extension namespaces are reserved:

- `claw`
- `interop`
- `capabilities`

Vendor-specific additions SHOULD use reverse-DNS style names, for example:

- `ai.openclaw.*`
- `dev.zeroclaw.*`

## 8. Security Model

This draft does not define a universal sandbox or permission model.

Instead:

- manifests MAY declare requested permissions
- hosts remain responsible for enforcement
- hosts SHOULD surface risk to operators before enablement

Permissions declared in metadata are advisory unless a host explicitly enforces them.

## 9. Initial Conformance Targets

The first conformance suite should validate:

1. schema validation for all four document types
2. unknown-field handling
3. capability negotiation fallbacks
4. channel threading fields
5. portable skill metadata loading
6. loading plain AgentSkills packages without Claw-only wrapper files

## 10. Proposed Next Steps

### 10.1 v0 working group

Create a small interop group with maintainers from at least:

- OpenClaw
- ZeroClaw
- one lightweight or embedded variant

### 10.2 Reference adapters

Build:

- one reference host adapter
- one reference channel plugin
- one plain AgentSkills reference skill package
- one AgentSkills package with additive Claw interop metadata
- one discovery handshake example

### 10.3 Conformance suite

Publish JSON Schema validation plus golden fixtures.

## 11. Open Questions

1. Should the extension manifest support both filesystem and remote OCI-like distribution references in v1?
2. Should the channel envelope include normalized attachment descriptors in the core or as an extension?
3. Should skill requirements remain host-specific hints, or be formalized further?
4. Should capability discovery be static JSON only, or also support a live RPC handshake?
5. Can the Claw skill interop manifest stay fully optional for most skills?
