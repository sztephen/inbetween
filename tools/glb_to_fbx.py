"""Convert an Inbetween .glb export to .fbx with Blender.

Inbetween does not write FBX itself (see DECISIONS.md). Blender's exporter is the reliable route:

    blender --background --python tools/glb_to_fbx.py -- input.glb output.fbx

Works with Blender 3.6 or newer. The animation is baked per frame in the .glb, so it converts
without needing constraints or IK in the target application.
"""
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) != 2:
    raise SystemExit("usage: blender --background --python glb_to_fbx.py -- input.glb output.fbx")
src, dst = argv

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
bpy.ops.export_scene.fbx(
    filepath=dst,
    bake_anim=True,
    bake_anim_use_all_actions=False,
    bake_anim_use_nla_strips=False,
    add_leaf_bones=False,
    object_types={"EMPTY", "ARMATURE", "MESH"},
)
print(f"Wrote {dst}")
