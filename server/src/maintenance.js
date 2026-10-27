// Snapshot publication and garbage collection share a queue so an object cannot
// disappear between taking an index copy and publishing its reference manifest.
const queues = new WeakMap()
export function maintenance(db, work) {
  const previous = queues.get(db) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(work)
  queues.set(db, task)
  return task.finally(() => { if (queues.get(db) === task) queues.delete(db) })
}
