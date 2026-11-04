// WebSocket client for the agent → Polaris pull side. Held open by the
// main loop; server pushes `probe-now-request` and `refresh-config` frames
// down it, agent answers `probe-now-response` and treats refresh-config
// as a signal to call FetchConfig immediately.
//
// Auth: bearer rides in `Sec-WebSocket-Protocol` as
// `polaris-agent.v1.bearer.<token>`. Keeps the token out of URL query
// strings (which would land in access logs). The server reads the
// subprotocol for auth and doesn't echo it back; our client accepts the
// no-protocol response by default.
//
// Reconnect: exponential backoff with a cap. We never give up — the
// agent's job is to be there when Polaris asks, and the operator's WAN
// link IS allowed to flap.

package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/polaris/agent/internal/pinned"
)

const (
	wsPath               = "/api/v1/agents/ws"
	wsHandshakeTimeout   = 10 * time.Second
	wsReadDeadlineWindow = 90 * time.Second // server pings every 30s; 3× buys 60s of jitter slack
	wsBackoffMinSec      = 1
	wsBackoffMaxSec      = 60
)

// Frame is the small JSON envelope every WS payload uses.
type Frame struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// FrameHandler is the agent-side dispatcher for server-pushed frames.
// One handler covers every type; switch on Frame.Type inside.
type FrameHandler func(ctx context.Context, conn *WSConn, f *Frame) error

// WSConn wraps one live WebSocket connection. The main loop creates one,
// runs the read pump, and discards it on disconnect. NewWSDialer returns
// a fresh WSConn each time dial succeeds.
type WSConn struct {
	conn *websocket.Conn
	// send is the only writer path; the read pump pushes responses back
	// through this channel rather than writing to conn directly, so we
	// never have concurrent writes on the same socket (which gorilla's
	// API forbids).
	send chan *Frame
}

// SendFrame queues a frame to be written. Drops if the buffer is full —
// in practice that means we've fallen so far behind that disconnecting
// is the right move.
func (c *WSConn) SendFrame(f *Frame) error {
	select {
	case c.send <- f:
		return nil
	case <-time.After(100 * time.Millisecond):
		return errors.New("ws send buffer full — server is likely gone")
	}
}

// WSDialer holds the per-process state needed to (re)establish a WS
// connection: the URL, the bearer, and the pinned TLS config.
type WSDialer struct {
	wssURL string
	bearer string
	dialer *websocket.Dialer
}

// NewWSDialer builds a dialer with TLS pinned to ANY fingerprint in certPins.
// Phase 2 dual-pin: pass cfg.Pins() so a staged-rotation pin set lets the
// websocket survive a server cert rotation in lockstep with the HTTP client.
func NewWSDialer(baseURL string, certPins []string, bearer string) (*WSDialer, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + wsPath)
	if err != nil {
		return nil, fmt.Errorf("parse base url: %w", err)
	}
	// Flip scheme http→ws / https→wss so gorilla recognizes it as a WS URL.
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	default:
		return nil, fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	return &WSDialer{
		wssURL: u.String(),
		bearer: bearer,
		dialer: &websocket.Dialer{
			HandshakeTimeout: wsHandshakeTimeout,
			TLSClientConfig:  pinned.TLSConfig(certPins),
			Subprotocols:     []string{"polaris-agent.v1.bearer." + bearer},
		},
	}, nil
}

// dial opens a fresh WS connection. On success the caller MUST call
// Run() (which returns when the connection ends).
func (d *WSDialer) dial(ctx context.Context) (*WSConn, error) {
	header := http.Header{}
	// gorilla picks up Subprotocols from the Dialer; we don't have to
	// stamp Sec-WebSocket-Protocol manually.
	conn, _, err := d.dialer.DialContext(ctx, d.wssURL, header)
	if err != nil {
		return nil, err
	}
	c := &WSConn{conn: conn, send: make(chan *Frame, 32)}
	// Read deadline keeps us from blocking forever on a dead peer; the
	// pong handler bumps it on every server ping.
	_ = conn.SetReadDeadline(time.Now().Add(wsReadDeadlineWindow))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(wsReadDeadlineWindow))
		return nil
	})
	conn.SetPingHandler(func(appData string) error {
		// Reply with the same payload; bump our read deadline.
		_ = conn.SetReadDeadline(time.Now().Add(wsReadDeadlineWindow))
		return conn.WriteControl(websocket.PongMessage, []byte(appData),
			time.Now().Add(5*time.Second))
	})
	return c, nil
}

// Run pumps frames in both directions until the connection closes or
// the context is canceled. handler is called for every inbound frame.
// Returns the error that ended the session (nil on graceful close).
func (c *WSConn) Run(ctx context.Context, handler FrameHandler) error {
	defer c.conn.Close()

	// Writer goroutine — serializes all sends through the `send` channel
	// since gorilla's NextWriter/WriteMessage must not be called
	// concurrently.
	writerErrCh := make(chan error, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				writerErrCh <- nil
				return
			case f := <-c.send:
				if f == nil {
					writerErrCh <- nil
					return
				}
				buf, err := json.Marshal(f)
				if err != nil {
					writerErrCh <- err
					return
				}
				_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := c.conn.WriteMessage(websocket.TextMessage, buf); err != nil {
					writerErrCh <- err
					return
				}
			}
		}
	}()

	// Reader loop runs on this goroutine.
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		mt, data, err := c.conn.ReadMessage()
		if err != nil {
			return err
		}
		if mt != websocket.TextMessage {
			continue
		}
		var f Frame
		if err := json.Unmarshal(data, &f); err != nil {
			log.Printf("ws: skipping unparseable frame: %v", err)
			continue
		}
		if err := handler(ctx, c, &f); err != nil {
			log.Printf("ws: frame handler error: %v", err)
		}
	}
}

// RunWithReconnect runs dial + Run in a loop, sleeping with exponential
// backoff between attempts. Returns only when ctx is done.
func (d *WSDialer) RunWithReconnect(ctx context.Context, handler FrameHandler) {
	attempt := 0
	for {
		if ctx.Err() != nil {
			return
		}
		conn, err := d.dial(ctx)
		if err != nil {
			attempt++
			sleep := backoffFor(attempt)
			log.Printf("ws: dial failed (attempt %d): %v — retrying in %s", attempt, err, sleep)
			select {
			case <-time.After(sleep):
				continue
			case <-ctx.Done():
				return
			}
		}
		attempt = 0
		log.Println("ws: connected")
		err = conn.Run(ctx, handler)
		if err != nil && ctx.Err() == nil {
			log.Printf("ws: session ended: %v", err)
		}
	}
}

func backoffFor(attempt int) time.Duration {
	// Cap at ~60s; full jitter to avoid thundering herd if Polaris bounces.
	max := math.Min(math.Pow(2, float64(attempt)), float64(wsBackoffMaxSec))
	if max < wsBackoffMinSec {
		max = wsBackoffMinSec
	}
	sec := rand.Float64() * max
	if sec < 0.5 {
		sec = 0.5
	}
	return time.Duration(sec * float64(time.Second))
}
