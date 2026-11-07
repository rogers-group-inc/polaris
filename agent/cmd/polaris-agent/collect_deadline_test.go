package main

import (
	"testing"
	"time"
)

// CQ-G006: the shared collector deadline.
func TestCollectWithDeadlineReturnsTheResult(t *testing.T) {
	got, ok := collectWithDeadline(time.Second, func() []int { return []int{1, 2} })
	if !ok || len(got) != 2 {
		t.Fatalf("got %v %v, want [1 2] true", got, ok)
	}
}

// A collector that returns nil is not a timeout: software inventory treats nil
// as "no package database" and must still tell it apart from a stall.
func TestCollectWithDeadlineKeepsNil(t *testing.T) {
	got, ok := collectWithDeadline(time.Second, func() []int { return nil })
	if !ok || got != nil {
		t.Fatalf("got %v %v, want nil true", got, ok)
	}
}

func TestCollectWithDeadlineGivesUpOnAStall(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	start := time.Now()
	got, ok := collectWithDeadline(50*time.Millisecond, func() []int {
		<-release
		return []int{1}
	})
	if ok || got != nil {
		t.Fatalf("got %v %v, want nil false", got, ok)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("did not give up at the deadline")
	}
}
