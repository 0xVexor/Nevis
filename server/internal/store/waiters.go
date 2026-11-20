package store

import "sync"

// waiters wakes the long-polling pullers of a workspace after a commit. A puller subscribes BEFORE it reads, so a commit that
// lands in between is never missed.
type waiters struct {
	mu sync.Mutex
	m  map[string]map[chan struct{}]struct{}
}

// Subscribe returns a channel that is signalled after the next commit to `ws`, and a function to unsubscribe.
func (w *waiters) Subscribe(ws string) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	w.mu.Lock()
	if w.m[ws] == nil {
		w.m[ws] = map[chan struct{}]struct{}{}
	}
	w.m[ws][ch] = struct{}{}
	w.mu.Unlock()
	return ch, func() {
		w.mu.Lock()
		delete(w.m[ws], ch)
		if len(w.m[ws]) == 0 {
			delete(w.m, ws)
		}
		w.mu.Unlock()
	}
}

func (w *waiters) notify(ws string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for ch := range w.m[ws] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
