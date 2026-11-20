# Inbetween build progress

Spec: the original build prompt (summarised in README.md). Decisions: DECISIONS.md.

## Stages
- [x] 1. Shell: window, viewport with R15, orbit, project save/load
- [x] 2. Animation core: data model, playback, timeline, IK, limits, undo
- [x] 3. Tool registry + MCP server (23 tools, preview and check included)
- [x] 4. Built-in agent: key storage, model picker, chat, streaming, live updates
- [x] 5. Manual touch-ups: gizmo, IK handles, key editing, AI awareness of edits
- [x] 6. Exports: rbxmx + Studio plugin, glTF, video (mp4, gif, webm)
- [x] 7. Custom rigs (Roblox JSON, glTF), props, camera tracks
- [x] 8. UI polish: motion, themes, reduced motion
- [x] 9. Packaging: installers, CI workflow, README
- [x] Added mid-build on request: first-person animation (first_person / head_cam views, `view` hand goals, visibility report, viewport toggle, video cameras)

## Definition of done
- [x] Clean install + dev script launches without errors (fresh clone: npm install, npm run dev, health endpoint answered)
- [x] All tests pass incl. scripted walk-cycle e2e (69 tests, `npm test`)
- [x] Test MCP client: connect to running app, list tools, wave animation, preview image (`scripts/e2e.mjs mcp`)
- [x] Agent loop vs mocked Claude API: streaming, tool calls, error states (`tests/agent.test.ts` and `scripts/e2e.mjs agent`)
- [x] Every exporter passes its round-trip test (`tests/export.test.ts`); real files written and signature-checked in e2e
- [x] Manual touch-up controls work in the running app (`scripts/e2e.mjs manual`)
- [x] UI in both themes (`scripts/e2e.mjs themes`, screenshots in test-results/)
- [x] macOS installers build (arm64 + x64 dmg); CI workflow covers macOS + Windows

## Not done / needs a human
- ffmpeg fetch script (`npm run ffmpeg`, also called by dist scripts) was written but never run here; the dmgs built in this session have no bundled ffmpeg. Video export was verified with ffmpeg from PATH.
- Nothing was tested in Roblox Studio (rbxmx drag-in, plugin).
- Real Claude API key never used; keychain save path not exercised by automation.
- Windows build and CI workflow have not run.
- tools/glb_to_fbx.py not run (no Blender here).

## Layout
src/core (pure TS), src/main (Electron main), src/renderer (React + three), src/launcher (stdio MCP proxy), plugin/ (Studio plugin), tests/, scripts/e2e.mjs.
Source of truth for the document is the main process (ProjectStore); the renderer mirrors it over IPC.
