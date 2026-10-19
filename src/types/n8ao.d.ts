// Minimal typings for the parts of n8ao we use (the package ships none).
declare module 'n8ao' {
  import type * as THREE from 'three';
  import { Pass } from 'three/addons/postprocessing/Pass.js';

  export interface N8AOConfiguration {
    aoRadius: number;
    distanceFalloff: number;
    intensity: number;
    color: THREE.Color;
    halfRes: boolean;
    aoSamples: number;
    denoiseSamples: number;
    denoiseRadius: number;
    gammaCorrection: boolean;
    screenSpaceRadius: boolean;
    depthAwareUpsampling: boolean;
  }

  export class N8AOPass extends Pass {
    constructor(scene: THREE.Scene, camera: THREE.Camera, width?: number, height?: number);
    configuration: N8AOConfiguration;
    beautyRenderTarget: THREE.WebGLRenderTarget;
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
  }
}
