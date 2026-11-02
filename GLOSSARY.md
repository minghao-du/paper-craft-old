# Paper Craft

[简体中文](GLOSSARY.zh.md)

Research organization and agent workflow terminology.

## Language

**Project**:
A research project grouping related repositories. A Project is distinct from a Fleet.
_Avoid_: Fleet as a synonym for Project

**Fleet**:
A configured resource and coordination boundary containing Runs and a pool of working directories. Each Run owns its Orchestrator. Fleet has no scheduling agent; the Run Registry arbitrates resources deterministically.
_Avoid_: Project as a synonym for Fleet

**Run**:
One requested Issue or EPIC workflow, with a fixed provider and its own Orchestrator.

**Launcher**:
The entry role that requests an independent Orchestrator for a Run. Its responsibility ends when it reports the startup result; the calling conversation remains an ordinary conversation.

**Orchestrator**:
The single scheduling authority of a Run, materialized by exactly one active managed attempt. Replacement requires verified termination and retains prior attempts as history.

**Orchestrator attempt**:
A managed execution belonging to exactly one Run, launched and inspected through Managed Runtime.

**Coordinator**:
The Project-scoped research-report agent; it is not a Run scheduler.
