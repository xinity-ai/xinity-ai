export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

let nextId = 0;

class ToastManager {
  toasts = $state<Toast[]>([]);

  add(message: string, type: ToastType = "info", duration = 5000) {
    const id = String(nextId++);
    const toast: Toast = { id, message, type, duration };
    this.toasts.push(toast);

    if (duration > 0) {
      setTimeout(() => {
        this.remove(id);
      }, duration);
    }
  }

  remove(id: string) {
    const index = this.toasts.findIndex((t) => t.id === id);
    if (index !== -1) {
      this.toasts.splice(index, 1);
    }
  }
}

export const toastState = new ToastManager();
