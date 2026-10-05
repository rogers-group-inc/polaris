//go:build linux

package collectors

import (
	"context"
	"log"
	"os/exec"
	"time"
)

// softwareInventoryOnce lists installed packages from dpkg when the host has
// it, else rpm. Each is one read-only query of the package database with a
// hard timeout. A host with both (rpm installed on a Debian box) answers from
// dpkg; rpm is asked only when dpkg is absent or returned nothing.
//
// Returns nil when neither tool is present or the query failed, so a broken
// read never reaches the server as "every package was removed".
func softwareInventoryOnce() []softwareRaw {
	if _, err := exec.LookPath("dpkg-query"); err == nil {
		if out, ok := runPackageQuery("dpkg-query", "-W", "-f="+dpkgQueryFormat); ok {
			if rows := parseDpkgQuery(out); len(rows) > 0 {
				return rows
			}
		}
	}
	if _, err := exec.LookPath("rpm"); err == nil {
		if out, ok := runPackageQuery("rpm", "-qa", "--queryformat", rpmQueryFormat); ok {
			if rows := parseRpmQuery(out); len(rows) > 0 {
				return rows
			}
		}
	}
	return nil
}

func runPackageQuery(name string, args ...string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		log.Printf("softwareInventory: %s failed: %v", name, err)
		return "", false
	}
	return string(out), true
}
