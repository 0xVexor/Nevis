package api

import (
	"errors"
	"net/http"
	"time"
)

// The server sets no read or write timeout of its own: a long poll is held open on purpose and an upload may be
// slow. Instead a handler that knows how long its transfer may take sets the deadline for just that request, so
// that a client that stalls cannot hold a connection (and a copy of the body) forever.

// Timeouts are the allowances behind those deadlines; a zero field takes its default.
type Timeouts struct {
	TransferBase time.Duration // fixed part of the time for moving a blob
	TransferRate int64         // bytes per second a transfer is expected to manage
	TransferMax  time.Duration // longest a single transfer may take
	PollSlack    time.Duration // what a long poll gets on top of the wait it asked for
}

func (t Timeouts) withDefaults() Timeouts {
	if t.TransferBase <= 0 {
		t.TransferBase = 30 * time.Second
	}
	if t.TransferRate <= 0 {
		t.TransferRate = 256 << 10
	}
	if t.TransferMax <= 0 {
		t.TransferMax = 10 * time.Minute
	}
	if t.PollSlack <= 0 {
		t.PollSlack = 30 * time.Second
	}
	return t
}

// transfer is the time allowed for moving size bytes.
func (t Timeouts) transfer(size int64) time.Duration {
	size = max(size, 0)
	d := t.TransferBase + time.Duration(size/t.TransferRate)*time.Second
	if size%t.TransferRate != 0 {
		d += time.Second
	}
	return min(d, max(t.TransferMax, t.TransferBase))
}

// limitRead and limitWrite set the deadline of this request's connection. A writer that cannot do it (a test
// recorder) is tolerated: the deadline is an extra protection, not a precondition.
func (s *Server) limitRead(w http.ResponseWriter, d time.Duration) {
	s.setDeadline(http.NewResponseController(w).SetReadDeadline(time.Now().Add(d)))
}

func (s *Server) limitWrite(w http.ResponseWriter, d time.Duration) {
	s.setDeadline(http.NewResponseController(w).SetWriteDeadline(time.Now().Add(d)))
}

func (s *Server) setDeadline(err error) {
	if err != nil && !errors.Is(err, http.ErrNotSupported) {
		s.Log.Warn("could not set a deadline", "err", err.Error())
	}
}
