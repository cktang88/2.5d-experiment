// Volumetric sun shafts. For every pixel we reconstruct the world position from the
// depth buffer and march the view ray through the sun's shadow map: lit samples add
// in-scattered light, shadowed ones don't. Trees, battlements and windows therefore
// cut visible beams through the low-lying haze, which reads well from a top-down camera.
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const STEPS = 20;

const VolumetricShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    tShadow: { value: null as THREE.Texture | null },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uProjInv: { value: new THREE.Matrix4() },
    uViewInv: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uSunColor: { value: new THREE.Color() },
    uIntensity: { value: 0.35 },
    uGround: { value: 8 },
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tDepth, tShadow;
    uniform mat4 uShadowMatrix, uProjInv, uViewInv;
    uniform vec3 uCamPos, uSunColor, uSunDir;
    uniform float uIntensity, uGround, uTime;
    varying vec2 vUv;
    // interleaved gradient noise to jitter the march start (hides banding)
    float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).x;
      vec4 v = uProjInv * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      v /= v.w;
      vec3 world = (uViewInv * v).xyz;
      vec3 rd = world - uCamPos;
      float L = length(rd);
      rd /= L;
      // only march the last stretch of the ray, where the haze and the shadow map live
      float start = max(0.0, L - 32.0);
      float stepLen = (L - start) / float(${STEPS});
      float jit = ign(gl_FragCoord.xy + fract(uTime) * 61.0);
      float acc = 0.0;
      for (int i = 0; i < ${STEPS}; i++) {
        vec3 p = uCamPos + rd * (start + (float(i) + jit) * stepLen);
        vec4 sc = uShadowMatrix * vec4(p, 1.0);
        sc.xyz /= sc.w;
        float lit = 1.0;
        if (sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0)
          lit = step(sc.z - 0.002, unpackRGBAToDepth(texture2D(tShadow, sc.xy)));
        // haze hugs the ground
        float dens = exp(-max(p.y - uGround, 0.0) * 0.3);
        acc += lit * dens;
      }
      acc /= float(${STEPS});
      // forward scattering: brighter when looking toward the sun
      float phase = 0.55 + 0.45 * pow(max(dot(rd, uSunDir), 0.0), 4.0);
      float amount = acc * min(1.0, (L - start) / 24.0);
      col.rgb += uSunColor * amount * phase * uIntensity;
      gl_FragColor = col;
    }`,
};

export class VolumetricPass extends ShaderPass {
  constructor() { super(VolumetricShader); }

  update(camera: THREE.PerspectiveCamera, sun: THREE.DirectionalLight, depth: THREE.Texture, ground: number, strength: number, time: number): void {
    const u = this.uniforms;
    const map = sun.shadow.map;
    this.enabled = !!map && strength > 0.01;
    if (!map) return;
    u.tDepth.value = depth;
    u.tShadow.value = map.texture;
    u.uShadowMatrix.value.copy(sun.shadow.matrix);
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uViewInv.value.copy(camera.matrixWorld);
    u.uCamPos.value.copy(camera.position);
    u.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
    u.uSunDir.value.subVectors(sun.position, sun.target.position).normalize();
    u.uIntensity.value = 0.07 * strength;
    u.uGround.value = ground;
    u.uTime.value = time;
  }
}
