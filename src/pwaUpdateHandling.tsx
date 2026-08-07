import React from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { activeGameStore } from "./activeGameStore";

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function visible() {
  return document.visibilityState === "visible";
}

function reloadSafe() {
  return visible() && !activeGameStore.get();
}

function reportPwaError(error: unknown, phase: string) {
  const message = error instanceof Error ? error.message : String(error || "Unknown PWA update error");
  const stack = error instanceof Error ? error.stack : undefined;
  fetch("/api/_client_error", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: window.location.href,
      message: `pwa_update_${phase}: ${message}`,
      stack,
      userAgent: navigator.userAgent,
      userId: window.__cwfUserId,
    }),
    keepalive: true,
  }).catch(() => undefined);
}

export function usePwaUpdateHandling() {
  if (!canUsePwaUpdateRegistration()) return;

  const registrationRef = React.useRef<ServiceWorkerRegistration | null>(null);
  const waitingRef = React.useRef(false);
  const applyingRef = React.useRef(false);
  const controllerReloadArmedRef = React.useRef(false);
  const maybeApplyRef = React.useRef<() => void>(() => undefined);

  useRegisterSW({
    immediate: true,
    onNeedRefresh() {
      waitingRef.current = true;
      maybeApplyRef.current();
    },
    onOfflineReady() {
      // No UI. First-install/offline-ready state is intentionally silent.
    },
    onRegisterError(error) {
      reportPwaError(error, "register_error");
    },
    onRegisteredSW(_url, registration) {
      registrationRef.current = registration || null;
      if (registration?.waiting) waitingRef.current = true;
      void registration?.update().catch((error) => reportPwaError(error, "initial_update"));
      maybeApplyRef.current();
    },
  });

  const maybeApply = React.useCallback(() => {
    if (!waitingRef.current || applyingRef.current || !reloadSafe()) return;
    const waiting = registrationRef.current?.waiting;
    if (!waiting) {
      void registrationRef.current?.update().catch((error) => reportPwaError(error, "refresh_update"));
      return;
    }
    applyingRef.current = true;
    controllerReloadArmedRef.current = true;
    try {
      waiting.postMessage({ type: "SKIP_WAITING" });
    } catch (error) {
      applyingRef.current = false;
      controllerReloadArmedRef.current = false;
      reportPwaError(error, "skip_waiting_message");
    }
  }, []);

  React.useEffect(() => {
    maybeApplyRef.current = maybeApply;
    maybeApply();
  }, [maybeApply]);

  React.useEffect(() => {
    const check = () => {
      if (visible()) void registrationRef.current?.update().catch((error) => reportPwaError(error, "visibility_update"));
      maybeApply();
    };
    const unsubscribe = activeGameStore.subscribe(() => maybeApply());
    const interval = window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      unsubscribe();
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [maybeApply]);

  React.useEffect(() => {
    const onControllerChange = () => {
      if (!controllerReloadArmedRef.current) return;
      if (!reloadSafe()) {
        applyingRef.current = false;
        maybeApply();
        return;
      }
      window.location.reload();
    };
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
  }, [maybeApply]);
}

function canUsePwaUpdateRegistration() {
  if (!("serviceWorker" in navigator)) return false;
  const serviceWorker = navigator.serviceWorker;
  return (
    typeof serviceWorker.register === "function" &&
    typeof serviceWorker.addEventListener === "function" &&
    typeof serviceWorker.removeEventListener === "function"
  );
}
