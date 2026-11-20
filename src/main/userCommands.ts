import { evaluateRig, getClip, getRig, createClip } from '../core/clip'
import type { ProjectStore } from '../core/document'
import { qToEulerDeg, vround } from '../core/math'
import { opDeleteKeys, opDragIK, opMoveKeys, opSetBone, opSetEasing, opWritePose, resolveEasing } from '../core/ops'
import type { UserCommand } from '../shared/api'

/**
 * Manual edits from the UI. Each becomes one undo step with a summary that is later shown to
 * the AI ("the user rotated RightUpperArm at frame 12 ..."), so it does not overwrite the fix.
 */
export function runUserCommand(store: ProjectStore, cmd: UserCommand): void {
  const p = store.project
  switch (cmd.type) {
    case 'undo':
      store.undo('user')
      return
    case 'redo':
      store.redo('user')
      return
    case 'setActive':
      store.setActive({ ...(cmd.clipId ? { activeClipId: cmd.clipId } : {}), ...(cmd.rigId ? { activeRigId: cmd.rigId } : {}) })
      return
    case 'newClip': {
      const clip = createClip(cmd.name, 30, 30, false)
      store.mutate('user', `created clip "${cmd.name}"`, (d) => {
        d.clips.push(clip)
        d.activeClipId = clip.id
      }, { clipId: clip.id })
      return
    }
  }
  const clip = getClip(p)
  const rig = getRig(p)
  const touched = { clipId: clip.id, rigId: rig.id }
  switch (cmd.type) {
    case 'setBone': {
      const e = vround(qToEulerDeg(cmd.q), 0)
      const pos = cmd.p ? `, position offset [${vround(cmd.p, 2).join(', ')}]` : ''
      store.mutate('user', `set ${cmd.bone} on ${rig.name} at frame ${cmd.frame} to rotation [${e.join(', ')}] deg${pos}`,
        (d) => opSetBone(getClip(d, clip.id), getRig(d, rig.id), cmd.frame, cmd.bone, cmd.q, cmd.p), { ...touched, frames: [cmd.frame], bones: [cmd.bone] })
      return
    }
    case 'dragIK': {
      const chain = rig.chains.find((c) => c.name === cmd.chain)
      store.mutate('user', `dragged ${cmd.chain} on ${rig.name} at frame ${cmd.frame} to [${vround(cmd.position, 2).join(', ')}]`,
        (d) => opDragIK(getClip(d, clip.id), getRig(d, rig.id), cmd.frame, cmd.chain, cmd.position), { ...touched, frames: [cmd.frame], bones: chain ? [...chain.bones] : [] })
      return
    }
    case 'moveKeys': {
      const desc = cmd.moves.map((m) => `${m.from} -> ${m.to}`).join(', ')
      store.mutate('user', `${cmd.copy ? 'copied' : 'moved'} keys on ${rig.name}: frame ${desc}`,
        (d) => opMoveKeys(getClip(d, clip.id), rig.id, cmd.moves, undefined, cmd.copy), { ...touched, frames: cmd.moves.map((m) => m.to) })
      return
    }
    case 'deleteKeys':
      store.mutate('user', `deleted keys on ${rig.name} at frame ${cmd.frames.join(', ')}`,
        (d) => opDeleteKeys(getClip(d, clip.id), rig.id, cmd.frames), touched)
      return
    case 'setEasing':
      store.mutate('user', `set easing "${cmd.preset}" on ${rig.name} at frame ${cmd.frames.join(', ')}`,
        (d) => opSetEasing(getClip(d, clip.id), rig.id, cmd.frames, resolveEasing(cmd.preset)!), touched)
      return
    case 'keyPose':
      store.mutate('user', `keyed the whole pose on ${rig.name} at frame ${cmd.frame}`, (d) => {
        const c = getClip(d, clip.id), r = getRig(d, rig.id)
        const pose = evaluateRig(c, r, cmd.frame)
        for (const b of r.bones) if (!b.locked && !pose[b.name]) pose[b.name] = { q: [0, 0, 0, 1] }
        opWritePose(c, r, cmd.frame, pose)
      }, { ...touched, frames: [cmd.frame] })
      return
    case 'updateClip': {
      const parts = Object.entries(cmd.patch).map(([k, v]) => `${k} = ${String(v)}`).join(', ')
      store.mutate('user', `changed clip "${clip.name}": ${parts}`, (d) => {
        Object.assign(getClip(d, clip.id), cmd.patch)
      }, touched)
      return
    }
  }
}
