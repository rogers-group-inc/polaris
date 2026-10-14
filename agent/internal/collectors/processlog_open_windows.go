//go:build windows

package collectors

import (
	"errors"
	"fmt"
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

// openLogNoFollow opens a tailed log file with FILE_FLAG_OPEN_REPARSE_POINT so
// a symlink / junction / other reparse point swapped in after the Lstat is
// opened AS the reparse point (not its target), then refuses the handle when
// its attributes carry FILE_ATTRIBUTE_REPARSE_POINT or it is a directory, and
// fstats it to require a regular file. Returns the file, its size, its
// identity ("volume:index") and its hard-link count — business rule 119
// (re-scan F68).
func openLogNoFollow(path string) (*os.File, int64, string, uint64, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, 0, "", 0, err
	}
	h, err := windows.CreateFile(p,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_ATTRIBUTE_NORMAL,
		0)
	if err != nil {
		return nil, 0, "", 0, err
	}
	var fi windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &fi); err != nil {
		windows.CloseHandle(h)
		return nil, 0, "", 0, err
	}
	if fi.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		windows.CloseHandle(h)
		return nil, 0, "", 0, errors.New("reparse point")
	}
	if fi.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		windows.CloseHandle(h)
		return nil, 0, "", 0, errors.New("not a regular file")
	}
	f := os.NewFile(uintptr(h), path)
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, "", 0, err
	}
	if !info.Mode().IsRegular() {
		f.Close()
		return nil, 0, "", 0, errors.New("not a regular file")
	}
	id := fmt.Sprintf("%x:%x%08x", fi.VolumeSerialNumber, fi.FileIndexHigh, fi.FileIndexLow)
	return f, info.Size(), id, uint64(fi.NumberOfLinks), nil
}

// isLinkInfo reports whether an Lstat result is a symlink, junction or any
// other reparse point. Go reports mount points (junctions) without
// ModeSymlink, so the raw attribute is checked as well.
func isLinkInfo(info os.FileInfo) bool {
	if info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
		return true
	}
	if d, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		return d.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
	}
	return false
}
