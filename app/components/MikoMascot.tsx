export type MikoPose = "wave" | "listen" | "write" | "tune" | "speak" | "present";

interface MikoMascotProps {
  size?: "sm" | "md" | "lg";
  pose?: MikoPose;
  float?: boolean;
  glow?: boolean;
}

// Height in px; width follows each pose's natural aspect ratio (every asset
// is alpha-trimmed to the robot's bounding box).
const SIZE_PX: Record<NonNullable<MikoMascotProps["size"]>, number> = {
  sm: 44,
  md: 150,
  lg: 230,
};

// The wave pose keeps the original un-suffixed filenames (and is the only
// pose with a small variant -- sm renders at 44px where poses are
// indistinguishable anyway).
function poseSrc(pose: MikoPose, size: "sm" | "md" | "lg"): string {
  if (size === "sm") return "/mascot/miko-robot-sm.png";
  if (pose === "wave") return "/mascot/miko-robot-lg.png";
  return `/mascot/miko-robot-${pose}-lg.png`;
}

/** The Miko Robot mascot -- "the brain behind Miko." Used anywhere the app is
 * guiding, explaining, or greeting a merchant, never as pure decoration.
 * Pick the pose that matches what Miko is doing on that surface: wave to
 * greet, listen when taking input, write when generating, tune on settings,
 * speak for narration, present when showing something off. */
export function MikoMascot({ size = "md", pose = "wave", float = true, glow = true }: MikoMascotProps) {
  const px = SIZE_PX[size];
  return (
    <img
      src={poseSrc(pose, size)}
      alt="Miko, your AI co-pilot"
      className={float ? "miko-mascot-float" : undefined}
      style={{
        height: px,
        width: "auto",
        display: "block",
        filter: glow ? "drop-shadow(0 0 24px rgba(91, 141, 239, 0.45))" : undefined,
      }}
    />
  );
}
