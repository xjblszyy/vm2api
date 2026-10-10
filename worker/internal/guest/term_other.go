//go:build !linux

package guest

import (
	"errors"
	"os"
)

func TermSize(*os.File) (uint16, uint16, bool) { return 0, 0, false }

func MakeRaw(*os.File) (func(), error) { return nil, errors.New("raw terminal is linux-only") }

func NotifyResize(chan<- os.Signal) {}
