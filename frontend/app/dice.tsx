"use client";

import { Canvas } from "@react-three/fiber";
import { Physics, useBox, usePlane } from "@react-three/cannon";
import { RoundedBox } from "@react-three/drei";
import { useEffect, useRef } from "react";

function Floor() {
  const [ref] = usePlane(() => ({
    rotation: [-Math.PI / 2, 0, 0],
    position: [0, -0.5, 0],
  }));
  return <mesh ref={ref as any} />;
}

function Wall({
  position,
  rotation,
  size = [0.4, 4, 6],
}: {
  position: [number, number, number];
  rotation: [number, number, number];
  size?: [number, number, number];
}) {
  const [ref] = useBox(() => ({
    type: "Static",
    position,
    rotation,
    args: size,
  }));
  return <mesh ref={ref as any} />;
}

function createPips(number: number) {
  const map: Record<number, [number, number][]> = {
    1: [[0, 0]],
    2: [[-0.26, -0.26], [0.26, 0.26]],
    3: [[-0.26, -0.26], [0, 0], [0.26, 0.26]],
    4: [
      [-0.26, -0.26],
      [-0.26, 0.26],
      [0.26, -0.26],
      [0.26, 0.26],
    ],
    5: [
      [-0.26, -0.26],
      [-0.26, 0.26],
      [0, 0],
      [0.26, -0.26],
      [0.26, 0.26],
    ],
    6: [
      [-0.26, -0.26],
      [-0.26, 0],
      [-0.26, 0.26],
      [0.26, -0.26],
      [0.26, 0],
      [0.26, 0.26],
    ],
  };

  return (map[number] || []).map(([x, y], i) => (
    <mesh key={i} position={[x, y, 0.015]}>
      <circleGeometry args={[0.105, 24]} />
      <meshStandardMaterial color="#1a1625" />
    </mesh>
  ));
}

function Die({
  startPos,
  rollTrigger,
  finalValue,
}: {
  startPos: [number, number, number];
  rollTrigger: number;
  finalValue: number;
}) {
  const settleRafRef = useRef<number | null>(null);

  const [ref, api] = useBox(() => ({
    mass: 0.85,
    position: startPos,
    args: [1.15, 1.15, 1.15],
    material: { friction: 0.48, restitution: 0.22 },
    linearDamping: 0.5,
    angularDamping: 0.42,
  }));

  useEffect(() => {
    if (rollTrigger === 0) return;

    const initialRotation: [number, number, number] = [
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    ];

    api.position.set(startPos[0], 2.75, startPos[2]);
    api.velocity.set(0, 0, 0);
    api.angularVelocity.set(0, 0, 0);
    api.rotation.set(...initialRotation);

    // Controlled throw for a smooth Ludo/board-game feel.
    const throwTimer = window.setTimeout(() => {
      api.velocity.set(
        (Math.random() - 0.5) * 2.8,
        4.8 + Math.random() * 1.2,
        (Math.random() - 0.5) * 2.4
      );
      api.angularVelocity.set(
        (Math.random() - 0.5) * 13,
        (Math.random() - 0.5) * 13,
        (Math.random() - 0.5) * 13
      );
    }, 35);

    let latestPosition: [number, number, number] = [startPos[0], 0.58, startPos[2]];
    const unsubscribePosition = api.position.subscribe((value) => {
      latestPosition = [value[0], value[1], value[2]];
    });

    // Let physics tumble, then smoothly guide the die onto the exact final face.
    const settleTimer = window.setTimeout(() => {
      unsubscribePosition();
      api.velocity.set(0, 0, 0);
      api.angularVelocity.set(0, 0, 0);

      const faceRotations: Record<number, [number, number, number]> = {
        1: [-Math.PI / 2, 0, 0],
        2: [0, 0, 0],
        3: [0, 0, Math.PI / 2],
        4: [0, 0, -Math.PI / 2],
        5: [Math.PI, 0, 0],
        6: [Math.PI / 2, 0, 0],
      };

      const target = faceRotations[finalValue] || [0, 0, 0];
      const targetRotation: [number, number, number] = [
        target[0] + Math.PI * 2 * 1.25,
        target[1] + Math.PI * 2 * 0.9,
        target[2] + Math.PI * 2 * 1.1,
      ];

      const fromRotation = [...initialRotation] as [number, number, number];
      const fromPosition = [...latestPosition] as [number, number, number];
      const duration = 420;
      const startedAt = performance.now();

      const animateSettle = (now: number) => {
        const rawT = Math.min(1, (now - startedAt) / duration);
        const t = 1 - Math.pow(1 - rawT, 3); // easeOutCubic

        api.rotation.set(
          fromRotation[0] + (targetRotation[0] - fromRotation[0]) * t,
          fromRotation[1] + (targetRotation[1] - fromRotation[1]) * t,
          fromRotation[2] + (targetRotation[2] - fromRotation[2]) * t
        );
        api.position.set(
          startPos[0],
          fromPosition[1] + (0.58 - fromPosition[1]) * t,
          startPos[2]
        );

        if (rawT < 1) {
          settleRafRef.current = window.requestAnimationFrame(animateSettle);
        } else {
          api.rotation.set(target[0], target[1], target[2]);
          api.position.set(startPos[0], 0.58, startPos[2]);
          settleRafRef.current = null;
        }
      };

      settleRafRef.current = window.requestAnimationFrame(animateSettle);
    }, 980);

    return () => {
      window.clearTimeout(throwTimer);
      window.clearTimeout(settleTimer);
      unsubscribePosition();
      if (settleRafRef.current !== null) {
        window.cancelAnimationFrame(settleRafRef.current);
        settleRafRef.current = null;
      }
    };
  }, [rollTrigger, finalValue]);

  return (
    <group ref={ref as any}>
      <RoundedBox args={[1.15, 1.15, 1.15]} radius={0.14} smoothness={6} castShadow>
        <meshStandardMaterial color="#f8fafc" metalness={0.08} roughness={0.32} />
      </RoundedBox>

      {/* Front - 1 */}
      <group position={[0, 0, 0.58]}>{createPips(1)}</group>
      {/* Back - 6 */}
      <group position={[0, 0, -0.58]} rotation={[0, Math.PI, 0]}>{createPips(6)}</group>
      {/* Right - 3 */}
      <group position={[0.58, 0, 0]} rotation={[0, Math.PI / 2, 0]}>{createPips(3)}</group>
      {/* Left - 4 */}
      <group position={[-0.58, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>{createPips(4)}</group>
      {/* Top - 2 */}
      <group position={[0, 0.58, 0]} rotation={[-Math.PI / 2, 0, 0]}>{createPips(2)}</group>
      {/* Bottom - 5 */}
      <group position={[0, -0.58, 0]} rotation={[Math.PI / 2, 0, 0]}>{createPips(5)}</group>
    </group>
  );
}

export default function DiceScene({
  dice = [1, 1],
  rollTrigger,
  onSettled,
}: {
  dice?: [number, number];
  rollTrigger: number;
  onSettled?: () => void;
}) {
  const onSettledRef = useRef(onSettled);

  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  useEffect(() => {
    if (rollTrigger === 0) return;

    // 980ms physics + 420ms smooth settle + 50ms breathing room.
    const timer = window.setTimeout(() => {
      onSettledRef.current?.();
    }, 1450);

    return () => window.clearTimeout(timer);
  }, [rollTrigger]);

  return (
    <div
      style={{
        width: "300px",
        height: "150px",
        borderRadius: "16px",
        overflow: "hidden",
        background: "rgba(0,0,0,0.4)",
      }}
    >
      <Canvas
        camera={{ position: [0, 7.5, 0], fov: 40 }}
        shadows
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#0b0914"]} />
        <ambientLight intensity={0.95} />
        <directionalLight position={[3, 10, 4]} intensity={1.35} castShadow />
        <directionalLight position={[-4, 5, -2]} intensity={0.45} />

        <Physics gravity={[0, -16, 0]}>
          <Die startPos={[-1.4, 2.8, 0]} rollTrigger={rollTrigger} finalValue={dice[0]} />
          <Die startPos={[1.4, 2.8, 0]} rollTrigger={rollTrigger} finalValue={dice[1]} />
          <Floor />

          <Wall position={[-2.9, 1.5, 0]} rotation={[0, 0, 0]} />
          <Wall position={[2.9, 1.5, 0]} rotation={[0, 0, 0]} />
          <Wall position={[0, 1.5, -2.4]} rotation={[0, Math.PI / 2, 0]} />
          <Wall position={[0, 1.5, 2.4]} rotation={[0, Math.PI / 2, 0]} />
        </Physics>
      </Canvas>
    </div>
  );
}
