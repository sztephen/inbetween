// Small dependency-free math library on plain tuples so documents stay JSON.
// Conventions: right-handed, Y up. Quaternions are [x, y, z, w]. Euler angles are
// XYZ order (R = Rx * Ry * Rz), the same as Roblox's CFrame.Angles and three.js 'XYZ'.

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]
export interface Xform {
  p: Vec3
  q: Quat
}

export const DEG = Math.PI / 180
export const RAD = 180 / Math.PI

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z]
export const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const vscale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const vdot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const vcross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
]
export const vlen = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
export const vdist = (a: Vec3, b: Vec3): number => vlen(vsub(a, b))
export const vnorm = (a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 => {
  const l = vlen(a)
  return l < 1e-9 ? [...fallback] : [a[0] / l, a[1] / l, a[2] / l]
}
export const vlerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t
]
export const vneg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]]

export const QID: Quat = [0, 0, 0, 1]
export const qid = (): Quat => [0, 0, 0, 1]
export const xid = (): Xform => ({ p: [0, 0, 0], q: [0, 0, 0, 1] })

export const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
]
export const qinv = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]]
export const qnorm = (q: Quat): Quat => {
  const l = Math.hypot(q[0], q[1], q[2], q[3])
  return l < 1e-12 ? [0, 0, 0, 1] : [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}
export const qrot = (q: Quat, v: Vec3): Vec3 => {
  const [x, y, z, w] = q
  const tx = 2 * (y * v[2] - z * v[1])
  const ty = 2 * (z * v[0] - x * v[2])
  const tz = 2 * (x * v[1] - y * v[0])
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx)
  ]
}
export const qdot = (a: Quat, b: Quat): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]

export function qslerp(a: Quat, b: Quat, t: number): Quat {
  let d = qdot(a, b)
  let bb = b
  if (d < 0) {
    d = -d
    bb = [-b[0], -b[1], -b[2], -b[3]]
  }
  if (d > 0.9995) {
    return qnorm([
      a[0] + (bb[0] - a[0]) * t,
      a[1] + (bb[1] - a[1]) * t,
      a[2] + (bb[2] - a[2]) * t,
      a[3] + (bb[3] - a[3]) * t
    ])
  }
  const th = Math.acos(Math.min(1, d))
  const s = Math.sin(th)
  const wa = Math.sin((1 - t) * th) / s
  const wb = Math.sin(t * th) / s
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb]
}

/** Angle in radians between two orientations. */
export const qangle = (a: Quat, b: Quat): number => 2 * Math.acos(Math.min(1, Math.abs(qdot(a, b))))

export function qFromAxisAngle(axis: Vec3, angle: number): Quat {
  const n = vnorm(axis)
  const s = Math.sin(angle / 2)
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)]
}

/** Euler XYZ in radians -> quaternion (R = Rx * Ry * Rz). */
export function qFromEuler(x: number, y: number, z: number): Quat {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2)
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2)
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3
  ]
}
export const qFromEulerDeg = (e: Vec3): Quat => qFromEuler(e[0] * DEG, e[1] * DEG, e[2] * DEG)

/** Row-major 3x3 rotation matrix [r00,r01,r02,r10,...] (columns are the basis vectors). */
export type Mat3 = [number, number, number, number, number, number, number, number, number]

export function qToMat3(q: Quat): Mat3 {
  const [x, y, z, w] = q
  const xx = x * x, yy = y * y, zz = z * z
  const xy = x * y, xz = x * z, yz = y * z
  const wx = w * x, wy = w * y, wz = w * z
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)
  ]
}

export function qFromMat3(m: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m
  const tr = m00 + m11 + m22
  let q: Quat
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1)
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]
  }
  return qnorm(q)
}

/** Quaternion -> Euler XYZ in radians. */
export function qToEuler(q: Quat): Vec3 {
  const m = qToMat3(q)
  const m02 = Math.max(-1, Math.min(1, m[2]))
  const y = Math.asin(m02)
  if (Math.abs(m02) < 0.9999999) {
    return [Math.atan2(-m[5], m[8]), y, Math.atan2(-m[1], m[0])]
  }
  return [Math.atan2(m[7], m[4]), y, 0]
}
export const qToEulerDeg = (q: Quat): Vec3 => {
  const e = qToEuler(q)
  return [e[0] * RAD, e[1] * RAD, e[2] * RAD]
}

/** Orthonormal basis quaternion whose X axis is `x` and whose Y axis is as close to `yHint` as possible. */
export function qFromBasisXY(x: Vec3, yHint: Vec3): Quat {
  const ax = vnorm(x, [1, 0, 0])
  let az = vcross(ax, yHint)
  if (vlen(az) < 1e-8) az = vcross(ax, Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])
  az = vnorm(az)
  const ay = vcross(az, ax)
  return qFromMat3([ax[0], ay[0], az[0], ax[1], ay[1], az[1], ax[2], ay[2], az[2]])
}

/** Shortest rotation taking direction a to direction b. */
export function qFromTo(a: Vec3, b: Vec3): Quat {
  const u = vnorm(a), v = vnorm(b)
  const d = vdot(u, v)
  if (d > 0.999999) return qid()
  if (d < -0.999999) {
    const axis = vnorm(vcross(u, Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))
    return qFromAxisAngle(axis, Math.PI)
  }
  const c = vcross(u, v)
  return qnorm([c[0], c[1], c[2], 1 + d])
}

export const xmul = (a: Xform, b: Xform): Xform => ({ p: vadd(a.p, qrot(a.q, b.p)), q: qnorm(qmul(a.q, b.q)) })
export const xinv = (a: Xform): Xform => {
  const qi = qinv(a.q)
  return { p: qrot(qi, vneg(a.p)), q: qi }
}
export const xpoint = (a: Xform, p: Vec3): Vec3 => vadd(a.p, qrot(a.q, p))

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
export const round = (x: number, digits = 3): number => {
  const m = 10 ** digits
  const r = Math.round(x * m) / m
  return r === 0 ? 0 : r
}
export const vround = (v: Vec3, digits = 3): Vec3 => [round(v[0], digits), round(v[1], digits), round(v[2], digits)]
export const qround = (q: Quat, digits = 5): Quat => [
  round(q[0], digits), round(q[1], digits), round(q[2], digits), round(q[3], digits)
]
