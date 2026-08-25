export type ToastType = "success" | "error" | "info" | "warning";

export type Toast = {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

let nextId = 0;

function createToastState() {
  const toasts = $state<Toast[]>([]);

  function remove(id: string) {
    const index = toasts.findIndex((t) => t.id === id);
    if (index !== -1) {
      toasts.splice(index, 1);
    }
  }

  function add(message: string, type: ToastType = "info", duration = 5000) {
    const id = String(nextId++);
    toasts.push({ id, message, type, duration });

    if (duration > 0) {
      setTimeout(() => {
        remove(id);
      }, duration);
    }
  }

  return {
    get toasts() {
      return toasts;
    },
    add,
    remove,
  };
}

export const toastState = createToastState();
