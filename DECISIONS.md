# Decisions

Choices made where the brief left room, things that turned out differently from the brief, and what could not be verified here. Most important first.

## Things that differ from the brief

**FBX export is not included.** There is no solid route from this stack: FBX is a proprietary format, there is no maintained JavaScript FBX writer that handles skinned animation, and a hand-written exporter would be the "broken exporter" the brief asked to avoid. The alternative is glTF, which Unity, Unreal, Godot and Blender all import, plus `tools/glb_to_fbx.py`, a Blender script that converts an exported `.glb` to `.fbx`. I did not run that script (Blender is not installed here).

**Transparent video is WebM or GIF, not MP4.** H.264 in MP4 cannot store an alpha channel. A third video format, WebM (VP9 with alpha), was added for this, and GIF supports 1-bit transparency. The export sheet disables "Transparent" for MP4 and says why; the `export` tool returns a clear error.

**ffmpeg is not downloaded on `npm install`.** `scripts/fetch-ffmpeg.mjs` downloads static builds (from the `@ffmpeg-installer` npm packages) into `vendor/ffmpeg/<platform>-<arch>/`, and `npm run dist:mac` / `dist:win` call it so installers bundle the right binary per platform and architecture. It is opt-in in development (`npm run ffmpeg`); otherwise the app uses `ffmpeg` from PATH. **This fetch script has not been run**: downloading the binaries was blocked by the session's permission system, so I left it alone. Consequences: video export was verified using the ffmpeg already on this machine's PATH, and the `.dmg` built in this session does not contain ffmpeg. Running `npm run dist:mac` yourself fetches it and bundles it. Those builds are GPL-licensed ffmpeg binaries shipped as a separate executable.

**Windows uses the standard window frame and menu bar.** macOS gets a hidden title bar with inset traffic lights so the viewport runs to the top. On Windows the brief asks for standard controls and native menus; a frameless window would have lost the native menu bar, so Windows keeps the normal frame.

## Claude API

- Verified against the current API reference: model ids `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-2` are correct.
- "Extended thinking at a medium level" is now `thinking: {type: "adaptive"}` plus `output_config: {effort: "medium"}`. The older `budget_tokens` parameter is rejected by all three models. Thinking summaries are requested so the chat can show what Claude is thinking about.
- Server-side refusal fallbacks are enabled for the three default models (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`), so if a safety classifier declines a request the API can retry it on another model inside the same call. This is per model in the models file (`"fallbacks": true`); remove it if you do not want it.
- The agent is a hand-written streaming loop on the Messages API rather than Anthropic's hosted Managed Agents, because the brief asks for a loop that runs in the app with your key against local tools.
- This SDK version sends the API key as `Authorization: Bearer` rather than `x-api-key`. The base URL is pinned to `https://api.anthropic.com` in code so an `ANTHROPIC_BASE_URL` in your environment cannot redirect the key. A `--mock-api=<url>` flag exists for tests and is ignored in packaged builds.
- Conversation history is append-only and nothing is compacted. A very long session will eventually hit the context limit; "New chat" starts fresh.

## Roblox

- **R15 data is real, from an exported rig.** Joint C0/C1 offsets and part sizes come from a Rig Builder block rig `.rbxmx` found in a public repository, cross-checked against a second independent export (identical). The source URL is recorded in `src/core/r15_data.json`. Rotation limits and IK hints are mine, not Roblox's.
- **Pose convention verified:** `Pose.CFrame` is `Motor6D.Transform`, with `Part1.CFrame = Part0.CFrame * C0 * Transform * C1:Inverse()`; poses are named after the driven part and nested from the root part. A test rebuilds part positions from the exported file with the real C0/C1 values and compares them to the app.
- **Cubic easing exports as `CubicV2` (5), never legacy `Cubic` (3).** Legacy Cubic plays with In and Out swapped at runtime; CubicV2 matches. On import, legacy Cubic is un-swapped.
- **Baked where Roblox could differ.** Roblox does not publish its elastic and bounce easing formulas, and the direction semantics of `Constant` are not documented clearly. So elastic and bounce segments are baked to one linear key per frame, stepped segments get a hold key one frame before the next key, and frames driven by contacts or straight-path IK are baked per frame. Linear and cubic keys stay sparse and editable in Studio.
- Ancestor poses that are not keyed are written with `Weight = 0`, the Animation Editor's own convention for placeholders.
- **Round-trip test uses a real file.** `tests/fixtures/roform_jump_r6.rbxmx` is an MIT-licensed real KeyframeSequence; the reader and writer are checked against it as well as against Inbetween's own output.
- **Not verified in Studio:** nothing here was run in Roblox Studio. Specifically untested: dragging the `.rbxmx` into Studio, the plugin (loading, the HTTP calls to localhost, building instances), and how the current Animation Editor picks up a sequence placed in `AnimSaves`. The plugin's Preview button uses `KeyframeSequenceProvider:RegisterKeyframeSequence`, which Roblox has marked deprecated in favour of `AnimationClipProvider`; it still works per the docs.
- Skinned-mesh `Bone` rigs import and export, but the exact pose nesting Roblox expects for bones under parts could not be confirmed from documentation.

## Animation model

- **Contacts are solved every frame**, not only on keys, so a planted foot cannot slide between keys. The `foot_sliding` check therefore reports the case that can still go wrong: the leg cannot reach its pin.
- **Sliding contacts** (`slide`) make in-place walk and run cycles possible: the planted foot travels at constant speed like a treadmill.
- **Ball joints (shoulders, hips) use a swing cone and twist range**; hinges and other joints use Euler ranges. Euler boxes cannot describe a shoulder sensibly.
- **IK reaching beats elbow direction.** If joint limits reject the requested pole direction, the solver swivels the limb to the nearest one that reaches.
- `set_pose` keys every bone by default, so each key frame is a complete pose. That keeps blocking robust and exports clean.
- The ground check covers every part, not just feet. On a blocky R15 a flat trailing foot with a steep shin does put the shin's corner through the floor, and the check says so; lifting the heel fixes it.
- Frames are whole numbers at the clip's frame rate (default 30, Roblox's rate).

## First person

Added on request during the build. Two cameras: `first_person` (fixed at the head's rest position, 70 degree field of view, matching Roblox's default camera, which follows the root rather than the animated head) and `head_cam` (locked to the animated head). Hand goals accept a `view` of `[x, y, depth]` to place them in the picture, and first-person previews report per frame whether each hand is in frame. The picture is assumed to be 16:9.

## Previews

Contact sheets tint right limbs red and left limbs blue with a different shade per segment, because a grey blocky rig is hard to read in a still. The live viewport stays neutral.

## Security

- The MCP server binds to `127.0.0.1` only, requires a bearer token (generated once, stored in the app's data folder), and rejects requests with a non-local `Host` or a foreign `Origin`, so a web page cannot drive the app.
- The Studio endpoints require a custom header that a browser cannot send cross-site.
- The renderer is sandboxed with context isolation; the API key never reaches it.

## Platforms

Built and tested on macOS (Apple Silicon). Windows is correct by construction (no platform-specific code beyond window chrome, the Plugins folder path and the ffmpeg file name) and covered by the GitHub Actions workflow, which runs the tests, the end-to-end script and the installer build on both macOS and Windows. That workflow has not run yet. Both macOS `.dmg` installers (arm64 and x64) were built here; only the arm64 app was launched and smoke-tested (MCP server and stdio launcher work from the packaged app).

## Smaller choices

- `npm install` runs Electron's own `install-electron` step. This Electron version no longer downloads its binary during install by itself, and without it `npm run dev` fails on a fresh checkout.
- Project files use the `.inbetween` extension (JSON inside).
- The timeline loop toggle sets the clip's own loop flag, so what plays is what exports.
- Typeface: Schibsted Grotesk, bundled. Accent: a blue-pencil blue, one accent in both themes.
- The built-in agent's replies render a small subset of Markdown (paragraphs, lists, bold, inline code).
