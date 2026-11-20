# Inbetween build progress

Spec: the original build prompt (summarised in README.md). Decisions: DECISIONS.md.
Update this file after every stage so work survives a context reset.

## Stages
- [ ] 1. Shell: window, viewport with R15, orbit, project save/load
- [ ] 2. Animation core: data model, playback, timeline, IK, limits, undo
- [ ] 3. Tool registry + MCP server (all tools, preview, check)
- [ ] 4. Built-in agent: key storage, model picker, chat, streaming, live updates
- [ ] 5. Manual touch-ups: gizmo, IK handles, key editing, AI awareness of edits
- [ ] 6. Exports: rbxmx + Studio plugin, glTF, video
- [ ] 7. Custom rigs, props, camera tracks
- [ ] 8. UI polish: motion, themes, reduced motion
- [ ] 9. Packaging: installers, CI, README

## Definition of done (verify each)
- [ ] Clean install + dev script launches without errors
- [ ] All tests pass incl. scripted walk-cycle e2e
- [ ] Test MCP client: connect to running app, list tools, wave animation, preview image
- [ ] Agent loop vs mocked Claude API (streaming, tool calls, error states)
- [ ] Every exporter passes round-trip test
- [ ] Manual touch-up controls work in the running app
- [ ] UI matches direction in both themes
- [ ] Installer builds on this platform (macOS); CI covers macOS + Windows

## Notes / state
- Layout: src/core (pure TS: math, rig, IK, clip eval, validators, tools, exporters), src/main (Electron main: store host, MCP server, agent, video), src/renderer (React + three), src/launcher (stdio MCP proxy), plugin/ (Roblox Studio plugin), tests/.
- Source of truth for the document is the main process (ProjectStore); renderer mirrors it over IPC.
