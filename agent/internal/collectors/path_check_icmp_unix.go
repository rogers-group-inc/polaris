//go:build linux || darwin

package collectors

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"time"

	"golang.org/x/sys/unix"
)

// platformICMPEcho sends one echo request over a DATAGRAM ICMP socket — no
// raw socket, no capability. On Linux the kernel rewrites the echo id to the
// socket's port, so replies are matched on sequence + a random payload nonce.
func platformICMPEcho(ctx context.Context, dst net.IP, timeout time.Duration) (time.Duration, error) {
	fd, err := newICMPDgramSocket()
	if err != nil {
		return 0, err
	}
	defer unix.Close(fd)

	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	seq := uint16(nonce[0])<<8 | uint16(nonce[1])
	pkt := buildEchoRequest(uint16(unix.Getpid()&0xffff), seq, nonce)
	sa := &unix.SockaddrInet4{}
	copy(sa.Addr[:], dst.To4())

	deadline := time.Now().Add(timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	start := time.Now()
	if err := unix.Sendto(fd, pkt, 0, sa); err != nil {
		return 0, fmt.Errorf("send echo: %w", err)
	}
	buf := make([]byte, 1500)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return 0, ErrICMPTimeout
		}
		fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
		n, err := unix.Poll(fds, int(remaining.Milliseconds())+1)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return 0, fmt.Errorf("poll: %w", err)
		}
		if n == 0 {
			return 0, ErrICMPTimeout
		}
		m, _, err := unix.Recvfrom(fd, buf, 0)
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return 0, fmt.Errorf("receive: %w", err)
		}
		typ, _, _, rseq, payload, ok := parseEchoReply(buf[:m])
		if !ok || typ != icmpTypeEchoReply || rseq != seq || len(payload) < len(nonce) || !bytes.Equal(payload[:len(nonce)], nonce) {
			continue // someone else's reply on a shared (darwin) socket
		}
		return time.Since(start), nil
	}
}
