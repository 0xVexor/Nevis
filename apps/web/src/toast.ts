// The app's toast, as the old app had it: any screen can show one (with an Undo that Ctrl+Z also runs); the shell draws it.
export const APP_TOAST = 'app-toast'
export const showToast = (msg: string, undo?: () => void) => window.dispatchEvent(new CustomEvent(APP_TOAST, { detail: { msg, undo } }))
