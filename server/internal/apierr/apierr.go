// Package apierr is the one error type that crosses from the domain packages to the HTTP layer:
// a status, a short machine readable code and optional extra fields, answered as `{"error": "<code>", ...}`.
package apierr

import "fmt"

// Error is an answer the client is meant to see.
type Error struct {
	Status int
	Code   string
	Extra  map[string]any
}

func (e *Error) Error() string { return fmt.Sprintf("%d %s", e.Status, e.Code) }

// New builds an Error without extra fields.
func New(status int, code string) *Error { return &Error{Status: status, Code: code} }

// With builds an Error that carries extra fields next to the code.
func With(status int, code string, extra map[string]any) *Error {
	return &Error{Status: status, Code: code, Extra: extra}
}

// RateLimited is a 429; the HTTP layer turns `retry` into a Retry-After header.
func RateLimited(retrySeconds int) *Error {
	return With(429, "rate_limited", map[string]any{"retry": retrySeconds})
}

// Body is what goes on the wire.
func (e *Error) Body() map[string]any {
	out := map[string]any{"error": e.Code}
	for k, v := range e.Extra {
		out[k] = v
	}
	return out
}
