# CLAW-SPEC-0001

Draft interoperability work for the emerging Claw ecosystem.

This repository starts from one pragmatic assumption:

- Claw runtimes will continue to differ internally.
- Interoperability should focus on portable artifacts and wire contracts.
- A host should be able to discover what a skill, plugin, channel, or client supports without needing runtime-specific code.
- AgentSkills remains the baseline skill format; Claw interop should reinforce it, not replace it.

Initial contents:

- `0001-claw-interoperability.md`
- `schemas/skill-package.schema.json`
- `schemas/extension-manifest.schema.json`
- `schemas/channel-envelope.schema.json`
- `schemas/capability-discovery.schema.json`

Current status:

- Draft only
- No governance yet
- No conformance suite yet
- Intended as a v0 discussion starter

Design goals:

- Keep the core small.
- Prefer capability negotiation over mandatory feature parity.
- Reuse existing ecosystem standards where possible.
- Standardize host/plugin boundaries, not runtime internals.
- Treat AgentSkills and `SKILL.md` as the default portable skill package.

Non-goals for v0:

- Replacing AgentSkills with a competing skill format
- Standardizing prompt engineering
- Standardizing agent planning semantics
- Standardizing internal tool SDKs for each implementation language
- Standardizing storage/session internals
