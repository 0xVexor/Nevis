package api

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// clientIP is the address rate limits are counted against. X-Forwarded-For is only believed when the connection
// comes from a trusted proxy: otherwise anyone could pick their own address and sidestep the limits. Behind a
// proxy the header is read from the right, skipping the trusted hops, because the proxy appends the address it
// saw to whatever the client sent; the entries further left are the client's claims.
func (s *Server) clientIP(r *http.Request) string {
	peer := peerAddr(r)
	if !peer.IsValid() || !s.trusted(peer) {
		return peer.String()
	}
	hops := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break // garbage in the header: fall back to the proxy's own address rather than guess
		}
		if a = a.Unmap(); !s.trusted(a) {
			return a.String()
		}
	}
	return peer.String()
}

func peerAddr(r *http.Request) netip.Addr {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return a.Unmap()
}

func (s *Server) trusted(a netip.Addr) bool {
	for _, p := range s.Cfg.TrustProxy {
		if p.Contains(a) {
			return true
		}
	}
	return false
}
