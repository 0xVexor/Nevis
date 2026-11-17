// Package hub is the instant change notification. A device holds one request open (a "long poll"): the server
// answers it the moment another device commits, or after a while with "nothing new". This works through every
// proxy and flaky network a plain HTTPS request works through, which a WebSocket does not always do.
package hub

import (
	"context"
	"sync"
	"time"
)

// Hub tells waiting requests that a vault changed.
type Hub struct {
	mu      sync.Mutex
	waiters map[string]map[*Waiter]struct{}
	closed  bool
}

// New returns an empty hub.
func New() *Hub { return &Hub{waiters: map[string]map[*Waiter]struct{}{}} }

// Waiter is one request waiting on one vault.
type Waiter struct {
	hub     *Hub
	vault   string
	changed chan struct{}
}

// Subscribe registers interest in a vault. Subscribe first, then look at the vault's state: the other way round,
// a commit between the look and the subscription would be missed until the timeout. Call Close when done.
func (h *Hub) Subscribe(vault string) *Waiter {
	w := &Waiter{hub: h, vault: vault, changed: make(chan struct{})}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		close(w.changed) // shutting down: nobody is kept waiting
		return w
	}
	if h.waiters[vault] == nil {
		h.waiters[vault] = map[*Waiter]struct{}{}
	}
	h.waiters[vault][w] = struct{}{}
	return w
}

// Wait returns when the vault changes, after d, or when ctx ends (the client went away or the server stops).
func (w *Waiter) Wait(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-w.changed:
	case <-t.C:
	case <-ctx.Done():
	}
}

// Close unregisters the waiter.
func (w *Waiter) Close() {
	w.hub.mu.Lock()
	defer w.hub.mu.Unlock()
	if set := w.hub.waiters[w.vault]; set != nil {
		delete(set, w)
		if len(set) == 0 {
			delete(w.hub.waiters, w.vault)
		}
	}
}

// Notify wakes everyone waiting on the vault.
func (h *Hub) Notify(vault string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for w := range h.waiters[vault] {
		close(w.changed)
	}
	delete(h.waiters, vault)
}

// ReleaseAll lets every waiting request go and keeps new ones from waiting (server shutdown).
func (h *Hub) ReleaseAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for vault, set := range h.waiters {
		for w := range set {
			close(w.changed)
		}
		delete(h.waiters, vault)
	}
}

// Size is the number of requests waiting.
func (h *Hub) Size() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, set := range h.waiters {
		n += len(set)
	}
	return n
}
