/**
 * Clipboard helper with UI toast feedback.
 */
import { toastState } from "./state/toast.svelte";

/** Copies text to the clipboard and shows a toast. */
export function copyToClipboard(text: string) {
  if(!navigator.clipboard){
    toastState.add("Clipboard is not available. This is a security measure", "warning")
  }
  else
    navigator.clipboard.writeText(text).then(()=> {
      toastState.add("Copied to clipboard", "success");
    }).catch(()=> {
      toastState.add("Attempt to copy failed", "error")
    });
}
