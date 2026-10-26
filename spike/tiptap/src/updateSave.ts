// Editors register their pending saves so installation waits for their debounce and async work.
const savers = new Set<() => void | Promise<unknown>>()
export const registerUpdateSave = (save: () => void | Promise<unknown>) => {
  savers.add(save)
  return () => void savers.delete(save)
}
export const saveBeforeUpdate = async () => {
  for (const save of [...savers]) await save()
}
