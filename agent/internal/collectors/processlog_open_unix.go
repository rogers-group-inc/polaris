//go:build unix

package collectors

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// openLogNoFollow opens a tailed log file without following a link in its
// final component (O_NOFOLLOW: a symlink swapped in after the Lstat makes the
// open fail with ELOOP), then fstats the HANDLE and requires a regular file.
// O_NONBLOCK keeps a FIFO raced into the path from parking the collector.
// Returns the file, its size, its identity ("dev:ino") and its hard-link
// count — business rule 119 (re-scan F68).
func openLogNoFollow(path string) (*os.File, int64, string, uint64, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, 0, "", 0, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, "", 0, err
	}
	if !info.Mode().IsRegular() {
		f.Close()
		return nil, 0, "", 0, errors.New("not a regular file")
	}
	id := ""
	var nlink uint64 = 1
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		id = fmt.Sprintf("%d:%d", st.Dev, st.Ino)
		nlink = uint64(st.Nlink)
	}
	return f, info.Size(), id, nlink, nil
}

// isLinkInfo reports whether an Lstat result is a symbolic link.
func isLinkInfo(info os.FileInfo) bool {
	return info.Mode()&os.ModeSymlink != 0
}
