//go:build !linux && !windows && !darwin

package reboot

import (
	"errors"
	"time"
)

func markerPresent() bool { return false }

func capable() bool { return false }

func reboot(time.Duration, string) error {
	return errors.New("reboots are not supported on this platform")
}
