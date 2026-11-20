package api

import (
	"crypto/subtle"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/nevis-app/nevis/server/internal/auth"
	"github.com/nevis-app/nevis/server/internal/store"
)

const cookieName = "nevis_session"

func itoa(n int) string { return strconv.Itoa(n) }

// middleware runs on every request: the protocol version gate (426), and for anything that changes state a CSRF guard. The
// guard needs no token: a custom header (`Nevis-Proto`) cannot be sent cross-origin without a preflight the server never answers
// (there is no CORS), and an `Origin` that is not this host is refused.
func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		api := strings.HasPrefix(r.URL.Path, "/v1/")
		if api {
			h.Set("Cache-Control", "no-store")
			h.Set("Nevis-Proto", itoa(Proto))
			if v := r.Header.Get("Nevis-Proto"); v != "" {
				if n, err := strconv.Atoi(v); err != nil || n < MinProto {
					fail(w, 426, "upgrade_required", "this client is too old for the server", false, map[string]any{"minProto": MinProto})
					return
				}
			}
			if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
				if r.Header.Get("Nevis-Proto") == "" {
					fail(w, 403, "csrf", "missing Nevis-Proto header", false)
					return
				}
				if o := r.Header.Get("Origin"); o != "" {
					u, err := url.Parse(o)
					if err != nil || !strings.EqualFold(u.Host, r.Host) {
						fail(w, 403, "csrf", "cross-origin request", false)
						return
					}
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

type authedFunc func(w http.ResponseWriter, r *http.Request, p *store.Principal)

// authed finds who the request is: the session cookie (web), a bearer device token, or the development token.
func (s *Server) authed(next authedFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := ""
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			tok = strings.TrimPrefix(h, "Bearer ")
		} else if c, err := r.Cookie(cookieName); err == nil {
			tok = c.Value
		}
		if tok == "" {
			fail(w, 401, "unauthorized", "sign in first", false)
			return
		}
		if s.DevMode && s.DevToken != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(s.DevToken)) == 1 {
			next(w, r, &store.Principal{Username: "dev", Dev: true})
			return
		}
		p, err := s.st.Authenticate(r.Context(), auth.SHA256Hex(tok))
		if err != nil {
			fail(w, 401, "unauthorized", "the session is not valid (signed out or the device was removed)", false)
			return
		}
		next(w, r, p)
	}
}

func (s *Server) setCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: token, Path: "/", HttpOnly: true, Secure: !s.InsecureCookies, SameSite: http.SameSiteStrictMode, MaxAge: int(store.SessionTTL.Seconds())})
}

func (s *Server) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", HttpOnly: true, Secure: !s.InsecureCookies, SameSite: http.SameSiteStrictMode, MaxAge: -1})
}

func clientIP(r *http.Request) string {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}
