import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { backdropTexture } from './textures';

/**
 * Bloom: what turns bright lines into neon.
 *
 * Only what is drawn brighter than the threshold blooms. The neon parts of
 * the scene (status lights, conduits, hall outlines, the selected unit, alert
 * glass) use unlit, un-tonemapped materials so they clear it; the navy
 * chassis and floor never do. Everything else about the image is unchanged.
 *
 * Takes over rendering (useFrame priority 1) and renders through a
 * multisampled half-float target, so thin lines stay antialiased.
 */
export function Bloom({ strength = 0.45, radius = 0.18, threshold = 0.85 }: { strength?: number; radius?: number; threshold?: number }) {
  const { gl, scene, camera, size } = useThree();

  const { composer, renderPass, bloom } = useMemo(() => {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(gl, target);
    const renderPass = new RenderPass(scene, camera);
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), strength, radius, threshold);
    composer.addPass(renderPass);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    return { composer, renderPass, bloom };
    // Built once per renderer and scene; camera and parameters are updated below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene]);

  useEffect(() => {
    bloom.strength = strength;
    bloom.radius = radius;
    bloom.threshold = threshold;
  }, [bloom, strength, radius, threshold]);

  useEffect(() => {
    composer.setPixelRatio(gl.getPixelRatio());
    composer.setSize(size.width, size.height);
  }, [composer, gl, size.width, size.height]);

  useEffect(() => () => composer.dispose(), [composer]);

  useFrame((state, delta) => {
    // The default camera is replaced after mount; always render through the
    // one the scene is actually using.
    renderPass.camera = state.camera;
    composer.render(delta);
  }, 1);

  return null;
}

/** The backdrop, as the scene's background, with the fog matched to its edge. */
export function Backdrop({ preset = 'cyber' }: { preset?: 'cyber' | 'studio' | 'holo' }) {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const previous = scene.background;
    scene.background = backdropTexture(preset);
    return () => { scene.background = previous; };
  }, [scene, preset]);
  return null;
}
