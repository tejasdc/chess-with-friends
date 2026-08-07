type ActiveGameListener = (active: boolean) => void;

let active = false;
const listeners = new Set<ActiveGameListener>();

export const activeGameStore = {
  get() {
    return active;
  },
  set(next: boolean) {
    if (active === next) return;
    active = next;
    for (const listener of listeners) listener(active);
  },
  subscribe(listener: ActiveGameListener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
