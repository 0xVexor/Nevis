package api

import (
	"errors"
	"io"
	"net/http"
	"time"
)

// The server sets no read or write timeout of its own: a long poll is held open on purpose and an upload may be
// slow. Instead a handler sets the deadline for just that request, so that a client that stalls cannot hold a
// connection (and a copy of the body) forever.
//
// A blob transfer is judged by progress, not by its size: every chunk that moves pushes the deadline out by the idle
// window, so a slow but steady link (a few KB/s) finishes however large the blob, while a connection that goes quiet
// for a whole window is cut. An absolute ceiling bounds the whole transfer, so that a client that trickles a byte at
// a time still cannot hold the connection forever.

// Timeouts are the allowances behind those deadlines; a zero field takes its default.
type Timeouts struct {
	TransferBase time.Duration // idle window: how long a blob transfer may go without moving a byte
	TransferMax  time.Duration // ceiling on the whole of one blob transfer, however steady it is
	PollSlack    time.Duration // what a long poll gets on top of the wait it asked for
}

func (t Timeouts) withDefaults() Timeouts {
	if t.TransferBase <= 0 {
		t.TransferBase = 60 * time.Second
	}
	if t.TransferMax <= 0 {
		// 64 MB (the default blob limit) at 6 KB/s fits; a steady 20 KB/s link has room for ~200 MB
		t.TransferMax = 3 * time.Hour
	}
	if t.PollSlack <= 0 {
		t.PollSlack = 30 * time.Second
	}
	return t
}

// progress extends one direction of a connection's deadline each time bytes move, never past the ceiling.
type progress struct {
	idle    time.Duration
	ceiling time.Time
	set     func(time.Time) error
	onErr   func(error)
}

func (p *progress) extend() {
	d := time.Now().Add(p.idle)
	if d.After(p.ceiling) {
		d = p.ceiling
	}
	if err := p.set(d); err != nil {
		p.onErr(err)
	}
}

type progressReader struct {
	io.ReadCloser
	p *progress
}

func (r *progressReader) Read(b []byte) (int, error) {
	n, err := r.ReadCloser.Read(b)
	if n > 0 {
		r.p.extend()
	}
	return n, err
}

type progressWriter struct {
	http.ResponseWriter
	p *progress
}

func (w *progressWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	if n > 0 {
		w.p.extend()
	}
	return n, err
}

// Unwrap lets http.ResponseController reach the real writer (Flush, deadlines).
func (w *progressWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// readIdle starts the idle window for the request body and returns a body that extends it as bytes arrive.
func (s *Server) readIdle(w http.ResponseWriter, r *http.Request) io.ReadCloser {
	rc := http.NewResponseController(w)
	p := s.newProgress(rc.SetReadDeadline)
	p.extend()
	return &progressReader{ReadCloser: r.Body, p: p}
}

// writeIdle starts the idle window for the response and returns a writer that extends it as bytes are sent.
func (s *Server) writeIdle(w http.ResponseWriter) http.ResponseWriter {
	rc := http.NewResponseController(w)
	p := s.newProgress(rc.SetWriteDeadline)
	p.extend()
	return &progressWriter{ResponseWriter: w, p: p}
}

func (s *Server) newProgress(set func(time.Time) error) *progress {
	return &progress{idle: s.Timeouts.TransferBase, ceiling: time.Now().Add(max(s.Timeouts.TransferMax, s.Timeouts.TransferBase)),
		set: set, onErr: s.setDeadline}
}

// limitWrite sets a fixed deadline for this request's connection (the long poll). A writer that cannot do it (a
// test recorder) is tolerated: the deadline is an extra protection, not a precondition.
func (s *Server) limitWrite(w http.ResponseWriter, d time.Duration) {
	s.setDeadline(http.NewResponseController(w).SetWriteDeadline(time.Now().Add(d)))
}

func (s *Server) setDeadline(err error) {
	if err != nil && !errors.Is(err, http.ErrNotSupported) {
		s.Log.Warn("could not set a deadline", "err", err.Error())
	}
}
