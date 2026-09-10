import { useEffect, useState, type ReactNode } from "react";

const touchDisplay = "(hover: none) and (pointer: coarse)";

function isLandscape() {
  if (!window.matchMedia(touchDisplay).matches) return false;

  // Screen orientation survives the software keyboard shrinking the viewport.
  if (screen.orientation?.type) return screen.orientation.type.startsWith("landscape");
  if (typeof window.orientation === "number") return Math.abs(window.orientation) === 90;
  return screen.width > screen.height;
}

async function lockPortrait() {
  if (!window.matchMedia(touchDisplay).matches || document.visibilityState !== "visible") return;
  const orientation = screen.orientation as (ScreenOrientation & {
    lock?: (orientation: "portrait") => Promise<void>;
  }) | undefined;
  try {
    await orientation?.lock?.("portrait");
  } catch {
    // Some browsers require fullscreen or do not support locking; the guard remains.
  }
}

export function PortraitOnly({ children }: { children: ReactNode }) {
  const [landscape, setLandscape] = useState(isLandscape);

  useEffect(() => {
    const touch = window.matchMedia(touchDisplay);
    const update = () => setLandscape(isLandscape());
    const resume = () => {
      update();
      void lockPortrait();
    };
    screen.orientation?.addEventListener("change", update);
    window.addEventListener("orientationchange", update);
    window.addEventListener("resize", update);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", resume);
    document.addEventListener("fullscreenchange", resume);
    touch.addEventListener("change", resume);
    resume();
    return () => {
      screen.orientation?.removeEventListener("change", update);
      window.removeEventListener("orientationchange", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", resume);
      document.removeEventListener("fullscreenchange", resume);
      touch.removeEventListener("change", resume);
    };
  }, []);

  return (
    <>
      <div hidden={landscape} inert={landscape}>{children}</div>
      <section className="portrait-notice" hidden={!landscape} role="status">
        <img src="/icon.svg" width="64" height="64" alt="" />
        <h1>Turn your device upright</h1>
        <p>Rotate to portrait to continue.</p>
      </section>
    </>
  );
}
