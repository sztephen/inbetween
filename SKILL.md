---
name: inbetween-animation
description: Animate 3D rigs in the Inbetween desktop app through its MCP tools (set_pose, preview, check and friends). Use when asked to create or revise character, first-person, prop or cutscene animation in Inbetween, including Roblox R15 animations.
---

> Requires the Inbetween app to be open and connected as an MCP server (Inbetween > Settings > Connect an MCP client).

# Animating in Inbetween

You are animating 3D rigs in Inbetween. You do the animating yourself, the way an animator would: you choose the poses and the timing, the app solves the joints, renders frames so you can see your work, and checks the mechanics. The person you are working with watches the viewport update live, gives notes, and sometimes nudges a pose by hand.

## Coordinates

- Right-handed, +Y up, ground at y = 0.
- Characters face -Z. Forward is -Z, back is +Z, the character's right is +X, its left is -X.
- Units are the rig's own: studs for Roblox rigs (an R15 is about 5.4 studs tall), meters for glTF rigs.
- Rotations are Euler XYZ degrees in the joint's local frame. For a limb hanging down, +X swings it forward.
- Frames are whole numbers starting at 0. A clip's `length` is its last frame; at 30 fps, length 30 is one second.
- First person: the player's eye is at the rest head position looking along -Z with a 70 degree field of view (`get_rig` reports it as `first_person.eye_world`). The head is hidden and only what is in front of the eye is seen.
- In the front view the camera faces the character, so the character's right hand is on the left of the image. The side view looks at the character's right side, so forward is to the right of the image.

## The workflow

1. **Read the rig first.** Call `get_rig` before posing anything. Note the rest positions of the hands, feet and hips and each IK chain's `max_reach`, so your targets are reachable. Call `get_scene` if you do not know what rigs and clips exist.

2. **Block the key poses.** Decide the storytelling poses, the few frames that would explain the action on their own, and set them with `set_pose` using `timing: "stepped"`. Pose by goals: where the hips are, where each hand and foot is, where the head looks. Set the hips first, since everything hangs off them. Read each result: it tells you where the effectors landed, whether a goal was out of reach or clamped by a joint limit, and in `pose_notes` whether the pose puts a part through the ground or through another part, or leaves the weight off the feet.

3. **Preview and look.** Call `preview` with `frames: "keys"` and study the image. Each pose should read clearly as a silhouette from the front and the side: limbs clear of the body, a visible line of action, weight over the supporting foot. Fix anything that reads badly before going further. It is much cheaper to fix a pose now than after the in-betweens exist.

4. **Add breakdowns and in-betweens, then timing.** Breakdowns are the poses between keys that decide *how* the motion travels: which part leads, how the arc curves, what drags behind. Then replace the stepped timing with real easing using `set_timing`, and move keys closer together or further apart until the rhythm is right. Fewer frames between poses reads as fast and light; more frames reads as slow and heavy. Still frames cannot show you timing, so call `motion_report` once the easing is in: it gives the speed of the hips, head, hands and feet through the clip, where each one stops, and where nothing moves. Compare it with what you intended (a sharp peak for a strike, a ramp for an ease, parts stopping a few frames apart for overlap) and retime until it matches.

5. **Apply the principles that fit the action.**
   - *Anticipation*: a smaller move in the opposite direction before the main one (crouch before a jump, pull back before a punch).
   - *Follow-through and overlap*: things do not all stop on the same frame. Let the hips lead, then the chest, then the arms and head, a few frames apart, and let them settle past the pose and come back.
   - *Arcs*: hands, feet and the head travel on curves. Use `preview` with `trails` to see the path. Add a breakdown to round out a path that cuts a straight line.
   - *Weight*: the hips shift over the supporting foot before the other foot lifts. Heavy things start slow and are hard to stop.
   - *Combat timing*: a long anticipation, a strike that takes only two or three frames, then a held impact pose (`set_timing` holds) before the recovery. The contrast is what gives a hit its force.

6. **Check, fix, preview again.** Call `check`. It reports foot sliding, joint limits, self-intersection, jitter, loop seams, ground penetration and held poses that are off balance, with frame numbers. Fix each one, then `check` again until it is clean. A clean check means the mechanics are sound, not that the motion looks good, so `preview` again as well.

7. **Do not call it done until you have looked.** After your last change, however small, `preview` the result and look at it before telling the person the animation is finished. Say what you made, the clip length, and anything you were unsure about.

## Working with the tools

- `set_pose` starts from whatever the clip already shows at that frame, so you only state what changes. Feet you do not mention stay planted when the hips move; pass `keep_feet: false` when the character leaves the ground.
- `add_contact` pins a foot or hand over a frame range so it cannot slide between keys. Add contacts for every planted foot. For a walk or run on the spot, give the contact a `slide` so the foot travels backward at constant speed.
- Elbows and knees bend the right way on their own. Use a `pole` point when you care which way they aim (elbows out for a guard, knees apart for a wide stance).
- `mirror_pose` and `copy_pose_to_frame` build symmetric cycles and close loops. `save_pose` and `load_pose` reuse a pose by name.
- `add_marker` names the frame a gameplay event happens on (`hit`, `footstep`).
- `undo` steps back through your edits and the person's edits alike.
- If a tool result says the person made manual edits, they adjusted something by hand. Treat those as intended and keep them unless asked to change them.
- Video exports (`mp4`, `gif`, `webm`) render frame by frame and show progress in the app. `cancel_render` stops one that is running (the person can also press Stop in the app); `cancel_render` with `status_only: true` reports progress.
- Over MCP only: when the person asks for Inbetween's own AI (the built-in or in-app AI) to make the motion, call `ask_inbetween_ai` with a complete brief. It animates inside the app on the person's API key while they watch in the chat panel, and returns its summary when done. Then review the clip yourself (`get_clip`, `preview`, `check`, `motion_report`) and fine-tune it with your own tools. Do not use it unless the person asks for it.
- Several animations at once: when different workers (sub-agents) animate different clips at the same time, create every clip first, then have each worker pass its own `clip` (and `rig`) on every call. The active clip is shared, so a call that leaves `clip` out may land in someone else's animation. The undo history is shared too, so a worker should re-pose instead of calling `undo`.

## Recipes

### Combat and abilities

A strike is anticipation, strike, hold, recovery. For a one-second punch at 30 fps: guard pose at 0; wind up by about frame 8 (hips turn away, fist drawn back, weight on the back foot); impact at frame 11 (hips and chest rotated through, arm near full extension, weight on the front foot); hold the impact until about frame 15; recover to guard by frame 30. Leave the wind-up with `heavy` timing so the strike accelerates into the impact, and leave the hold with `floaty`. Put a `hit` marker on the impact frame. Keep both feet in contact unless a foot genuinely steps. For abilities and casts, the same shape works: a gather, a release, a held pose while the effect plays, a settle.

### Movement cycles

Set `loop: true` and Movement priority. Build half the cycle, then mirror it.

- **Walk** (24 to 32 frames): contact pose at 0 (front heel down, back toe down, arms opposite the legs), down pose just after (hips lowest, weight over the front leg), passing pose at a quarter (back leg passes under the hips, hips rising), up pose before the half-way contact. `mirror_pose` frames 0 through the passing pose into the second half, and `copy_pose_to_frame` frame 0 to the last frame. Plant each foot with a sliding contact from its contact frame to its lift-off.
- **Run** (14 to 20 frames): same structure with a forward lean, a higher knee drive, more arm swing, and a moment with both feet off the ground.
- **Jump**: crouch (anticipation), launch with a fast extension, tuck at the apex, extend to reach for the ground, land in a crouch and settle. Use `keep_feet: false` while airborne and contacts before take-off and after landing.
- **Idle** (60 to 120 frames, looping): small and slow. Breathe through the chest, shift weight slightly over one foot, let the head and hands trail a few frames behind. Keep both feet in contact for the whole clip.

### Emotes and cutscenes

Emotes are gestures with a clear start, accent and finish: hit the accent pose a little early, overshoot it, settle back, and let the head and the free hand overlap. For a wave, raise the arm first, then swing the forearm from the elbow, with the hand trailing the forearm. For cutscenes, add every rig the scene needs, animate them in the same clip, and use `set_camera` to key the camera position, target and field of view. Check framing with `preview` using the `camera` view, and change shots with `stepped` camera timing for a cut or eased timing for a move.

### First-person animation

First-person animations are judged from inside the character's head, so preview them with `views: ["first_person"]` (add `"side"` to keep an eye on the body). The picture is 16:9; arms hanging at the sides are not in it. Things to do differently:

- Place hands in the picture, not in the world: give a hand goal a `view` of `[x, y, depth]`, where x and y run from -1 to 1 across the picture and depth is the distance in front of the eye. A held item rests around `[0.45, -0.5, 1.6]`; two-handed poses mirror that on the left. Use a `pole` below and outside the hand so the elbow stays out of frame and the forearm enters from the bottom corner.
- Read `first_person_visibility` in the preview result. It says, per frame, whether each hand is in the picture and where. A hand that drifts out of frame mid-action is invisible to the player, however good it looks from outside.
- Motion toward and away from the eye reads as size, not travel, so keep the important movement across the picture: swings travel side to side or corner to corner, a reload drops the hand down and out of frame and brings it back.
- Keep it smaller and quicker than third person. Anticipation is a short pull back toward the bottom corner, the action crosses the centre in two or three frames, and the settle is a small overshoot. Big hip and spine moves do nothing for the player unless the camera is locked to the head.
- Use `head_cam` instead when the game attaches its camera to the head: then head bob, recoil kick and landing dips are part of the animation, so keep head rotation small (a few degrees) or the view becomes nauseating.
- An idle is a slow drift of the hands of a few hundredths of the picture, with the two hands slightly out of phase.

### Props

A prop is a small rig: boxes joined at pivots. Add one with `add_rig` (presets for doors, chests, levers, crates, or custom `parts`), read it with `get_rig`, and animate its parts with `set_pose` `bones` rotations. Mechanical things want anticipation and settle too: a door starts slow, swings, and bounces slightly at its stop (`bouncy` timing); a lever snaps and rings. When a character uses a prop, key the prop and the character in the same clip, and pin the hand to the handle's path with hand goals on the same frames.

### The person's own models

The person can import their own models (File > Import Model or Rig, or ask you with a file path and `add_rig` type `"file"`): rigged characters, or plain objects such as a sword, a chair or a vehicle. They show with their real mesh. `get_scene` lists them and `get_rig` gives their parts and size.

- **Size and place first.** A new model is stood beside the existing rigs, and metre-sized files are converted to studs in a studs scene. Preview it next to the character; if it is the wrong size or in the wrong spot, fix it with `place_rig` (position, rotation, scale) before animating.
- **Animating the model itself.** Its parts are bones: rotate them with `set_pose` `bones`, and move the whole thing by keying its root part's `position` (an offset from where `place_rig` put it). Pass `rig` on every call so the keys land on the model and not the character.
- **Both at once.** Characters and models are keyed in the same clip on the same frames. Pose the model on a frame first, then the character, so the character can reach for where the model now is. Preview shows every rig together.
- **Carrying** (a sword, a cup, a box, a hat): `attach` the model to `right_hand`, `Head` or any bone for the frames it is held. It then follows that bone exactly on every frame. Preview a few frames and adjust the grip with `position` and `rotation`. To pick something up, start the attachment on the frame the hand arrives, with `keep_position: true`; to put it down, end the attachment and place or key the model where it lands.
- **Touching and operating** (a door handle, a lever, another character's shoulder): give the hand goal `on: {rig, part}` instead of a position, on every key where the hand should be on that part. The part's position is read at that frame, so key the model's motion first and add breakdowns where the part moves along a curve.
