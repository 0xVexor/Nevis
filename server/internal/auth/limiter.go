package auth

import (
	"sync"
	"time"
)

// Limiter is a fixed window rate limiter, kept in memory (a restart forgets it, which is fine for abuse control).
type Limiter struct {
	now func() time.Time
	mu  sync.Mutex
	m   map[string]*window
}

type window struct {
	n     int
	reset time.Time
}

// NewLimiter takes the clock to use, so that tests do not have to wait.
func NewLimiter(now func() time.Time) *Limiter {
	return &Limiter{now: now, m: map[string]*window{}}
}

// Hit counts one hit. ok is false once max is exceeded within the window; retry is the seconds until it resets.
func (l *Limiter) Hit(key string, max int, d time.Duration) (ok bool, retry int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.now()
	w := l.m[key]
	if w == nil || !w.reset.After(t) {
		w = &window{reset: t.Add(d)}
		l.m[key] = w
	}
	w.n++
	return w.n <= max, secondsUntil(w.reset, t)
}

// Blocked reports how many seconds a key stays blocked (0 when it is not) without counting a new hit.
func (l *Limiter) Blocked(key string, max int) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.now()
	if w := l.m[key]; w != nil && w.reset.After(t) && w.n >= max {
		return secondsUntil(w.reset, t)
	}
	return 0
}

// Clear forgets a key (after a successful login).
func (l *Limiter) Clear(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.m, key)
}

// Sweep drops expired windows so that the map does not grow forever.
func (l *Limiter) Sweep() {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.now()
	for k, w := range l.m {
		if !w.reset.After(t) {
			delete(l.m, k)
		}
	}
}

func secondsUntil(reset, now time.Time) int {
	return max(1, int((reset.Sub(now)+time.Second-1)/time.Second))
}
