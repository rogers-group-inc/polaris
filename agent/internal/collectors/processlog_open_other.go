//go:build !unix && !windows

package collectors

import (
	"errors"
	"os"
)

// openLogNoFollow has no link-refusing open on this platform, so file-glob
// tailing is disabled here rather than falling back to a following open —
// business rule 119 (re-scan F68).
func openLogNoFollow(_ string) (*os.File, int64, string, uint64, error) {
	return nil, 0, "", 0, errors.New("file-glob tailing unsupported on this platform")
}

func isLinkInfo(info os.FileInfo) bool {
	return info.Mode()&os.ModeSymlink != 0
}
