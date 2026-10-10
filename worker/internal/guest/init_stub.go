//go:build !linux

package guest

import "errors"

func RunInit() error { return errors.New("kin-guest init is linux-only") }
