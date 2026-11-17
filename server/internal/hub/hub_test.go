package hub

import (
	"context"
	"sync"
	"testing"
	"time"
)

func waitReturns(w *Waiter, ctx context.Context, d time.Duration) <-chan time.Duration {
	out := make(chan time.Duration, 1)
	go func() {
		start := time.Now()
		w.Wait(ctx, d)
		out <- time.Since(start)
	}()
	return out
}

func TestNotifyWakesEveryWaiterOfTheVaultOnly(t *testing.T) {
	h := New()
	a, b, other := h.Subscribe("v1"), h.Subscribe("v1"), h.Subscribe("v2")
	defer a.Close()
	defer b.Close()
	defer other.Close()
	ra, rb := waitReturns(a, context.Background(), 5*time.Second), waitReturns(b, context.Background(), 5*time.Second)
	ro := waitReturns(other, context.Background(), 200*time.Millisecond)
	if h.Size() != 3 {
		t.Fatalf("size %d", h.Size())
	}
	h.Notify("v1")
	for _, r := range []<-chan time.Duration{ra, rb} {
		if d := <-r; d > time.Second {
			t.Fatalf("a waiter was not woken (%v)", d)
		}
	}
	if d := <-ro; d < 150*time.Millisecond {
		t.Fatalf("a waiter of another vault was woken after %v", d)
	}
}

func TestNotifyBeforeWaitIsNotLost(t *testing.T) {
	h := New()
	w := h.Subscribe("v")
	defer w.Close()
	h.Notify("v") // between subscribing and waiting
	if d := <-waitReturns(w, context.Background(), 5*time.Second); d > time.Second {
		t.Fatalf("the notification was missed (%v)", d)
	}
}

func TestWaitEndsWithTimeoutAndContext(t *testing.T) {
	h := New()
	w := h.Subscribe("v")
	defer w.Close()
	if d := <-waitReturns(w, context.Background(), 50*time.Millisecond); d < 40*time.Millisecond {
		t.Fatalf("returned after %v", d)
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := waitReturns(w, ctx, 5*time.Second)
	cancel()
	if d := <-r; d > time.Second {
		t.Fatalf("a cancelled request kept waiting (%v)", d)
	}
}

func TestCloseUnregisters(t *testing.T) {
	h := New()
	h.Subscribe("v").Close()
	if h.Size() != 0 {
		t.Fatal("waiter still registered")
	}
}

func TestReleaseAllLetsGoAndRefusesNewWaiters(t *testing.T) {
	h := New()
	var wg sync.WaitGroup
	for range 3 {
		w := h.Subscribe("v")
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer w.Close()
			w.Wait(context.Background(), 10*time.Second)
		}()
	}
	h.ReleaseAll()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("waiters were not released")
	}
	late := h.Subscribe("v") // shutting down: it must not be kept waiting
	defer late.Close()
	if d := <-waitReturns(late, context.Background(), 5*time.Second); d > time.Second {
		t.Fatalf("a late waiter waited %v", d)
	}
}
